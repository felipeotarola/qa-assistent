import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function fixture(projectId, control = 'agent', providerFails = false) {
  const row = { id: 'assignment', userId: 'user', workspaceId: 'workspace', threadId: 'thread', agentId: 'main', projectId, control, sessionId: 'session', liveUrl: 'https://viewer.example', expiresAt: new Date(Date.now() + 1800000), activeAt: new Date(0) };
  const calls = [];
  const tx = { execute: async () => {}, select: () => ({ from: () => ({ where: async () => [row] }) }), update: () => ({ set: changes => ({ where: async () => Object.assign(row, changes) }) }) };
  const imports = {
    'node:crypto': { randomUUID: () => 'unused' }, '@browserbasehq/sdk': { default: class {} }, 'playwright-core': {},
    'drizzle-orm': { and() {}, eq() {}, isNotNull() {}, lt() {}, sql() {} },
    '@nuxthub/db': { db: { transaction: fn => fn(tx) }, schema: { browserAssignments: {} } },
    './threads': { getThreadForUser: async () => ({ workspaceId: 'workspace' }) }, './workspaces': { requireWorkspace: async () => {} }, './test-captures': {},
    './vps-browser': { vpsBrowserRequest: async (...args) => { calls.push(args); if (providerFails) throw Error('Preview expired'); return { renewed: true }; } },
  };
  const code = ts.transpileModule(fs.readFileSync(new URL('../server/utils/browser.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => { assert.ok(imports[name], name); return imports[name]; }, Date, process, createError: value => Object.assign(new Error(value.statusMessage), value) });
  return { row, calls, heartbeat: () => exports.controlBrowser('user', 'thread', 'heartbeat') };
}

test('watching a preview renews its parent sandbox under agent or human control', async () => {
  for (const control of ['agent', 'human']) {
    const f = fixture('vps-preview:sandbox', control), expiry = f.row.expiresAt;
    const view = await f.heartbeat();
    assert.equal(view.preview, true);
    assert.deepEqual(f.calls, [['/heartbeat', 'POST', 'sandbox']]);
    assert.ok(f.row.activeAt.getTime() > 0);
    assert.equal(f.row.expiresAt, expiry, 'Heartbeat never extends the hard lifetime');
  }
});

test('a closed preview cannot be marked active by a failed heartbeat', async () => {
  const f = fixture('vps-preview:sandbox', 'agent', true);
  await assert.rejects(f.heartbeat(), /Preview expired/);
  assert.equal(f.row.activeAt.getTime(), 0);
});

test('ordinary browser idle policy remains unchanged', async () => {
  for (const control of ['agent', 'human']) {
    const f = fixture('self-hosted-v1', control);
    assert.equal((await f.heartbeat()).preview, false);
    assert.equal(f.calls.length, 0);
    assert.equal(f.row.activeAt.getTime() > 0, control === 'human');
  }
});
