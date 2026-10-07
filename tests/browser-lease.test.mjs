import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function fixture(projectId, control = 'agent', providerFails = false) {
  const row = { id: 'assignment', userId: 'user', workspaceId: 'workspace', threadId: 'thread', agentId: 'main', projectId, control, sessionId: 'session', liveUrl: 'https://viewer.example', expiresAt: new Date(Date.now() + 1800000), activeAt: new Date(0) };
  const calls = [];
  const tx = { transaction: fn => fn(tx), execute: async () => {}, select: () => ({ from: () => ({ where: () => Object.assign(Promise.resolve([row]), { for: async () => [row] }) }) }), update: () => ({ set: changes => ({ where: async () => Object.assign(row, changes) }) }) };
  const imports = {
    'node:crypto': { randomUUID: () => 'unused' }, '@browserbasehq/sdk': { default: class {} }, 'playwright-core': {},
    'drizzle-orm': { and() {}, eq() {}, isNotNull() {}, lt() {}, sql() {} },
    '@nuxthub/db': { db: tx, schema: { browserAssignments: {} } },
    './threads': { getThreadForUser: async () => ({ workspaceId: 'workspace' }) }, './workspaces': { requireWorkspace: async () => {} }, './test-captures': {},
    './browser-mission-guard': {}, './browser-action-trace': {}, './browser-trace-privacy': {}, './mission-preview': {},
    './mission-browser-return': { browserActorAssignment: () => assert.fail('A viewer heartbeat must not resolve a new executor assignment') },
    './mission-control': { autonomyEnabled: () => false }, '../../shared/runtime-scope': { runtimeScope: () => 'lease-unit-fixture' },
    // This suite isolates heartbeat semantics; real cross-process lock/rollback
    // behavior is covered by browser-lock.integration.mjs against PostgreSQL.
    './browser-lock': { withBrowserLock: (_key, fn) => fn(), assertBrowserLock: async () => {}, browserLockSignal: () => undefined },
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
