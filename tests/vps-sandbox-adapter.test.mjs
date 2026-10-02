import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { randomUUID } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';

test('a cached or restored handle reconnects before work and renews each operation', async () => {
  const source = readFileSync(new URL('../agent/lib/vps-sandbox.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {}, expired = randomUUID(), calls = [];
  let status = 'ready';
  vm.runInNewContext(js, { exports, Error, AbortSignal, Buffer, ReadableStream, TextEncoder, TextDecoder, setTimeout, require: name => name === 'node:crypto' ? { randomUUID } : { appOrigin: () => 'https://app.example', internalHeaders: () => ({}) }, fetch: async (_url, options) => {
    const { sessionKey, input } = JSON.parse(options.body);
    calls.push({ sessionKey, ...input });
    if (input.action === 'status') return { ok: true, json: async () => ({ id: expired }) };
    if (input.action === 'ensure') {
      if (status === 'expired' && sessionKey === 'root') return { ok: false, json: async () => ({ statusMessage: 'Sandbox lease ended. Files unavailable.' }) };
      status = 'ready';
    } else assert.equal(status, 'ready', 'I/O must never use a stopped sandbox');
    return { ok: true, json: async () => input.action === 'process' ? { status: 'completed', exitCode: 0, stdout: '', stderr: '' } : { data: null } };
  } });
  const options = { sessionKey: 'root', existingMetadata: { scope: { userId: randomUUID(), threadId: randomUUID() } } };
  const handle = await exports.vpsSandbox.create(options);
  assert.equal(calls.length, 0, 'Restoring a handle for status must not allocate compute');
  await handle.useSessionFn();
  status = 'stopped';
  await handle.session.readTextFile({ path: '/workspace/package.json' });
  assert.equal(calls.at(-2).action, 'ensure');
  assert.equal(handle.session.id, 'root', 'Stopped environments reuse their filesystem');
  status = 'expired';
  const result = await handle.session.run({ command: 'true' });
  assert.equal(handle.session.id, `root:${expired}`);
  assert.match(result.stdout, /NEW empty environment/);
  assert.equal(calls.filter(c => c.action === 'spawn').length, 1, 'No command is replayed');
  assert.equal(calls.find(c => c.action === 'spawn').sessionKey, `root:${expired}`);
});

test('Eve production prewarm provisions skill files without allocating a user sandbox', async () => {
  const source = readFileSync(new URL('../agent/lib/vps-sandbox.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {}, calls = [];
  vm.runInNewContext(js, { exports, Error, AbortSignal, Buffer, setTimeout, process: { env: { REPO_RUNNER_URL: 'https://worker.example/repository/', REPO_RUNNER_KEY: 'test-key' } }, require: () => ({}), fetch: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ reused: false }) }; } });
  await exports.vpsSandbox.prewarm({ templateKey: 'eve-template', seedFiles: [{ path: '.agents/skills/test/SKILL.md', content: 'seeded skill' }] });
  assert.equal(calls[0].url, 'https://worker.example/repository/templates');
  assert.equal(Buffer.from(calls[0].body.files[0].data, 'base64').toString(), 'seeded skill');
  await assert.rejects(exports.vpsSandbox.prewarm({ bootstrap: async () => {}, seedFiles: [] }), /command bootstrap/);
  assert.equal(calls.length, 1, 'Unsupported command bootstrap must not be silently ignored');
});

test('parent and child reattach one successor after their shared sandbox expires', async () => {
  const source = readFileSync(new URL('../agent/lib/vps-sandbox.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {}, expired = randomUUID(), created = new Set();
  vm.runInNewContext(js, { exports, Error, AbortSignal, Buffer, setTimeout, require: name => name === 'node:crypto' ? { randomUUID } : { appOrigin: () => 'https://app.example', internalHeaders: () => ({}) }, fetch: async (_url, options) => {
    const { sessionKey, input } = JSON.parse(options.body);
    if (input.action === 'status') return { ok: true, json: async () => ({ id: expired }) };
    if (sessionKey === 'shared-root') return { ok: false, json: async () => ({ statusMessage: 'Sandbox lease ended. Create a new environment.' }) };
    created.add(sessionKey);
    return { ok: true, json: async () => ({ id: sessionKey }) };
  } });
  const options = { sessionKey: 'shared-root', existingMetadata: { scope: { userId: randomUUID(), threadId: randomUUID() } } };
  const [parent, child] = await Promise.all([exports.vpsSandbox.create(options), exports.vpsSandbox.create(options)]);
  await Promise.all([parent.useSessionFn(), child.useSessionFn()]);
  assert.equal(created.size, 1, 'Concurrent attachment must not consume two capacity slots');
  assert.equal(parent.session.id, child.session.id);
  assert.equal((await parent.captureState()).metadata.generation, expired);
});
