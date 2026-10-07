import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Execute the real entry function bodies with local fake ports, without
// importing its top-level authentication/runtime/SQL side effects.
const entry = await readFile(resolve(process.env.SYNA_BROWSER_DEADLINE_ENTRY ?? 'tests/autonomy-browser-variants.acceptance.mjs'), 'utf8');
const { requireWebDeadline, observeWebBeforeDeadline } = await import(pathToFileURL(resolve('tests/helpers/autonomy-web-restart.mjs')).href);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
function between(start, end) {
  const a = entry.indexOf(start), b = entry.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Missing exact entry range ${start}`);
  return entry.slice(a, b);
}
const observation = between('Object.assign(trial, await submit(trial, cookie, protocol));', "assert.ok(trial.closedAt, 'Mission did not close in frozen observation window');")
  + "assert.ok(trial.closedAt, 'Mission did not close in frozen observation window'); return { deadline, trial };";
function ports({ delayed = null, independent = false, initialTime = 0 } = {}) {
  let time = initialTime, saves = 0, reads = 0, writes = 0;
  const RealDate = Date;
  class Clock extends RealDate {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  }
  const deps = {
    Date: Clock, assert, trial: { snapshots: [] }, cookie: 'not-a-cookie', independentCookie: 'not-a-cookie',
    protocol: { observationSeconds: 10 }, workspace: { id: 'own-workspace' },
    independent: independent ? { workspaceId: 'second-owned-workspace', snapshots: [], protocol: {} } : null,
    requireWebDeadline: deadline => requireWebDeadline(deadline, time),
    observeWebBeforeDeadline: (deadline, fn) => observeWebBeforeDeadline(deadline, fn, () => time),
    submit: async () => ({ sessionId: 'synthetic', acceptedAt: new RealDate(0).toISOString() }),
    persist: async () => { saves++; if (delayed === 'accepted-persist' && saves === 1 || delayed === 'snapshot-persist' && saves === 2) time = 16_000; },
    observe: async () => { reads++; if (delayed === 'observe' || delayed === 'independent-observe' && reads === 2) time = 16_000; return { missions: [{ lifecycle: 'closed' }] }; },
    userInteraction: async () => { writes++; }, regressionInteraction: async () => { writes++; },
    projectRegressionMission: state => state,
    setTimeout: done => { time += 1000; done(); },
  };
  return { deps, setTime: value => { time = value; }, counters: () => ({ saves, reads, writes }),
    run: body => new AsyncFunction(...Object.keys(deps), body)(...Object.values(deps)) };
}
const expired = error => error.code === 'WEB_OBSERVATION_EXPIRED';
test('original acceptance anchors the deadline even when first persistence is slow', async () => {
  const f = ports({ delayed: 'accepted-persist' });
  await assert.rejects(f.run(observation), expired);
  assert.equal(f.counters().reads, 0);
});
test('closure returned by an observation after the original deadline cannot pass', async () => {
  const f = ports({ delayed: 'observe' });
  await assert.rejects(f.run(observation), expired);
  assert.equal(f.deps.trial.closedAt, undefined);
});
test('closure persisted after the original deadline cannot pass', async () => {
  const f = ports({ delayed: 'snapshot-persist' });
  await assert.rejects(f.run(observation), expired);
  assert.equal(f.deps.trial.closedAt, undefined);
});
test('independent S1 observation cannot extend the original primary window', async () => {
  const f = ports({ independent: true, delayed: 'independent-observe' });
  await assert.rejects(f.run(observation), expired);
  assert.equal(f.deps.trial.closedAt, undefined);
});
test('timely primary and independent closure retain their original acceptance deadline', async () => {
  const f = ports({ independent: true, initialTime: 1000 });
  const result = await f.run(observation);
  assert.equal(result.deadline, 10_000);
  assert.ok(result.trial.closedAt && f.deps.independent.closedAt);
  assert.equal(f.counters().writes, 0);
});

const interaction = between('async function userInteraction(', '  async function createWorkspace(');
function human({ returning = false, late = false } = {}) {
  const f = ports();
  const selected = { taskId: 'task', attemptId: 'attempt', sessionId: 'physical' };
  Object.assign(f.deps, {
    taskId: 'WEB-02', variant: 'return-in-time', randomUUID: () => 'original-request',
    protocol: { takeover: { latestSeconds: 600, holdSeconds: 10 } },
    originalWait: () => ({ id: 'wait', state: 'waiting', created_at: new Date(0).toISOString(), deadline_at: new Date(100_000).toISOString() }),
    takeoverCandidate: () => selected, authenticationCandidate: () => { throw Error('Wrong fixture'); },
    post: async () => { f.sent++; return { browser: { sessionId: 'physical', control: returning ? 'agent' : 'human' } }; },
    persist: async () => { if (late) f.setTime(200_000); },
    state: { missions: [{ id: 'mission', mandate_revision: 1 }], attempts: [{ id: 'attempt', status: 'completed' }] },
  });
  f.sent = 0;
  f.deps.trial = { acceptedAt: new Date(0).toISOString(), threadId: 'thread', workspaceId: 'workspace', ...(returning ? { fault: { ...selected } } : {}) };
  f.setTime(20_000);
  return { ...f, execute: () => f.run(interaction + '\nreturn userInteraction(trial, state, 100_000);'), count: () => f.sent };
}
test('takeover intent persistence cannot cause a human mutation after timeout', async () => {
  const f = human({ late: true }); await assert.rejects(f.execute(), expired); assert.equal(f.count(), 0);
});
test('saved human answer cannot return control after persistence crossed timeout', async () => {
  const f = human({ returning: true, late: true }); await assert.rejects(f.execute(), expired); assert.equal(f.count(), 0);
});
test('timely return keeps the exact one-shot control and answer sequence', async () => {
  const f = human({ returning: true }); await f.execute(); assert.equal(f.count(), 2);
  assert.equal(f.deps.trial.fault.answer.answer.sessionId, 'physical');
  assert.ok(f.deps.trial.fault.answeredAt);
});
test('takeover persistence cannot cross its 600-second trigger budget even inside the larger observation budget', async () => {
  const f = human();
  f.deps.persist = async () => { f.setTime(610_000); };
  await assert.rejects(f.run(interaction + '\nreturn userInteraction(trial, state, 1500_000);'), expired);
  assert.equal(f.count(), 0);
});

const history = between('const first = { ...await submit(trial, cookie, actualHistoryExecutionProtocol(protocol))',
  "assert.ok(first.closedAt, 'Actual A preparation did not close inside its own frozen observation window');")
  + "assert.ok(first.closedAt, 'Actual A preparation did not close inside its own frozen observation window'); return first;";
test('WEB04 original A persistence cannot extend its separately fixed 1500-second deadline', async () => {
  const f = ports();
  Object.assign(f.deps, { actualHistoryExecutionProtocol: value => value, persist: async () => { f.setTime(1600_000); } });
  f.deps.trial.preparationProgress = {};
  await assert.rejects(f.run(history), expired);
  assert.equal(f.counters().reads, 0);
});
test('WEB04 A closure received after the deadline is rejected before history sealing', async () => {
  const f = ports();
  Object.assign(f.deps, { actualHistoryExecutionProtocol: value => value,
    observe: async () => { f.setTime(1600_000); return { missions: [{ lifecycle: 'closed' }] }; } });
  f.deps.trial.preparationProgress = {};
  await assert.rejects(f.run(history), expired);
  assert.equal(f.deps.trial.preparationProgress.execution.closedAt, undefined);
});

const regression = between('async function regressionInteraction(', '\n  try {');
function cancellation(delayed) {
  const f = ports(); let posts = 0;
  Object.assign(f.deps, { protocol: { stop: { latestSeconds: 600 } }, randomUUID: () => 'cancel-request',
    fixture: { runtimeScope: 'current-runtime' },
    state: { missions: [{ id: 'mission', mandate_revision: 1, plan_revision: 1, user_id: 'owner', workspace_id: 'workspace', thread_id: 'thread', runtime: 'current-runtime' }],
      attempts: [{ id: 'original-attempt', kind: 'browser_tests', status: 'running', mission_id: 'mission', runtime: 'current-runtime',
        mandate_revision: 1, plan_revision: 1, deadline_at: new Date(1500_000).toISOString(), dispatch_id: 'job' }],
      jobs: [{ id: 'job', runtime: 'current-runtime', thread_id: 'thread', status: 'running', session_id: 'iris-session' }],
      browsers: [{ agent_id: 'iris-session', control: 'agent', session_id: 'physical' }],
      claims: [{ id: 'claim', attempt_id: 'original-attempt', state: 'claimed', owner: 'agent', executor_resource_id: 'physical' }] },
    independent: { userId: 'other-owner', workspaceId: 'other-workspace', threadId: 'other-thread' },
    observe: async () => ({ missions: [{ lifecycle: 'running', user_id: 'other-owner', workspace_id: 'other-workspace', thread_id: 'other-thread', runtime: 'current-runtime' }] }),
    persist: async () => { if (delayed) f.setTime(700_000); },
    post: async () => { posts++; }, cancelledExecutionBaseline: () => ({ exactOriginal: true }) });
  Object.assign(f.deps.trial, { acceptedAt: new Date(0).toISOString(), userId: 'owner', workspaceId: 'workspace', threadId: 'thread' });
  return { f, posts: () => posts,
    execute: () => f.run(regression + '\nreturn regressionInteraction(trial, state, independent, 1500_000);') };
}
test('timely S1 cancellation remains exactly one owner command with its original identity', async () => {
  const c = cancellation(false); await c.execute(); assert.equal(c.posts(), 1);
  assert.equal(c.f.deps.trial.fault.command.requestId, 'cancel-request');
  assert.deepEqual(c.f.deps.trial.fault.postCancelObservation, { exactOriginal: true });
});
test('S1 persistence crossing the cancellation trigger window never submits a late command', async () => {
  const c = cancellation(true); await assert.rejects(c.execute(), expired); assert.equal(c.posts(), 0);
});

const completion = between("const paths = ['/api/internal/autonomy/drain'", "\n      } catch (error) { trial.status");
test('post-observation file read cannot yield success after fixed completion deadline', async () => {
  const f = ports();
  Object.assign(f.deps, { root: '.', resolve, completionDeadline: 100,
    readFile: async () => { f.setTime(200); return ['/api/internal/autonomy/drain', '/api/internal/result-reviews/drain', '/api/internal/mission-reports/drain']
      .map(path => JSON.stringify({ path, timestamp: '2026-01-01T00:00:01Z', method: 'POST', status: 200 })).join('\n'); } });
  f.deps.trial.acceptedAt = '2026-01-01T00:00:00Z'; f.deps.trial.closedAt = '2026-01-01T00:00:02Z';
  await assert.rejects(f.run(completion), expired);
  assert.notEqual(f.deps.trial.status, 'automated_subset_passed');
});
test('success receipt persistence crossing deadline converts the current trial to failure', async () => {
  const f = ports();
  Object.assign(f.deps, { root: '.', resolve, completionDeadline: 100,
    persist: async () => { f.setTime(200); },
    readFile: async () => ['/api/internal/autonomy/drain', '/api/internal/result-reviews/drain', '/api/internal/mission-reports/drain']
      .map(path => JSON.stringify({ path, timestamp: '2026-01-01T00:00:01Z', method: 'POST', status: 200 })).join('\n') });
  f.deps.trial.acceptedAt = '2026-01-01T00:00:00Z'; f.deps.trial.closedAt = '2026-01-01T00:00:02Z';
  await assert.rejects(f.run(completion), expired);
  assert.equal(f.deps.trial.status, 'failed');
});
test('late-answer has only its original fixed 120-second suffix; no queue or rescue port was added', () => {
  assert.match(entry, /completionDeadline = deadline \+ \(variant === 'late-answer' \? protocol\.takeover\.lateAnswerObservationSeconds \* 1000 : 0\)/);
  assert.match(entry, /observeWebBeforeDeadline\(completionDeadline, \(\) => observe\(workspace\.id\)\)/);
  assert.match(entry, /otherSessionDenial = await post\([\s\S]+?409\)/);
  assert.match(entry, /otherOwnerDenial = await post\([\s\S]+?\[403, 404\], foreignCookie\)/);
  assert.match(entry, /if \(trial\.status === 'failed'\) break/);
});
const lateLoop = between('const until = Date.now() + protocol.takeover.lateAnswerObservationSeconds * 1000;', 'trial.fault.lateObservationFinishedAt = new Date().toISOString();');
test('late-answer still observes the full fixed suffix and unchanged execution identity', async () => {
  const f = ports(); let observed = 0;
  Object.assign(f.deps, { protocol: { takeover: { lateAnswerObservationSeconds: 120 } }, completionDeadline: 2400_000 + 120_000,
    before: { original: true }, closedExecutionIdentity: state => state, observe: async () => { observed++; return { original: true }; } });
  await f.run(lateLoop); assert.equal(observed, 120);
});
test('host sleep inside the late suffix cannot produce success beyond its original outer limit', async () => {
  const f = ports();
  Object.assign(f.deps, { protocol: { takeover: { lateAnswerObservationSeconds: 120 } }, completionDeadline: 2520_000,
    before: { original: true }, closedExecutionIdentity: state => state,
    observe: async () => { f.setTime(2600_000); return { original: true }; } });
  await assert.rejects(f.run(lateLoop), expired);
});
