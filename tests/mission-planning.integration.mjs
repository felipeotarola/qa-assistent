import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { eq, sql } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';
const expectedFromSteps = value => value.steps.map((step, index) => `${index + 1}. ${step.expected}`).join('\n');

// Real isolated PostgreSQL and authored services. Saved page observations and
// model drafts are synthetic. No provider, browser, executor or .env is used.
process.env.PAT_RUNTIME_SCOPE = `${process.env.PAT_RUNTIME_SCOPE}-planning-${randomUUID()}`;
process.env.MISSIONS_ENABLED = 'true'; process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true';
const app = await isolatedApp(), { db, schema } = app;
const control = await import('../server/utils/mission-control.ts');
const attempts = await import('../server/utils/mission-attempts.ts');
const planner = await import('../server/utils/mission-planning.ts');
const { saveItem } = await import('../server/utils/workspaces.ts');
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { buildReviewInput } = await import('../server/utils/result-assessments.ts');
const { runChecks } = await import('../shared/test-run.ts');
const { MISSION_PLANNER_VERSION } = await import('../shared/mission-planning.ts');
const { missionHash } = await import('../server/utils/mission-sources.ts');
const owner = randomUUID(), workspace = randomUUID(), thread = randomUUID(), runtime = process.env.PAT_RUNTIME_SCOPE;
const target = { kind: 'public_url', url: 'https://planning.example.test/' }, usage = { tokens: 240, toolCalls: 0, durationMs: 15 };
const originalFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error('External execution is forbidden in planning integration'); };
const passed = [], failures = [], releases = new Set();
const row = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
const tasks = id => db.select().from(schema.missionTasks).where(eq(schema.missionTasks.missionId, id));
const reject = promise => assert.rejects(promise, error => error.statusCode === 409 || error.statusCode === 403);
async function check(name, fn) { try { await fn(); passed.push(name); } catch (error) { failures.push({ name, message: error.message, stack: error.stack }); console.error(`FAILED ${name}: ${error.message}`); } }
const page = (text = 'Recept finns här. Sök recept.') => ({ title: 'Observerad startsida', text, links: [{ url: `${target.url}recept`, label: 'Recept' }, { url: 'https://outside.example.test/', label: 'Extern' }] });
async function source(mission, extra = {}) {
  return saveItem(owner, workspace, { title: 'Sparad webbsida', content: { kind: 'text', text: JSON.stringify(page()) }, threadId: thread }, db,
    { provenance: { version: 1, origin: 'tool', producer: 'research-page', sourceType: 'research', observedAt: new Date().toISOString(), url: mission.config.target.url, ...extra } });
}
async function fixture({ selected = [], intent = 'explore' } = {}) {
  const mission = await control.acceptMission(owner, workspace, thread, { requestId: randomUUID(), intent, goal: 'Testa startsida, navigation och sökning', target, caseKeys: selected });
  const research = await source(mission);
  const task = await db.transaction(async tx => {
    await control.lockMission(tx, mission.id);
    return control.addMissionTask(tx, mission, { operationId: `planning:${mission.planRevision}`, title: 'Planera utifrån sparat underlag', spec: { kind: 'planning', sourceRefs: [{ type: 'research', id: research.id }] } });
  });
  const claimed = await attempts.claimMission(mission.id); assert.ok(claimed);
  const lease = attempts.leaseIdentity(claimed), reservation = await attempts.reserveMissionAttempt(lease, task.id, { usesModel: !selected.length });
  assert.equal(reservation.status, 'reserved');
  return { mission, task, research, lease, attempt: reservation.attempt };
}
async function prepare(f) { const value = await planner.prepareMissionPlanning(f.lease, f.attempt.id); assert.equal(value.status, 'prepared'); return value; }
function mockModel(input) {
  return { schemaVersion: 1, title: 'Avgränsad webbplan', summary: 'Observerad startsida och navigation.', cases: [{ title: 'Huvudnavigation', entryUrl: input.sources[0].url,
    steps: [{ action: 'Klicka på länken Recept.', expected: 'Receptsidan öppnas.' }],  basis: { kind: 'exploratory', quote: '', source: { itemId: input.sources[0].itemId, version: input.sources[0].version } } }], limitations: [] };
}
const persist = (f, prepared, draft = mockModel(prepared.input), measure = usage) => planner.persistMissionPlanning(f.lease, f.attempt.id, prepared.fingerprint, draft, measure);
const planCount = async () => (await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, workspace))).filter(item => item.content.kind === 'test_plan').length;
async function hold(content, f) {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  releases.add(release);
  const pending = app.sql.begin(async connection => {
    const [pid] = await connection`select pg_backend_pid() as pid`;
    if (content) await connection`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspace}`},0))`;
    else await connection`select id from pat_mission_tasks where id=${f.task.id} for update`;
    enter(pid.pid); await gate;
  });
  const pid = await entered;
  return { pid, async release() { release(); releases.delete(release); await pending; } };
}
async function waitForBlockedBy(pid) {
  for (let i = 0; i < 100; i++) {
    const rows = await app.sql`select pid from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`;
    if (rows.length) return; await delay(10);
  }
  throw new Error('Expected an actual PostgreSQL lock waiter');
}
try {
  assert.equal(process.env.GRUNDEN_API_TOKEN, '');
  await db.insert(schema.user).values({ id: owner, name: 'Planning fixture', email: `${owner}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspace, userId: owner, name: 'Planning fixture' });
  await db.insert(schema.threads).values({ id: thread, userId: owner, workspaceId: workspace, title: 'Planning fixture' });

  await check('actual saved research yields bounded trusted input and atomically persisted plan/task/receipt', async () => {
    const f = await fixture(), prepared = await prepare(f), candidate = mockModel(prepared.input), count = await planCount();
    assert.deepEqual(prepared.input.browserExecution, { version: 1, readOnly: true, agentHttpMethods: ['GET', 'HEAD', 'OPTIONS'], authenticationControls: 'inspect-only', authenticationAccess: 'human-takeover' });
    assert.equal(prepared.input.maxCases, 4); assert.equal(prepared.input.sources[0].links.length, 1); assert.equal(prepared.input.sources[0].url, target.url);
    candidate.limitations = ['Körkontext: tillgänglig åtkomst är okänd; faktisk spärr lämnar originalkravet oprövat.'];
    const invalid = structuredClone(candidate); invalid.cases[0].preconditions = 'Inga särskilda förutsättningar.';
    await assert.rejects(persist(f, prepared, invalid), error => error.diagnostic?.code === 'output_schema_invalid'); assert.equal(await planCount(), count);
    assert.equal((await row(schema.missionAttempts, f.attempt.id)).receipt, null);
    const oldExpected = structuredClone(candidate); oldExpected.cases[0].expected = 'Ett separat motstridigt krav';
    await assert.rejects(persist(f, prepared, oldExpected), error => error.diagnostic?.code === 'output_schema_invalid');
    const tooLong = structuredClone(candidate);
    tooLong.cases[0].steps = Array.from({ length: 9 }, () => ({ action: 'A', expected: 'E'.repeat(600) }));
    await assert.rejects(persist(f, prepared, tooLong), error => error.diagnostic?.code === 'output_schema_invalid');
    assert.equal(await planCount(), count); assert.equal((await row(schema.missionAttempts, f.attempt.id)).receipt, null);
    const result = await persist(f, prepared, candidate), plan = await row(schema.workspaceItems, result.itemId);
    assert.equal(await planCount(), count + 1); assert.equal(plan.content.cases[0].basis.kind, 'exploratory'); assert.equal(plan.provenance.producer, 'agent-authored');
    assert.deepEqual(plan.content.sources, [{ itemId: f.research.id, version: 1 }]); assert.equal(result.caseKeys[0], `${plan.id}:${plan.content.cases[0].id}`);
    assert.ok(plan.content.summary.includes(candidate.limitations[0]));
    assert.ok(result.limitations.includes(candidate.limitations[0]));
    assert.equal(plan.content.cases[0].preconditions, '');
    assert.equal(plan.content.cases[0].checksVersion, 2);
    assert.equal(plan.content.cases[0].expected, expectedFromSteps(candidate.cases[0]));
    const current = await row(schema.missions, f.mission.id), children = await tasks(f.mission.id), browser = children.find(t => t.operationId === 'browser:1:0');
    assert.deepEqual(current.config.caseKeys, result.caseKeys); assert.deepEqual(current.config.criteria[0].delivery.caseKeys, result.caseKeys); assert.equal(current.planRevision, 1);
    assert.equal(browser.state, 'pending'); assert.deepEqual(browser.spec.planVersions, result.planVersions); assert.deepEqual(browser.dependsOn, [f.task.id]);
    assert.equal((await row(schema.missionTasks, f.task.id)).state, 'completed'); assert.equal((await row(schema.missionAttempts, f.attempt.id)).status, 'completed');
    assert.deepEqual((await row(schema.missionAttempts, f.attempt.id)).usage, usage);
    assert.equal((await planner.prepareMissionPlanning(f.lease, f.attempt.id)).status, 'completed');
    assert.deepEqual(await persist(f, prepared, candidate), result); assert.equal(await planCount(), count + 1);
    await reject(persist(f, prepared, { ...candidate, summary: 'Changed replay' }));
  });
  await check('parallel publication has one stable material identity and one next task', async () => {
    const f = await fixture(), prepared = await prepare(f), count = await planCount();
    const [a, b] = await Promise.all([persist(f, prepared), persist(f, prepared)]); assert.deepEqual(a, b); assert.equal(await planCount(), count + 1);
    assert.equal((await tasks(f.mission.id)).filter(t => t.spec.kind === 'browser_tests').length, 1);
  });
  await check('self-contained expected values survive plan publication and review assembly without promoting discovery into execution evidence', async () => {
    const f = await fixture(), prepared = await prepare(f), candidate = mockModel(prepared.input);
    candidate.cases[0].steps = [{ action: 'Inspektera den laddade startsidan.', expected: 'Texten Recept finns här och länken Recept visas.' }];

    assert.equal(MISSION_PLANNER_VERSION, '21');
    assert.equal(prepared.fingerprint, missionHash({ plannerVersion: '21', input: prepared.input }));
    assert.notEqual(prepared.fingerprint, missionHash({ plannerVersion: '4', input: prepared.input }));
    const published = await persist(f, prepared, candidate), plan = await row(schema.workspaceItems, published.itemId), savedCase = plan.content.cases[0];
    const browser = (await tasks(f.mission.id)).find(t => t.operationId === 'browser:1:0');
    const reserved = await attempts.reserveMissionAttempt(f.lease, browser.id, { resource: { kind: 'browser', poolKey: `planning:${randomUUID()}` } });
    assert.equal(reserved.status, 'reserved');
    const execution = await attempts.markMissionDispatch(f.lease, reserved.attempt.id), executionOptions = { execution: { attemptId: execution.id, dispatchId: execution.dispatchId } };
    const started = await testRunAction(owner, workspace, thread, { action: 'start', requestId: randomUUID(), itemId: plan.id, caseId: savedCase.id, expectedVersion: 1,
      environment: f.mission.config.target.environment, target: f.mission.config.target, mission: { missionId: f.mission.id, taskId: browser.id } }, executionOptions);
    // Synthetic executor reports no observation. Actual service persistence and
    // review assembly must not invent proof from the real saved discovery item.
    const checks = runChecks(savedCase).map(check => ({ id: check.id, status: 'unverified', actual: 'Ingen utförd observation i detta kontraktsprov.' }));
    await testRunAction(owner, workspace, thread, { action: 'finish', runId: started.id, result: { schemaVersion: 2, outcome: 'inconclusive', actual: 'Ingen utförd observation.',
      checks, remaining: checks.map(check => ({ checkId: check.id, reason: 'Observation behövs.' })), observations: [], evidenceItemIds: [] } }, executionOptions);
    const review = await buildReviewInput(workspace, started.id);
    assert.deepEqual(review.basis.source, { itemId: f.research.id, version: 1 });
    assert.deepEqual(review.requirements, runChecks(savedCase));
    assert.equal(review.requirements.find(check => check.id === 'expected').requirement, expectedFromSteps(candidate.cases[0]));
    assert.equal(review.evidence.length, 0);
    assert.equal(review.reportedResult.outcome, 'inconclusive');
    assert.equal((await row(schema.workspaceItems, f.research.id)).version, 1);
  });
  await check('large observed link URLs are bounded deterministically before any model call', async () => {
    const f = await fixture(), refs = [];
    for (let i = 0; i < 4; i++) {
      const saved = await saveItem(owner, workspace, { title: `Large source ${i}`, content: { kind: 'text', text: JSON.stringify({ title: 'Navigation', text: 'x'.repeat(14000),
        links: Array.from({ length: 40 }, (_, index) => ({ url: `${target.url}page/${index}?q=${'a'.repeat(1800)}`, label: `Observed ${index}` })) }) } }, db,
      { provenance: { version: 1, origin: 'tool', producer: 'research-page', observedAt: new Date().toISOString(), url: target.url } });
      refs.push({ type: 'research', id: saved.id });
    }
    await db.update(schema.missionTasks).set({ spec: { kind: 'planning', sourceRefs: refs } }).where(eq(schema.missionTasks.id, f.task.id));
    const first = await prepare(f), replay = await prepare(f);
    assert.ok(JSON.stringify(first.input).length <= 100000); assert.equal(first.fingerprint, replay.fingerprint);
    assert.ok(first.input.sources.every(s => s.limited)); assert.ok(first.input.limitations.some(note => note.includes('kontextbudget')));
  });
  await check('selected originals are preserved; unsupported cases remain explicit delivery gaps', async () => {
    const cases = ['browser', 'manual', 'api'].map(type => ({ id: randomUUID(), type, title: `${type} original`, preconditions: 'Original prerequisite', steps: '1. Original action', expected: 'Original expected behavior' }));
    const plan = await saveItem(owner, workspace, { title: 'Original', content: { kind: 'test_plan', summary: '', sources: [], cases } });
    assert.deepEqual(plan.content.cases, cases.map(testCase => ({ ...testCase, checksVersion: 2 })));
    assert.ok(cases.every(testCase => !Object.hasOwn(testCase, 'checksVersion')), 'Saving must not stamp the caller input');
    const f = await fixture({ selected: cases.map(c => `${plan.id}:${c.id}`) }), prepared = await prepare(f), count = await planCount();
    assert.equal(prepared.input.sources.length, 0); assert.deepEqual(prepared.input.selectedCases.map(c => c.testCase), plan.content.cases);
    const result = await persist(f, prepared, null, { tokens: 0, toolCalls: 0, durationMs: 0 });
    assert.equal(result.itemId, null); assert.equal(await planCount(), count); assert.deepEqual((await row(schema.workspaceItems, plan.id)).content.cases, plan.content.cases);
    assert.equal(result.blockedCases.length, 2); assert.equal(result.caseKeys.length, 3);
    const children = await tasks(f.mission.id); assert.equal(children.find(t => t.operationId === 'browser:1:unsupported').state, 'blocked');
    assert.deepEqual(children.find(t => t.operationId === 'browser:1:0').spec.caseKeys, [result.caseKeys[0]]);
  });
  await check('source edits invalidate prepared input without producing orphaned material', async () => {
    const f = await fixture(), prepared = await prepare(f), count = await planCount();
    await saveItem(owner, workspace, { id: f.research.id, expectedVersion: 1, title: 'Edited', content: { kind: 'text', text: JSON.stringify(page('Changed source')) } });
    await reject(persist(f, prepared)); assert.equal(await planCount(), count); assert.equal((await tasks(f.mission.id)).filter(t => t.spec.kind === 'browser_tests').length, 0);
  });
  await check('selected case edits invalidate preparation and are never silently rewritten', async () => {
    const testCase = { id: randomUUID(), type: 'browser', title: 'Original', preconditions: '', steps: 'Click', expected: 'Visible' };
    const plan = await saveItem(owner, workspace, { title: 'Existing', content: { kind: 'test_plan', summary: '', sources: [], cases: [testCase] } });
    const f = await fixture({ selected: [`${plan.id}:${testCase.id}`] }), prepared = await prepare(f);
    await saveItem(owner, workspace, { id: plan.id, expectedVersion: 1, title: 'Edited', content: { ...plan.content, cases: [{ ...testCase, expected: 'Different' }] } });
    await reject(persist(f, prepared, null)); assert.equal((await row(schema.workspaceItems, plan.id)).version, 2);
  });
  await check('unknown or historical observations cannot seed autonomous test expectations', async () => {
    for (const provenance of [null, { version: 1, origin: 'agent', producer: 'agent-authored', observedAt: null }, { version: 1, origin: 'tool', producer: 'research-page', observedAt: new Date(0).toISOString(), url: target.url }]) {
      const f = await fixture(); await db.update(schema.workspaceItems).set({ provenance }).where(eq(schema.workspaceItems.id, f.research.id)); await reject(prepare(f));
    }
  });
  await check('cancel, runtime mismatch and foreign attempts cannot publish', async () => {
    const a = await fixture(), prepared = await prepare(a), b = await fixture(), count = await planCount();
    await reject(planner.persistMissionPlanning(a.lease, b.attempt.id, prepared.fingerprint, mockModel(prepared.input), usage));
    process.env.PAT_RUNTIME_SCOPE = `${runtime}-other`; try { await reject(persist(a, prepared)); } finally { process.env.PAT_RUNTIME_SCOPE = runtime; }
    await control.controlMission(owner, workspace, thread, { action: 'cancel', missionId: a.mission.id, requestId: randomUUID(), expectedMandateRevision: a.mission.mandateRevision });
    await reject(persist(a, prepared)); assert.equal(await planCount(), count);
  });
  await check('planner cannot create execution in report-only mission', async () => {
    const f = await fixture(), report = await control.acceptMission(owner, workspace, thread, { requestId: randomUUID(), intent: 'report_only', goal: 'Sammanställ sparat underlag', target: null, sourceRefs: [{ type: 'research', id: f.research.id }] });
    const claimed = await attempts.claimMission(report.id); assert.ok(claimed);
    await reject(planner.prepareMissionPlanning(attempts.leaseIdentity(claimed), f.attempt.id));
  });
  await check('unknown model usage remains unknown instead of becoming free', async () => {
    const f = await fixture(), prepared = await prepare(f); await persist(f, prepared, mockModel(prepared.input), { tokens: null, toolCalls: 0, durationMs: null });
    assert.equal((await row(schema.missionAttempts, f.attempt.id)).usage.tokens, null);
  });
  for (const content of [true, false]) await check(content ? 'lease expiry during content-lock wait denies publication' : 'expiry after material insert rolls back plan, task and receipt', async () => {
    const f = await fixture(), prepared = await prepare(f), count = await planCount(), held = await hold(content, f);
    try {
      await db.update(schema.missions).set({ leaseUntil: sql`clock_timestamp()+interval '250 milliseconds'` }).where(eq(schema.missions.id, f.mission.id));
      const pending = persist(f, prepared); pending.catch(() => {});
      await waitForBlockedBy(held.pid); await delay(300); await held.release(); await reject(pending);
      assert.equal(await planCount(), count); assert.equal((await row(schema.missionTasks, f.task.id)).state, 'running'); assert.equal((await row(schema.missionAttempts, f.attempt.id)).receipt, null);
      assert.equal((await tasks(f.mission.id)).filter(t => t.spec.kind === 'browser_tests').length, 0);
    } finally { await held.release(); }
  });
  await check('published frozen plan version prevents executor adopting later edits', async () => {
    const f = await fixture(), prepared = await prepare(f), result = await persist(f, prepared), plan = await row(schema.workspaceItems, result.itemId);
    const browser = (await tasks(f.mission.id)).find(t => t.operationId === 'browser:1:0');
    const reservation = await attempts.reserveMissionAttempt(f.lease, browser.id, { resource: { kind: 'browser', poolKey: `planning:${randomUUID()}` } }); assert.equal(reservation.status, 'reserved');
    const execution = await attempts.markMissionDispatch(f.lease, reservation.attempt.id);
    await saveItem(owner, workspace, { id: plan.id, expectedVersion: 1, title: plan.title, content: { ...plan.content, summary: 'Edited after planning' } });
    await reject(testRunAction(owner, workspace, thread, { action: 'start', requestId: randomUUID(), itemId: plan.id, caseId: plan.content.cases[0].id, expectedVersion: 2,
      environment: f.mission.config.target.environment, target: f.mission.config.target, mission: { missionId: f.mission.id, taskId: browser.id } }, { execution: { attemptId: execution.id, dispatchId: execution.dispatchId } }));
  });
  console.log(JSON.stringify({ status: failures.length ? 'failed' : 'passed', checks: passed.length, failures: failures.map(({ name, message }) => ({ name, message })), database: 'actual isolated PostgreSQL', model: 'synthetic structured drafts only', externalExecution: 'none' }));
  if (failures.length) { for (const failure of failures) console.error(failure.stack); process.exitCode = 1; }
} finally {
  for (const release of releases) release();
  globalThis.fetch = originalFetch; process.env.PAT_RUNTIME_SCOPE = runtime;
  try { await db.delete(schema.user).where(eq(schema.user.id, owner)); } finally { await app.close(); }
}
