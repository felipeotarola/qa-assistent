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

test('missing environment becomes a blocker, rejects invented processes and resumes once', async t => {
  const {worker,input,state}=await fixture(t);
  let applied=0,release;
  worker.environments={values:new Map(),redact:(_id,value)=>value,inspect:async(_job,args)=>({...args,commit:'a'.repeat(40),httpStatus:500}),apply:async job=>{applied++;await new Promise(r=>{release=r;});return {...job.environment,httpStatus:200};}};
  await worker.rpc(input);const job=worker.jobs.get(input.jobId);
  const inspection=await worker.call(job,'inspect_environment',{});await worker.call(job,'process',{processId:inspection.processId});
  const command='npm run dev',directory='/workspace/project';
  const process=await worker.call(job,'execute',{command,directory});
  const args={repoUrl:'https://github.com/example/project',root:directory,directory,command,port:3000,processId:process.processId,variables:[{name:'DATABASE_URL',reason:'Page data',required:true}]};
  await assert.rejects(worker.call(job,'report_environment',{...args,processId:randomUUID()}),/must match/);
  await worker.call(job,'report_environment',args);
  await worker.finish(job,'completed','Done');
  assert.equal(job.status,'needs_configuration');assert.equal(worker.active.size,0);
  const request={...input,action:'configure',attemptId:randomUUID(),values:{DATABASE_URL:'private-fixture'}};
  assert.equal((await worker.rpc(request)).status,'configuring');
  await worker.rpc(request);assert.equal(applied,1);
  assert.ok(!JSON.stringify(job).includes('private-fixture')); assert.ok(!JSON.stringify(state).includes('private-fixture'));
  release();
  for(let i=0;i<100&&worker.active.size;i++) await new Promise(r=>setTimeout(r,5));
  assert.equal(job.status,'completed');assert.equal(job.environment.httpStatus,200);
  await worker.rpc(request);assert.equal(applied,1);
});

test('worker restart preserves completed delivery identity instead of notifying again', async t => {
  const {worker,input,sandboxes,directory}=await fixture(t);
  await worker.rpc(input);const job=worker.jobs.get(input.jobId);
  await worker.finish(job,'completed','Observed result');
  const identity={eventId:job.eventId,updatedAt:job.updatedAt};
  const recovered=new CodexWorker({directory,sandboxes,inspectionCommand:()=>'',allowedUser:input.userId});await recovered.init();
  const saved=recovered.jobs.get(input.jobId);
  assert.deepEqual({eventId:saved.eventId,updatedAt:saved.updatedAt},identity);
  assert.equal(recovered.active.size,0);
});
