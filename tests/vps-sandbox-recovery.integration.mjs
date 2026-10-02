// Opt-in: allocates a disposable environment on the configured VPS, then deletes it.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

if (process.env.RUN_VPS_RECOVERY_TEST !== '1') throw new Error('Set RUN_VPS_RECOVERY_TEST=1 to use the configured VPS');
const base = process.env.REPO_RUNNER_URL?.replace(/\/$/, '');
const key = process.env.REPO_RUNNER_KEY;
assert.ok(base && key, 'Configured runner required');
const workspaceId = randomUUID(), root = `recovery-test-${randomUUID()}`, identities = new Map();
function identity(sessionKey) {
  if (!identities.has(sessionKey)) identities.set(sessionKey, { id: randomUUID(), owner: createHash('sha256').update(sessionKey).digest('hex'), workspaceId });
  return identities.get(sessionKey);
}
async function rpc(scope, input) {
  const response = await fetch(`${base}/sandbox`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...input, ...scope }), signal: AbortSignal.timeout(40000) });
  const body = await response.json();
  return { ok: response.ok, json: async () => response.ok ? body : { statusMessage: body.error } };
}
const source = readFileSync(new URL('../agent/lib/vps-sandbox.ts', import.meta.url), 'utf8');
const exports = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports, Error, AbortSignal, Buffer, ReadableStream, TextEncoder, TextDecoder, setTimeout,
  require: name => name === 'node:crypto' ? { randomUUID } : { appOrigin: () => 'https://fixture.invalid', internalHeaders: () => ({}) },
  fetch: async (_url, options) => { const { sessionKey, input } = JSON.parse(options.body); return rpc(identity(sessionKey), input); },
});
try {
  const handle = await exports.vpsSandbox.create({ sessionKey: root, existingMetadata: { scope: { userId: randomUUID(), threadId: randomUUID() } } });
  assert.equal((await handle.session.run({ command: 'true' })).exitCode, 0);
  await handle.session.writeTextFile({ path: '/workspace/recovery-proof.txt', content: 'preserved' });
  assert.ok((await rpc(identity(root), { action: 'stop' })).ok);
  assert.equal(await handle.session.readTextFile({ path: '/workspace/recovery-proof.txt' }), 'preserved');
  console.log('PASS: stopped environment reconnects with the same files');
  // Delete and lease expiry share the terminal-state recovery path. Only this
  // fixture is deleted; no existing workspace or user job is touched.
  assert.ok((await rpc(identity(root), { action: 'delete' })).ok);
  const result = await handle.session.run({ command: 'true' });
  assert.equal(result.exitCode, 0);
  assert.notEqual(handle.session.id, root);
  assert.match(result.stdout, /NEW empty environment/);
  assert.equal(await handle.session.readTextFile({ path: '/workspace/recovery-proof.txt' }), null);
  console.log('PASS: ended environment receives a new generation and explicit state-loss notice');
} finally {
  for (const scope of identities.values()) assert.ok((await rpc(scope, { action: 'delete' })).ok, 'Disposable sandbox cleanup failed');
  console.log('Disposable environments removed');
}
