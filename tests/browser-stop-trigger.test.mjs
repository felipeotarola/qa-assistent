import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = await readFile(resolve(process.env.SYNA_BROWSER_STOP_ENTRY ?? 'tests/autonomy-browser-variants.acceptance.mjs'), 'utf8');
const { requireWebDeadline, observeWebBeforeDeadline } = await import(pathToFileURL(resolve('tests/helpers/autonomy-web-restart.mjs')).href);
const start = entry.indexOf('async function regressionInteraction('), end = entry.indexOf('\n  try {', start);
assert.ok(start >= 0 && end > start);
const body = entry.slice(start, end);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
function scenario(status = 'dispatching') {
  let now = 1000;
  const calls = [], RealDate = Date;
  class Clock extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const mission = { id: 'mission', lifecycle: 'running', workspace_id: 'workspace', thread_id: 'thread', user_id: 'owner',
    runtime: 'isolated-runtime', mandate_revision: 2, plan_revision: 3 };
  const attempt = { id: 'attempt', kind: 'browser_tests', status, mission_id: mission.id, runtime: mission.runtime,
    mandate_revision: 2, plan_revision: 3, dispatch_id: 'job', deadline_at: new RealDate(900_000).toISOString(), finished_at: null, cancel_requested_at: null };
  const job = { id: 'job', runtime: mission.runtime, thread_id: 'thread', status: 'running', session_id: 'iris' };
  const browser = { agent_id: 'iris', control: 'agent', session_id: 'physical' };
  const claim = { id: 'claim', attempt_id: 'attempt', state: 'claimed', owner: 'agent', executor_resource_id: 'physical' };
  const state = { missions: [mission], attempts: [attempt], jobs: [job], browsers: [browser], claims: [claim] };
  const independent = { userId: 'other-owner', workspaceId: 'other-workspace', threadId: 'other-thread' };
  const other = { missions: [{ id: 'other-mission', lifecycle: 'running', workspace_id: independent.workspaceId,
    thread_id: independent.threadId, user_id: independent.userId, runtime: mission.runtime }] };
  const trial = { acceptedAt: new RealDate(0).toISOString(), workspaceId: 'workspace', threadId: 'thread', userId: 'owner',
    preparation: { originalPlan: 'unchanged' } };
  const deps = { assert, Date: Clock, fixture: { runtimeScope: mission.runtime }, trial, state, independent,
    protocol: { stop: { latestSeconds: 600 } }, cookie: 'synthetic-cookie', randomUUID: () => 'exact-request',
    observeWebBeforeDeadline: (limit, action) => observeWebBeforeDeadline(limit, action, () => now),
    requireWebDeadline: limit => requireWebDeadline(limit, now),
    observe: async id => { calls.push(['observe', id]); return id === independent.workspaceId ? other : state; },
    persist: async () => { calls.push(['persist']); },
    post: async (path, value) => { calls.push(['post', path, structuredClone(value)]); },
    projectRegressionMission: value => value,
    cancelledExecutionBaseline: (_state, fault) => ({ requestId: fault.command.requestId, originalAttempt: fault.attemptId }),
  };
  return { state, attempt, job, browser, claim, mission, trial, independent, other, calls, deps,
    setTime: value => { now = value; },
    run: () => new AsyncFunction(...Object.keys(deps), body + '\nreturn regressionInteraction(trial, state, independent, 1500_000);')(...Object.values(deps)) };
}
const sends = f => f.calls.filter(row => row[0] === 'post');
test('real browser dispatching plus exact job/physical claim triggers one original cancellation', async () => {
  const f = scenario(); await f.run();
  assert.equal(sends(f).length, 1);
  assert.deepEqual(sends(f)[0].slice(1), ['/api/workspaces/workspace/autonomy', { threadId: 'thread', input: {
    action: 'cancel', missionId: 'mission', requestId: 'exact-request', expectedMandateRevision: 2 } }]);
  assert.equal(f.trial.fault.attemptId, 'attempt'); assert.equal(f.trial.fault.jobId, 'job');
  assert.equal(f.trial.fault.sessionId, 'physical'); assert.equal(f.trial.fault.claimId, 'claim');
  assert.deepEqual(f.trial.fault.independentBefore, f.other);
  await f.run(); assert.equal(sends(f).length, 1, 'Persisted original intent is never retried');
});
test('explicit running remains eligible with the same complete physical binding', async () => {
  const f = scenario('running'); await f.run(); assert.equal(sends(f).length, 1);
});
test('queued, unknown dispatch and terminal attempts cannot trigger the physical fault', async () => {
  for (const status of ['reserved', 'dispatch_unknown', 'completed', 'failed', 'cancelled']) {
    const f = scenario(status); await f.run(); assert.equal(sends(f).length, 0, status);
  }
});
test('missing, different, uncertain or human physical claims cannot trigger', async () => {
  for (const mutation of [{ executor_resource_id: null }, { executor_resource_id: 'replacement' }, { attempt_id: 'other-attempt' }, { state: 'uncertain' }, { owner: 'human' }]) {
    const f = scenario('running'); Object.assign(f.claim, mutation); await f.run(); assert.equal(sends(f).length, 0, JSON.stringify(mutation));
  }
});
test('job must be current and running in the original runtime/thread with its Iris session', async () => {
  for (const mutation of [{ id: 'other-job' }, { runtime: 'foreign' }, { thread_id: 'other' }, { status: 'starting' }, { status: 'completed' }, { session_id: null }]) {
    const f = scenario('running'); Object.assign(f.job, mutation); await f.run(); assert.equal(sends(f).length, 0, JSON.stringify(mutation));
  }
});
test('assignment must match that Iris job and exactly the claimed agent-controlled browser', async () => {
  for (const mutation of [{ agent_id: 'other-iris' }, { session_id: 'other-browser' }, { session_id: null }, { control: 'human' }]) {
    const f = scenario('running'); Object.assign(f.browser, mutation); await f.run(); assert.equal(sends(f).length, 0, JSON.stringify(mutation));
  }
});
test('obsolete epoch, source mission, attempt deadline or cancellation marker stays ineligible', async () => {
  for (const mutation of [{ plan_revision: 2 }, { mandate_revision: 1 }, { runtime: 'foreign' }, { mission_id: 'other' },
    { deadline_at: new Date(0).toISOString() }, { finished_at: new Date(500).toISOString() }, { cancel_requested_at: new Date(500).toISOString() }]) {
    const f = scenario('running'); Object.assign(f.attempt, mutation); await f.run(); assert.equal(sends(f).length, 0, JSON.stringify(mutation));
  }
});
test('primary mission must still be the one owner/workspace/thread/runtime originally submitted', async () => {
  for (const mutation of [{ user_id: 'foreign' }, { workspace_id: 'other' }, { thread_id: 'other' }, { runtime: 'foreign' }, { lifecycle: 'closed' }]) {
    const f = scenario('running'); Object.assign(f.mission, mutation); await f.run(); assert.equal(sends(f).length, 0, JSON.stringify(mutation));
  }
});
test('independent mission must be a live different owner in its exact original scope', async () => {
  for (const mutation of [{ user_id: 'owner' }, { workspace_id: 'workspace' }, { thread_id: 'thread' }, { runtime: 'foreign' }, { lifecycle: 'closed' }]) {
    const f = scenario('running'); Object.assign(f.other.missions[0], mutation);
    await assert.rejects(f.run); assert.equal(sends(f).length, 0, JSON.stringify(mutation));
  }
  const f = scenario('running'); f.independent.userId = 'owner'; f.other.missions[0].user_id = 'owner';
  await assert.rejects(f.run); assert.equal(sends(f).length, 0);
});
test('original trigger deadline rejects a late physical match without cancellation', async () => {
  const f = scenario(); f.setTime(601_000); await assert.rejects(f.run, /Cancellation window/); assert.equal(sends(f).length, 0);
});
test('persistence crossing the original trigger deadline preserves intent but sends nothing', async () => {
  const f = scenario(); f.deps.persist = async () => { f.setTime(601_000); };
  await assert.rejects(f.run, error => error.code === 'WEB_OBSERVATION_EXPIRED');
  assert.equal(sends(f).length, 0); assert.equal(f.trial.fault.sessionId, 'physical');
});
