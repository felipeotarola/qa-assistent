import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { randomUUID } from 'node:crypto';

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
