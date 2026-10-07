import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, realpath, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { withArtifactLocks, withArtifactReadLocks, IsolatedArtifactsBusyError } from './helpers/isolated-build-integrity.mjs';

async function temporary(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'syna-read-lock-'));
  t.after(async () => { const suffix = relative(await realpath(tmpdir()), await realpath(root)); assert.ok(suffix.startsWith('syna-read-lock-') && !suffix.includes(sep)); await rm(root, { recursive: true }); });
  return root;
}
test('actual other process serializes verifier, which reads only after owning every lock', async t => {
  const root = await temporary(t), childScript = resolve(root, 'holder.mjs');
  const helper = pathToFileURL(resolve('tests/helpers/isolated-build-integrity.mjs')).href;
  await writeFile(childScript, `import {withArtifactLocks} from ${JSON.stringify(helper)}; import {writeFile} from 'node:fs/promises'; import {resolve} from 'node:path';
await withArtifactLocks(process.argv[2], ['web','eve','dependencies'], async()=>{process.send({ready:true}); await new Promise(done=>process.once('message', done)); await writeFile(resolve(process.argv[2],'state.txt'),'after release');}); process.disconnect();`);
  const child = spawn(process.execPath, [childScript, root], { windowsHide: true, env: { SystemRoot: process.env.SystemRoot }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const ended = once(child, 'exit'); t.after(() => { if (child.exitCode === null) child.kill(); });
  assert.deepEqual((await once(child, 'message'))[0], { ready: true });
  let entered = false;
  const reader = withArtifactReadLocks(root, ['web', 'eve', 'dependencies'], async () => { entered = true; assert.equal((await readdir(root)).filter(name => name.endsWith('.lock')).length, 3); return readFile(resolve(root, 'state.txt'), 'utf8'); }, { waitMs: 2000, pollMs: 5 });
  await new Promise(done => setTimeout(done, 30)); assert.equal(entered, false);
  child.send('release'); assert.equal(await reader, 'after release'); assert.equal((await ended)[0], 0);
  assert.equal((await readdir(root)).filter(name => name.endsWith('.lock')).length, 0);
});
test('read timeout keeps foreign lock byte-for-byte and releases only its own partial locks', async t => {
  const root = await temporary(t); let calls = 0;
  await withArtifactLocks(root, ['web'], async () => {
    const original = await readFile(resolve(root, 'artifact-web.lock'));
    const started = performance.now();
    await assert.rejects(withArtifactReadLocks(root, ['dependencies', 'eve', 'web'], () => { calls++; }, { waitMs: 40, pollMs: 5 }), error => {
      assert.ok(error instanceof IsolatedArtifactsBusyError); assert.equal(error.code, 'ERR_ISOLATED_ARTIFACTS_BUSY'); assert.equal(error.safe, true); assert.equal(error.retryable, true); assert.ok(error.waitedMs >= 35); assert.ok(!error.message.includes(root)); return true;
    });
    assert.ok(performance.now() - started < 1000); assert.equal(calls, 0);
    assert.deepEqual(await readFile(resolve(root, 'artifact-web.lock')), original);
    assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.lock')), ['artifact-web.lock']);
    await assert.rejects(withArtifactLocks(root, ['web'], () => assert.fail('mutator must remain fail-fast')), error => error.code === 'ERR_ISOLATED_ARTIFACTS_BUSY' && error.waitedMs === 0);
  });
});
test('verifier errors are never retried and cancellation never steals a lock', async t => {
  const root = await temporary(t); let calls = 0;
  await assert.rejects(withArtifactReadLocks(root, ['web'], () => { calls++; throw new IsolatedArtifactsBusyError(); }), IsolatedArtifactsBusyError); assert.equal(calls, 1);
  await withArtifactLocks(root, ['web'], async () => {
    const abort = new AbortController(), reader = withArtifactReadLocks(root, ['web'], () => assert.fail('cancelled verifier executed'), { waitMs: 1000, pollMs: 100, signal: abort.signal });
    setTimeout(() => abort.abort(new Error('cancel test')), 10); await assert.rejects(reader, /cancel test/);
    assert.equal((await readdir(root)).filter(name => name.endsWith('.lock')).length, 1);
  });
  for (const waitMs of [-1, 60001, NaN, 1.5]) await assert.rejects(withArtifactReadLocks(root, ['web'], () => {}, { waitMs }), /wait bound/);
});
