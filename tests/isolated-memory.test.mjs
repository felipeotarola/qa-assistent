import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { MemoryDocumentConflictError } from 'eve/memory/file';
import { isolatedMemory } from '../agent/lib/isolated-memory.ts';

test('isolated memory persists across processes and conditionally commits one concurrent writer', async () => {
  const keys = ['SYNA_ISOLATED_MEMORY_ROOT', 'PAT_RUNTIME_SCOPE', 'DATABASE_URL', 'VERCEL'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const base = resolve('.data/autonomy-isolation'), root = resolve(base, `memory-unit-${randomUUID()}`);
  Object.assign(process.env, { SYNA_ISOLATED_MEMORY_ROOT: root, PAT_RUNTIME_SCOPE: 'autonomy-test:memory', DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:5432/syna_test_autonomy_memory', VERCEL: '' });
  const signal = new AbortController().signal;
  try {
    const a = isolatedMemory(), b = isolatedMemory();
    assert.equal(await a.read({ key: 'user-a', signal }), null);
    const first = await a.write({ key: 'user-a', content: 'Actual persisted memory', expectedVersion: null, signal });
    assert.deepEqual(await b.read({ key: 'user-a', signal }), first);
    assert.equal(await b.read({ key: 'user-b', signal }), null);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {isolatedMemory} from './agent/lib/isolated-memory.ts'; console.log(JSON.stringify(await isolatedMemory().read({key:'user-a',signal:new AbortController().signal})));`], { encoding: 'utf8', env: process.env });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), first);
    const attempts = await Promise.allSettled([a, b].map((backend, i) => backend.write({ key: 'user-a', content: `Writer ${i}`, expectedVersion: first.version, signal })));
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.ok(MemoryDocumentConflictError.is(attempts.find(result => result.status === 'rejected').reason));
    const winner = attempts.find(result => result.status === 'fulfilled').value;
    assert.deepEqual(await a.read({ key: 'user-a', signal }), winner);
    await assert.rejects(a.write({ key: 'user-a', content: 'Stale', expectedVersion: first.version, signal }), MemoryDocumentConflictError);
    await assert.rejects(a.write({ key: 'user-a', content: 'x', expectedVersion: '../outside', signal }), MemoryDocumentConflictError);
    const aborted = AbortSignal.abort();
    await assert.rejects(a.read({ key: 'user-a', signal: aborted }));
    for (const changes of [{ DATABASE_URL: 'postgres://x:x@shared.example:5432/syna_test_autonomy_memory' }, { PAT_RUNTIME_SCOPE: 'production' }, { VERCEL: '1' }, { SYNA_ISOLATED_MEMORY_ROOT: resolve('.data/outside') }]) {
      const previous = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
      Object.assign(process.env, changes);
      assert.throws(isolatedMemory, /requires an isolated/);
      Object.assign(process.env, previous);
    }
    delete process.env.SYNA_ISOLATED_MEMORY_ROOT;
    assert.equal(isolatedMemory(), undefined, 'Ordinary runtimes keep their original Blob backend');
  } finally {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const child = relative(base, root);
    assert.ok(child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
    await rm(root, { recursive: true, force: true });
  }
});
