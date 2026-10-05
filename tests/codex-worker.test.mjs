import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexWorker, visibleJob } from '../infra/codex-worker/worker.mjs';
import { threadOptions } from '../infra/codex-worker/client.mjs';
import { vaultContext } from '../infra/codex-worker/vault-context.mjs';

test('vault inventory carries names, never values, and distinguishes unchecked inventory', () => {
  const context = vaultContext({ entries: [{ repoUrl: 'https://github.com/example/repo', configuredNames: ['DATABASE_URL', 'NODE_OPTIONS'], values: { DATABASE_URL: 'private-value' } }], values: 'private-root' });
  assert.match(context, /DATABASE_URL/);
  assert.match(context, /NOT that they are applied/);
  assert.ok(!context.includes('private-value') && !context.includes('private-root') && !context.includes('NODE_OPTIONS'));
  assert.match(vaultContext(), /not checked/);
  assert.match(vaultContext({ entries: [] }), /"entries":\[\]/);
});

test('worker keeps its vault snapshot on retry without submitting credentials', async t => {
  const { worker, input } = await fixture(t);
  const first = await worker.rpc({ ...input, vault: { entries: [{ repoUrl: 'https://github.com/example/repo', configuredNames: ['DATABASE_URL'], values: { DATABASE_URL: 'never-save-this' } }] } });
  const retry = await worker.rpc({ ...input, vault: { entries: [] } });
  assert.equal(first.vaultContext, retry.vaultContext);
  assert.match(first.vaultContext, /DATABASE_URL/);
  assert.ok(!JSON.stringify(worker.jobs.get(input.jobId)).includes('never-save-this'));
});

async function fixture(t, accessMode = 'pilot') {
  const directory = await mkdtemp(join(tmpdir(), 'qaa-codex-'));
  const input = { id: randomUUID(), owner: 'a'.repeat(64), workspaceId: randomUUID(), userId: randomUUID(), jobId: randomUUID(), task: 'Inspect only', action: 'start' };
  const peerInput = { id: randomUUID(), owner: 'b'.repeat(64), workspaceId: randomUUID(), userId: randomUUID(), jobId: randomUUID(), task: 'Inspect peer environment', action: 'start' };
  const state = { ...input, status: 'ready', processes: [] };
  const peerState = { ...peerInput, status: 'ready', processes: [] };
  const sessions = new Map([[state.id, state], [peerState.id, peerState]]);
  const calls = [];
  const sandboxes = {
    leaseMs: 300000, sessions,
    owned(id, owner) {
      const session = sessions.get(id);
      if (!session || session.owner !== owner) throw new Error('Sandbox not found');
      return session;
    },
    serial(_id, fn) { return fn(); }, save() {},
    async rpc(value) {
      const session = this.owned(value.id, value.owner);
      if (session.workspaceId !== value.workspaceId) throw new Error('Sandbox not found');
      calls.push(value);
      return { status: 'completed', exitCode: 0, stdout: '{}', stderr: '' };
    },
  };
  const worker = new CodexWorker({ directory, sandboxes, inspectionCommand: () => 'inspect-fixed', allowedUser: input.userId, accessMode });
  worker.run = async () => {};
  await worker.init();
  t.after(async () => { await worker.close(); await rm(directory, { recursive: true, force: true }); });
  return { worker, input, peerInput, calls, state, peerState, directory, sandboxes };
}
test('single-user pilot rejects another account with its own valid sandbox', async t => {
  const { worker, input, peerInput } = await fixture(t);
  await assert.rejects(worker.rpc(peerInput), /not enabled/);
  assert.equal((await worker.rpc(input)).jobId, input.jobId);
});
test('explicitly disabled worker rejects submissions even with a pilot identity', async t => {
  const { worker, input } = await fixture(t, 'disabled');
  await assert.rejects(worker.rpc(input), /not enabled/);
  assert.equal(worker.jobs.size, 0);
});
test('shared worker serves two accounts sequentially without sharing sandbox state or vault inventory', async t => {
  const { worker, input, peerInput, calls, state, peerState } = await fixture(t, 'shared');
  const first = await worker.rpc({ ...input, vault: { entries: [{ repoUrl: 'https://github.com/first/repo', configuredNames: ['FIRST_ACCOUNT_KEY'] }] } });
  const firstJob = worker.jobs.get(first.jobId);
  await worker.call(firstJob, 'inspect_environment', {});
  await worker.finish(firstJob, 'completed', 'First account done');

  const second = await worker.rpc({ ...peerInput, vault: { entries: [{ repoUrl: 'https://github.com/second/repo', configuredNames: ['SECOND_ACCOUNT_KEY'] }] } });
  await worker.call(worker.jobs.get(second.jobId), 'inspect_environment', {});

  assert.equal(worker.jobs.size, 2);
  assert.equal(state.codex.jobId, input.jobId);
  assert.equal(peerState.codex.jobId, peerInput.jobId);
  assert.equal(state.codex.status, 'completed');
  assert.equal(worker.jobs.get(second.jobId).userId, peerInput.userId);
  assert.deepEqual(calls.map(({ id, owner, workspaceId }) => ({ id, owner, workspaceId })), [
    { id: input.id, owner: input.owner, workspaceId: input.workspaceId },
    { id: peerInput.id, owner: peerInput.owner, workspaceId: peerInput.workspaceId },
  ]);
  assert.match(first.vaultContext, /FIRST_ACCOUNT_KEY/);
  assert.match(second.vaultContext, /SECOND_ACCOUNT_KEY/);
  assert.doesNotMatch(second.vaultContext, /FIRST_ACCOUNT_KEY|first\/repo/);
});
test('shared access rejects missing or malformed principals before creating jobs', async t => {
  const { worker, input } = await fixture(t, 'shared');
  for (const userId of [undefined, null, '', 'anonymous', 'somebody@example.com', 123, {}, `${input.userId} `]) {
    await assert.rejects(worker.rpc({ ...input, userId }), /authenticated app user/);
  }
  assert.equal(worker.jobs.size, 0);
  assert.equal(worker.active.size, 0);
});
test('shared access preserves job, principal, sandbox and workspace boundaries for all job actions', async t => {
  const { worker, input, peerInput, calls } = await fixture(t, 'shared');
  await worker.rpc(input);
  const job = worker.jobs.get(input.jobId);
  for (const action of ['start', 'status', 'cancel', 'configure']) {
    // A valid second account and its legitimate sandbox cannot reference the first account's job.
    await assert.rejects(worker.rpc({ ...peerInput, action, jobId: input.jobId, attemptId: randomUUID(), values: {} }), /Job not found/);
    // A guessed sandbox ID does not grant the matching owner capability.
    await assert.rejects(worker.rpc({ ...peerInput, action, id: input.id, jobId: input.jobId }), /Sandbox not found/);
    // Defense in depth for trusted caller bugs: even a matching owner cannot change the saved job principal.
    await assert.rejects(worker.rpc({ ...input, action, userId: peerInput.userId }), /Job not found/);
    await assert.rejects(worker.rpc({ ...input, action, workspaceId: peerInput.workspaceId }), /Sandbox not found/);
  }
  assert.equal(job.status, 'starting');
  assert.equal(worker.active.size, 1);
  assert.equal(worker.jobs.size, 1);
  assert.equal(calls.length, 0);
  assert.equal((await worker.rpc({ ...input, action: 'status' })).jobId, input.jobId);
});
test('shared capacity stays global and retries do not create a second active job', async t => {
  const { worker, input, peerInput } = await fixture(t, 'shared');
  const submitted = await Promise.allSettled([worker.rpc(input), worker.rpc(input), worker.rpc(peerInput)]);
  assert.equal(submitted[0].status, 'fulfilled');
  assert.equal(submitted[1].status, 'fulfilled');
  assert.equal(submitted[0].value.jobId, submitted[1].value.jobId);
  assert.equal(submitted[2].status, 'rejected');
  assert.match(submitted[2].reason.message, /busy/);
  assert.ok(!submitted[2].reason.message.includes(input.jobId));
  assert.ok(!submitted[2].reason.message.includes(input.userId));
  assert.equal(worker.jobs.size, 1);
  assert.equal(worker.active.size, 1);
  await assert.rejects(worker.rpc({ ...input, task: 'A different task' }), /already used/);
  await worker.rpc({ ...input, action: 'cancel' });
  assert.equal((await worker.rpc(peerInput)).jobId, peerInput.jobId);
});
test('shared policy keeps credential-bearing environments closed to new agent shell tasks', async t => {
  const { worker, input, peerInput } = await fixture(t, 'shared');
  worker.environments = { values: new Map([[input.id, { DATABASE_URL: 'first-account-secret' }]]) };
  await assert.rejects(worker.rpc(input), /contains repository credentials/);
  assert.equal(worker.jobs.size, 0);
  assert.equal((await worker.rpc(peerInput)).jobId, peerInput.jobId);
  assert.ok(!JSON.stringify([...worker.jobs.values()]).includes('first-account-secret'));
});
test('disabling new work retains owned status and cancellation while blocking start and configure', async t => {
  const { worker, input, peerInput } = await fixture(t, 'shared');
  await worker.rpc(input);
  worker.access = { mode: 'disabled' };
  await assert.rejects(worker.rpc(peerInput), /not enabled/);
  await assert.rejects(worker.rpc({ ...input, action: 'configure', attemptId: randomUUID(), values: {} }), /not enabled/);
  assert.equal((await worker.rpc({ ...input, action: 'status' })).jobId, input.jobId);
  for (const action of ['status', 'cancel']) {
    await assert.rejects(worker.rpc({ ...peerInput, action, jobId: input.jobId }), /Job not found/);
    await assert.rejects(worker.rpc({ ...input, action, userId: undefined }), /authenticated app user/);
  }
  assert.equal((await worker.rpc({ ...input, action: 'cancel' })).status, 'cancelled');
  assert.equal(worker.active.size, 0);
  assert.equal((await worker.rpc({ ...input, action: 'status' })).status, 'cancelled');
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
