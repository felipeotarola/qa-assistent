import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createError, defineEventHandler } from 'h3';
import { PgDialect } from 'drizzle-orm/pg-core';

// Actual authored route/service and installed Eve descriptors. Database results,
// HTTP transport and transaction locks are synthetic; this does not prove SQL
// isolation, concurrent locking, physical browser work or a model's tool choice.
const globals = Object.fromEntries(['createError', 'defineEventHandler', 'readBody', 'getRequestHeader', 'intakeRoutingFixture'].map(key => [key, globalThis[key]]));
const fixture = { state: null, services: {} };
globalThis.intakeRoutingFixture = fixture;
Object.assign(globalThis, { createError, defineEventHandler, readBody: async event => event.body, getRequestHeader: (event, name) => event.headers?.[name] });
const routeUrl = new URL('../server/api/internal/test-run.post.ts', import.meta.url).href;
const serviceUrl = new URL('../server/utils/test-runs.ts', import.meta.url).href;
const browserReturnUrl = new URL('../server/utils/mission-browser-return.ts', import.meta.url).href;
const data = names => `data:text/javascript,${encodeURIComponent(names.map(name => `export const ${name}=(...args)=>globalThis.intakeRoutingFixture.services.${name}(...args);`).join('\n'))}`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@nuxthub/db') return { url: 'data:text/javascript,export const db=globalThis.intakeRoutingFixture.db; export const schema=globalThis.intakeRoutingFixture.schema;', shortCircuit: true };
  let names;
  if (context.parentURL === routeUrl) names = ({ '../../utils/threads': ['getThreadForUser'], '../../utils/result-review-worker': ['processReviewQueue'], '../../utils/missions': ['bindMissionSource', 'validateMissionBinding', 'sourceMissionBinding'], '../../utils/mission-attempts': ['accountMissionTestReceipt', 'authorizeMissionOperation'] })[specifier];
  if (context.parentURL === serviceUrl) names = ({ './workspaces': ['ownedItem', 'requireWorkspace'], './result-assessments': ['autoReviewEnabled', 'enqueueReview', 'listAssessments', 'requestReview'], './mission-control': ['lockMission', 'recordMissionEvent'], './mission-complements': ['validateMissionComplement'] })[specifier];
  // Keep the actual returned-case guard and its receipt parser. Its unrelated
  // source/event services must not pull the full server into this unit fixture.
  if (context.parentURL === browserReturnUrl) names = ({ './mission-sources': ['missionHash'], './mission-control': ['recordMissionEvent'], './mission-environment-scope': ['readyMissionEnvironment'], './mission-complements': ['validateMissionComplement'] })[specifier];
  if (names) return { url: data(names), shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    for (const candidate of [`${specifier}.ts`, specifier.replace(/\.js$/, '.ts')]) {
      const url = new URL(candidate, context.parentURL);
      if (candidate !== specifier && existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
  }
  return next(specifier, context);
} });
fixture.schema = { ...(await import('../server/db/schema/test-runs.ts')), ...(await import('../server/db/schema/missions.ts')), ...(await import('../server/db/schema/browser-jobs.ts')), ...(await import('../server/db/schema/test-requirements.ts')), ...(await import('../server/db/schema/test-captures.ts')) };
const S = fixture.schema, dialect = new PgDialect();
const query = table => {
  const builder = { innerJoin: () => builder, where: condition => { builder.condition = condition; return builder; }, orderBy: () => builder,
    then: (resolve, reject) => Promise.resolve().then(() => {
      const next = fixture.state.selects.shift();
      assert.ok(next, 'Unexpected database read'); assert.equal(table, next.table, 'Unexpected table order');
      fixture.state.reads.push({ table, condition: builder.condition ? dialect.sqlToQuery(builder.condition) : null });
      return next.rows;
    }).then(resolve, reject) };
  return builder;
};
fixture.db = {
  select: () => ({ from: query }),
  transaction: fn => fn(fixture.db),
  execute: async sql => { fixture.state.locks.push(dialect.sqlToQuery(sql).sql); return [{ now: '2026-10-06T10:00:00.000Z' }]; },
  insert: table => ({ values: values => ({ returning: async () => { fixture.state.writes.push({ action: 'insert', table, values }); return [{ ...fixture.state.run, ...values }]; } }) }),
  update: table => ({ set: values => ({ where: () => ({ returning: async () => { fixture.state.writes.push({ action: 'update', table, values }); return [{ ...fixture.state.run, ...values }]; } }) }) }),
};
const owner = '11111111-1111-4111-8111-111111111111', workspace = '22222222-2222-4222-8222-222222222222', thread = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444', caseId = '55555555-5555-4555-8555-555555555555', requestId = '66666666-6666-4666-8666-666666666666';
const runId = '77777777-7777-4777-8777-777777777777', missionId = '88888888-8888-4888-8888-888888888888', taskId = '99999999-9999-4999-8999-999999999999';
const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', jobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const runtime = 'autonomy-test:unit-intake', execution = { attemptId, dispatchId: jobId };
const start = { action: 'start', itemId, caseId, expectedVersion: 1, requestId, environment: 'Synthetic browser' };
const result = { outcome: 'inconclusive', actual: 'Synthetic persisted receipt; no browser executed.', unverified: 'No physical execution in this unit fixture.', observations: [], evidenceItemIds: [] };
const saved = (extra = {}) => ({ id: runId, workspaceId: workspace, threadId: thread, runtime, itemId, caseId, planVersion: 1, requestId, environment: start.environment, target: null, missionAttemptId: null,
  snapshot: { id: caseId, type: 'browser', title: 'Synthetic plan case', steps: 'Observe heading', expected: 'Heading is readable', preconditions: '' }, result: null, ...extra });
const bound = () => ({ mission: { id: missionId, controllerVersion: 1, userId: owner, workspaceId: workspace, runtime, status: 'active', lifecycle: 'running', deadlineAt: new Date('2026-10-06T11:00:00Z'), planRevision: 1, mandateRevision: 1, config: { target: { environment: 'Synthetic browser', url: 'https://fixture.example.test/', revision: '', dataProfile: '', account: '' } } },
  task: { id: taskId, state: 'running', planRevision: 1, spec: { kind: 'browser_tests', caseKeys: [`${itemId}:${caseId}`], planVersions: [{ itemId, version: 1 }] } },
  attempt: { id: attemptId, taskId, dispatchId: jobId, kind: 'browser_tests', status: 'running', planRevision: 1, mandateRevision: 1, deadlineAt: new Date('2026-10-06T11:00:00Z'), cancelRequestedAt: null } });
function reset({ flag = 'true', run = saved() } = {}) {
  process.env.AUTONOMOUS_MISSIONS_ENABLED = flag; process.env.PAT_RUNTIME_SCOPE = runtime; process.env.INTERNAL_API_SECRET = 'synthetic-local-test-only';
  fixture.state = { selects: [], writes: [], reads: [], locks: [], effects: [], run, item: { id: itemId, version: 1, content: { kind: 'test_plan', cases: [run.snapshot] } } };
  return fixture.state;
}
function select(table, ...rows) { fixture.state.selects.push({ table, rows }); }
function untouched() { assert.equal(fixture.state.writes.length, 0); assert.deepEqual(fixture.state.effects, []); assert.equal(fixture.state.selects.length, 0); }
fixture.services = {
  async getThreadForUser(id, key) { return id === owner && key === thread ? { workspaceId: workspace } : null; },
  async requireWorkspace(id, key) { if (id !== owner || key !== workspace) throw createError({ statusCode: 404 }); },
  async ownedItem(id, key, item) { await fixture.services.requireWorkspace(id, key); assert.equal(item, itemId); return fixture.state.item; },
  async processReviewQueue() { fixture.state.effects.push('queue'); },
  async bindMissionSource(...args) { fixture.state.effects.push({ bind: args }); },
  async validateMissionBinding() { fixture.state.effects.push('validate-binding'); },
  async sourceMissionBinding() { return fixture.state.inherited; },
  async accountMissionTestReceipt() { fixture.state.effects.push('account-receipt'); },
  async authorizeMissionOperation(input) { fixture.state.effects.push({ authorize: input }); },
  autoReviewEnabled: () => false,
  async enqueueReview() { throw new Error('No automatic queue creation expected'); },
  async listAssessments() { return []; },
  async requestReview() { fixture.state.effects.push('assess'); },
  async lockMission() { fixture.state.locks.push('mission'); },
  async recordMissionEvent() { throw new Error('No controller event expected'); },
  async validateMissionComplement() {},
  missionHash() { throw new Error('No valid browser handoff hash expected in this intake fixture'); },
  readyMissionEnvironment() { throw new Error('Preview environment authority is not exercised by this intake fixture'); },
};
const [{ testRunAction }, { default: route }, { default: tool }, { default: missionTool }, { default: instructions }, { default: missionInstructions }] = await Promise.all([
  import('../server/utils/test-runs.ts'), import('../server/api/internal/test-run.post.ts'), import('../agent/tools/test_run.ts'), import('../agent/tools/qa_mission.ts'), import('../agent/instructions.ts'), import('../agent/instructions/missions.ts'),
]);
hooks.deregister();
const originalEnv = Object.fromEntries(['AUTONOMOUS_MISSIONS_ENABLED', 'MISSIONS_ENABLED', 'PAT_RUNTIME_SCOPE', 'INTERNAL_API_SECRET'].map(key => [key, process.env[key]]));
test.after(() => { for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } for (const [key, value] of Object.entries(globals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
const call = (input, extra = {}) => route({ body: { userId: owner, threadId: thread, ...input }, headers: { authorization: 'Bearer synthetic-local-test-only' }, waitUntil: () => {}, ...extra });
const reject = (value, status = 409) => assert.rejects(value, error => error.statusCode === status);
function workerInput(input = start) { return { ...input, browserJobId: jobId, executorSessionId: 'accepted-iris-session', callId: 'stable-call' }; }
function workerReads(origin, existing) {
  select(S.browserJobs, { id: jobId, threadId: thread, runtime, sessionId: 'accepted-iris-session', status: 'running' });
  select(S.missionAttempts, ...(origin ? [origin] : [])); select(S.testRuns, ...(existing ? [existing] : []));
}

test('internal V START is denied under request locks before insert or source adoption', async () => {
  reset(); select(S.testRuns);
  await assert.rejects(call({ ...start, mission: { missionId, taskId } }), error => error.statusCode === 409 && /qa_mission/.test(error.statusMessage));
  untouched(); assert.equal(fixture.state.locks.length, 2);
});
test('model-supplied option and execution fields do not open the internal gate', async () => {
  reset(); select(S.testRuns); await reject(call({ ...start, requireAutonomousStart: false, execution })); untouched();
});
test('mission kill switch does not reopen legacy starts while autonomy flag stays enabled', async () => {
  reset(); process.env.MISSIONS_ENABLED = 'false'; select(S.testRuns); await reject(call(start)); untouched(); delete process.env.MISSIONS_ENABLED;
});
test('legacy Iris job without controller attempt cannot create a run', async () => {
  reset(); workerReads(null); select(S.testRuns); await reject(call(workerInput())); untouched();
});
test('wrong Iris session is rejected before execution lookup or new effects', async () => {
  reset(); select(S.browserJobs, { id: jobId, sessionId: 'other-session' }); await reject(call(workerInput())); untouched();
});
test('internal credential and owner-thread checks precede the service', async () => {
  reset(); await reject(call(start, { headers: {} }), 401); untouched();
  await reject(call({ ...start, userId: requestId }), 404); untouched();
});
test('exact current controller Iris starts through the ordinary service', async () => {
  const state = reset(), origin = bound(), target = origin.mission.config.target;
  workerReads(origin); select(S.missionAttempts, { missionId }); select(S.missionAttempts, origin); select(S.testRuns); select(S.missions, origin.mission); select(S.missionEvents); select(S.testRuns);
  const value = await call(workerInput({ ...start, target }));
  assert.equal(value.missionAttemptId, attemptId); assert.equal(state.writes.length, 1); assert.equal(state.writes[0].table, S.testRuns);
  assert.equal(state.effects[0].authorize.attemptId, attemptId); assert.equal(state.effects[0].authorize.dispatchId, jobId); assert.ok(state.effects[1].bind); assert.equal(state.selects.length, 0);
});

test('actual returned-case guard denies a malformed handoff before a new controller run', async () => {
  const state = reset(), origin = bound();
  workerReads(origin); select(S.missionAttempts, { missionId }); select(S.missionAttempts, origin); select(S.testRuns); select(S.missions, origin.mission);
  select(S.missionEvents, { payload: { receipt: {}, caseKeys: [`${itemId}:${caseId}`] } });
  await reject(call(workerInput({ ...start, target: origin.mission.config.target })));
  assert.equal(state.writes.length, 0); assert.equal(state.selects.length, 0);
  assert.equal(state.effects.length, 1); assert.equal(state.effects[0].authorize.attemptId, attemptId);
});
test('stale controller mandate cannot use the new-start path', async () => {
  reset(); const origin = bound(); origin.attempt.mandateRevision = 0; workerReads(origin); await reject(call(workerInput())); untouched();
});
test('flagoff and trusted direct service callers retain legacy creation', async () => {
  for (const direct of [false, true]) {
    const state = reset({ flag: direct ? 'true' : 'false' }); select(S.testRuns);
    const value = direct ? await testRunAction(owner, workspace, thread, start) : await call(start);
    assert.equal(value.missionAttemptId, null); assert.equal(state.writes.length, 1); assert.equal(state.selects.length, 0);
  }
});
test('flag transition preserves exact accepted legacy START id and no new binding', async () => {
  for (const legacyRuntime of [runtime, null]) {
    const state = reset({ run: saved({ runtime: legacyRuntime }) }); select(S.testRuns, state.run);
    const value = await call(start); assert.equal(value.id, runId); assert.equal(value.missionAttemptId, null); assert.equal(value.runtime, legacyRuntime); untouched();
  }
});
test('legacy replay may retain an existing mission binding but cannot adopt another', async () => {
  let state = reset(); select(S.testRuns, state.run); select(S.missionTasks, { id: taskId });
  const value = await call({ ...start, mission: { missionId, taskId } }); assert.equal(value.id, runId); untouched();
  const filter = state.reads[1].condition; assert.ok(filter.params.includes(owner)); assert.ok(filter.params.includes(workspace)); assert.ok(filter.params.includes(runtime)); assert.ok(filter.params.includes(JSON.stringify([{ type: 'test', id: runId }])));
  state = reset(); select(S.testRuns, state.run); select(S.missionTasks);
  await reject(call({ ...start, mission: { missionId, taskId } })); untouched();
});
test('changed identity, plan version, target or thread cannot replay a legacy receipt', async () => {
  for (const change of [{ caseId: runId }, { expectedVersion: 2 }, { environment: 'Other environment' }, { target: { environment: 'Other', url: 'https://other.example.test/', revision: '', dataProfile: '', account: '' } }]) {
    const state = reset(); select(S.testRuns, state.run); await reject(call({ ...start, ...change })); untouched();
  }
  for (const change of [{ threadId: requestId }, { runtime: `${runtime}-other` }, { missionAttemptId: attemptId }]) {
    const state = reset({ run: saved(change) }); select(S.testRuns, state.run); await reject(call(start)); untouched();
  }
});
test('unknown request or deleted prior receipt never races into a new legacy START', async () => {
  reset(); select(S.testRuns); await reject(call({ ...start, requestId: runId })); untouched();
});
test('legacy FINISH keeps its original run and result contract during flag transition', async () => {
  const state = reset(); select(S.testRuns, state.run); const value = await call({ action: 'finish', runId, result });
  assert.equal(value.id, runId); assert.equal(value.missionAttemptId, null); assert.deepEqual(value.result, result); assert.equal(state.writes.length, 1); assert.deepEqual(state.effects, ['queue']);
});
test('late originating Iris FINISH remains accepted without a new execution or review', async () => {
  const state = reset({ run: saved({ missionAttemptId: attemptId }) }), origin = bound(); origin.attempt.status = 'cancelled'; origin.attempt.cancelRequestedAt = new Date('2026-10-06T09:59:00Z');
  workerReads(origin, state.run); select(S.missionAttempts, { missionId }); select(S.testRuns, state.run); select(S.missionAttempts, origin);
  const value = await call(workerInput({ action: 'finish', runId, result }));
  assert.equal(value.id, runId); assert.equal(value.executionCurrent, false); assert.equal(state.writes.length, 1); assert.deepEqual(state.effects, ['account-receipt']); assert.equal(state.selects.length, 0);
});
test('legacy LIST and ASSESS remain available and Iris LIST stays attempt scoped', async () => {
  reset(); select(S.testRuns); assert.deepEqual(await call({ action: 'list', itemId }), []); untouched();
  reset(); await call({ action: 'assess', runId }); assert.deepEqual(fixture.state.effects, ['assess', 'queue']); assert.equal(fixture.state.writes.length, 0);
  reset(); const origin = bound(); select(S.browserJobs, { id: jobId, sessionId: 'accepted-iris-session' }); select(S.missionAttempts, origin);
  select(S.testRuns, saved({ missionAttemptId: attemptId }), saved({ id: requestId })); select(S.testRunReviews); select(S.testCaptures);
  const value = await call(workerInput({ action: 'list', itemId })); assert.equal(value.length, 1); assert.equal(value[0].missionAttemptId, attemptId); assert.equal(fixture.state.writes.length, 0);
});
test('model schema cannot supply trusted browser job, executor or gate options', () => {
  const parsed = tool.inputSchema.parse({ ...start, browserJobId: jobId, executorSessionId: 'forged', execution, requireAutonomousStart: false });
  assert.deepEqual(parsed, start);
  assert.match(tool.description, /main chat must use qa_mission with the selected caseKeys/);
  assert.match(tool.description, /START is for the controller-bound Iris executor/);
  assert.match(missionTool.inputSchema.shape.caseKeys.description, /For verify\/regression or other new testing/);
  assert.match(missionTool.inputSchema.shape.caseKeys.description, /For report_only.*without new tests/);
});
test('actual Eve tool forwards trusted Iris identity and returns the concrete denial to V', async () => {
  reset(); const previous = globalThis.fetch, requests = [];
  globalThis.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response(JSON.stringify({ statusMessage: 'Använd qa_mission med valda caseKeys.' }), { status: 409, headers: { 'content-type': 'application/json' } }); };
  try {
    const session = { id: 'accepted-iris-session', auth: { current: { authenticator: 'app', principalId: owner, attributes: { browserThreadId: thread } } } };
    const denial = await tool.execute(start, { session, callId: 'call-1' }); assert.equal(denial.status, 409); assert.match(denial.error, /qa_mission/); assert.equal(requests[0].browserJobId, undefined);
    session.auth.current.attributes.browserJobId = jobId;
    await tool.execute(start, { session, callId: 'call-2' });
    assert.equal(requests[1].browserJobId, jobId); assert.equal(requests[1].executorSessionId, session.id); assert.equal(requests[1].callId, 'call-2'); assert.equal(requests[1].requireAutonomousStart, undefined);
  } finally { globalThis.fetch = previous; }
});
test('actual Eve dynamic instructions route saved plans and retain one-off browser tasks', async () => {
  const current = globalThis.fetch; globalThis.fetch = () => { throw new Error('No profile or network permitted'); };
  try {
    const main = await instructions.events['session.started']({}, { session: { auth: { current: null } } });
    const mission = await missionInstructions.events['turn.started']({}, { session: { auth: { current: null } } });
    for (const definition of [main, mission]) assert.match(definition.content ?? definition.markdown, /saved plan.*itemId:caseId caseKeys/);
    assert.match(main.content ?? main.markdown, /not permission to run test_run START or browser steps in the main chat/);
    assert.match(mission.content ?? mission.markdown, /one-off browser interactions, the ordinary tools remain available/);
    const iris = await missionInstructions.events['turn.started']({}, { session: { auth: { current: { attributes: { browserWorker: 'iris' } } } } });
    assert.equal(iris.content ?? iris.markdown, '');
  } finally { globalThis.fetch = current; }
});
