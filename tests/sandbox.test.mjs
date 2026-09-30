import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Sandboxes, sandboxPath } from '../infra/repo-runner/sandbox.mjs';
import { ResourceBudget } from '../infra/execution/budget.mjs';

test('paths cannot escape sandbox namespaces', () => {
  for (const path of ['/etc/passwd', '../../root', '/workspace/../etc', '/var/run/docker.sock']) assert.throws(() => sandboxPath(path));
  assert.equal(sandboxPath('repo/test.js'), '/workspace/repo/test.js');
});
test('browser reserve and shared code capacity cannot be overcommitted', () => {
  const budget = new ResourceBudget();
  assert.ok(budget.reserve('repository', 1536)); assert.ok(budget.reserve('sandbox', 1536)); assert.equal(budget.reserve('third', 1536), false);
  budget.release('repository'); assert.ok(budget.reserve('third', 1536));
});
test('sandbox ownership, idempotent creation, resource release and expired files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qa-sandbox-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [], events = [], removed = [];
  const budget = new ResourceBudget();
  const service = new Sandboxes({ directory, budget, events: { publish: async (...args) => events.push(args) }, execute: async args => { calls.push(args); return ''; }, storage: { prepare: async id => `/isolated/${id}`, remove: async id => removed.push(id) } });
  await service.init();
  const identity = { id: randomUUID(), workspaceId: randomUUID(), owner: 'a'.repeat(64) };
  await service.rpc({ ...identity, action: 'ensure' }); await service.rpc({ ...identity, action: 'ensure' });
  assert.equal(calls.filter(c => c[0] === 'run').length, 1); assert.equal(budget.usedMiB, 1536);
  await assert.rejects(service.rpc({ ...identity, owner: 'b'.repeat(64), action: 'status' }), /not found/);
  await service.rpc({ ...identity, action: 'stop' }); assert.equal(budget.usedMiB, 0);
  await service.rpc({ ...identity, action: 'ensure' }); assert.ok(calls.some(c => c[0] === 'start'));
  service.sessions.get(identity.id).expiresAt = 0; await service.tick();
  assert.equal(budget.usedMiB, 0); assert.deepEqual(removed, [identity.id]);
  await assert.rejects(service.rpc({ ...identity, action: 'ensure' }), /lease ended/);
  assert.ok(events.every(event => !event[3].owner));
});
