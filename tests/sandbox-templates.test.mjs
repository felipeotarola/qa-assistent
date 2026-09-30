import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SandboxTemplates } from '../infra/repo-runner/templates.mjs';
import { Sandboxes } from '../infra/repo-runner/sandbox.mjs';
import { ResourceBudget } from '../infra/execution/budget.mjs';

const files = [{ path: '.agents/skills/repo/SKILL.md', data: Buffer.from('Inspect before cloning').toString('base64') }];
test('build seeds persist across worker instances and template keys cannot be overwritten', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qa-templates-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SandboxTemplates(directory);
  assert.equal((await store.put('eve-template', files)).reused, false);
  const restarted = new SandboxTemplates(directory);
  assert.deepEqual(await restarted.get('eve-template'), files);
  assert.equal((await restarted.put('eve-template', files)).reused, true);
  await assert.rejects(restarted.put('eve-template', []), /different files/);
  for (const path of ['../escape', '/root/key', 'a/../../b', 'a\\b', 'a//b']) await assert.rejects(store.put('bad', [{ ...files[0], path }]), /path/);
  await assert.rejects(store.get('../escape'), /key/);
  const buildKey = `eve-sbx-tpl-qaa-vps-v1-${'a'.repeat(16)}-${'c'.repeat(20)}`;
  const workflowKey = `eve-sbx-tpl-qaa-vps-v1-${'b'.repeat(16)}-${'c'.repeat(20)}`;
  await store.put(buildKey, files);
  assert.deepEqual(await restarted.get(workflowKey), files, 'Vercel build and workflow bundle paths must share the same content version');
  await assert.rejects(store.get(workflowKey.replace('c'.repeat(20), 'd'.repeat(20))), /not provisioned/);
});

test('template seeds are applied once per environment, including after worker restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qa-seeds-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [], options = { directory, budget: new ResourceBudget(), events: { publish: async () => {} }, execute: async (...args) => { calls.push(args); return ''; }, storage: { prepare: async () => '/isolated', remove: async () => {} } };
  const service = new Sandboxes(options); await service.init();
  const identity = { id: randomUUID(), workspaceId: randomUUID(), owner: 'a'.repeat(64), templateKey: 'eve-template', action: 'ensure' };
  await assert.rejects(service.rpc(identity), /not provisioned/);
  assert.equal(calls.length, 0, 'Missing templates must not allocate compute');
  await service.templates.put(identity.templateKey, files);
  await service.rpc(identity); await service.rpc(identity);
  await service.rpc({ ...identity, action: 'stop' });
  const restarted = new Sandboxes(options); await restarted.init(); await restarted.rpc(identity);
  assert.equal(calls.filter(([, input]) => input === JSON.stringify(files)).length, 1, 'Reconnect must preserve user edits to seeded files');
  await restarted.templates.put('changed-template', []);
  await assert.rejects(restarted.rpc({ ...identity, templateKey: 'changed-template' }), /template changed/);
});
