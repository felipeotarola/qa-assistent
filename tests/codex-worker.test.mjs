import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexWorker, visibleJob } from '../infra/codex-worker/worker.mjs';
import { threadOptions } from '../infra/codex-worker/client.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'qaa-codex-'));
  const input = { id: randomUUID(), owner: 'a'.repeat(64), workspaceId: randomUUID(), userId: randomUUID(), jobId: randomUUID(), task: 'Inspect only', action: 'start' };
  const state = { ...input, status: 'ready', processes: [] };
  const calls = [];
  const sandboxes = {
    leaseMs: 300000,
    owned(id, owner) { assert.equal(id, input.id); assert.equal(owner, input.owner); return state; },
    serial(_id, fn) { return fn(); }, save() {},
    async rpc(value) { calls.push(value); return { status: 'completed', exitCode: 0, stdout: '{}', stderr: '' }; },
  };
  const worker = new CodexWorker({ directory, sandboxes, inspectionCommand: () => 'inspect-fixed', allowedUser: input.userId });
  worker.run = async () => {};
  await worker.init();
  t.after(async () => { await worker.close(); await rm(directory, { recursive: true, force: true }); });
  return { worker, input, calls, state, directory, sandboxes };
}
test('subscription pilot rejects other accounts and disabled pilot', async t => {
  const { worker, input } = await fixture(t);
  await assert.rejects(worker.rpc({ ...input, userId: randomUUID() }), /not enabled/);
  worker.allowedUser = undefined;
  await assert.rejects(worker.rpc(input), /not enabled/);
});
test('retries reuse submission, changed task conflicts, capacity is bounded', async t => {
  const { worker, input } = await fixture(t);
  const [one, two] = await Promise.all([worker.rpc(input), worker.rpc(input)]);
  assert.equal(one.jobId, two.jobId); assert.equal(worker.active.size, 1);
  await assert.rejects(worker.rpc({ ...input, task: 'different' }), /already used/);
  await assert.rejects(worker.rpc({ ...input, jobId: randomUUID() }), /busy/);
});
test('execution requires completed inspection and scope cannot be overridden', async t => {
  const { worker, input, calls } = await fixture(t);
  await worker.rpc(input); const job = worker.jobs.get(input.jobId);
  await assert.rejects(worker.call(job, 'execute', { command: 'touch proof' }), /Inspect/);
  const inspection = await worker.call(job, 'inspect_environment', {});
  await assert.rejects(worker.call(job, 'execute', { command: 'touch proof' }), /Inspect/);
  await worker.call(job, 'process', { processId: inspection.processId });
  await worker.call(job, 'execute', { command: 'touch proof', id: randomUUID(), owner: 'evil' });
  assert.equal(calls.at(-1).id, input.id); assert.equal(calls.at(-1).owner, input.owner);
  await assert.rejects(worker.call(job, 'process', { processId: randomUUID() }), /not permitted/);
  await assert.rejects(worker.call(job, 'host_shell', {}), /not permitted/);
});
test('cancel kills task processes, releases capacity, forbids subsequent execution', async t => {
  const { worker, input, calls } = await fixture(t);
  await worker.rpc(input); const job = worker.jobs.get(input.jobId);
  await worker.call(job, 'inspect_environment', {});
  await worker.rpc({ ...input, action: 'cancel' });
  assert.equal(job.status, 'cancelled'); assert.equal(worker.active.size, 0);
  assert.equal(calls.at(-1).action, 'kill');
  await assert.rejects(worker.call(job, 'inspect_environment', {}), /not active/);
});
test('job reports omit identity secrets; Codex has no host environment or shell', () => {
  assert.deepEqual(visibleJob({ owner: 'secret', userId: 'person', task: 'private', status: 'running' }), { status: 'running' });
  assert.deepEqual(threadOptions.environments, []);
  assert.equal(threadOptions.config['features.shell_tool'], false);
  assert.equal(threadOptions.config['features.unified_exec'], false);
  assert.equal(threadOptions.sandbox, 'read-only');
});
test('recovery marks interrupted work without replaying', async t => {
  const { worker, input, sandboxes, directory } = await fixture(t);
  await worker.rpc(input);
  const recovered = new CodexWorker({ directory, sandboxes, inspectionCommand: () => '', allowedUser: input.userId });
  await recovered.init();
  assert.equal(recovered.jobs.get(input.jobId).status, 'interrupted'); assert.equal(recovered.active.size, 0);
  await worker.rpc({ ...input, action: 'cancel' });
});
