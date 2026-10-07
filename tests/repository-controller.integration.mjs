import { reportFixtureObservations } from './helpers/report-check-fixture.mjs';
// Actual controller, repository adapter, admission, report validator/persistence
// and PostgreSQL. Linux HTTP and the report model are explicit synthetic doubles.
// This does not claim physical execution or model acceptance.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';
import { executionHash } from '../infra/execution/admission.mjs';
import { validate } from '../infra/repo-runner/runner.mjs';

process.env.REPO_RUNNER_URL = `http://${randomUUID()}.repository-controller.fixture.invalid`;
process.env.REPO_RUNNER_KEY = 'repository-controller-fixture-only';
const h = await controllerFixture(), { db, schema } = h;
const repository = await import('../server/utils/repositories.ts');
const admission = await import('../server/utils/mission-executor-admission.ts');
const jobs = new Map(), contexts = new Map(), transport = [], checks = [], failures = [];
const sha = 'a'.repeat(40);
const target = { kind: 'repository', url: 'https://github.com/fixture/repository', ref: 'main' };
async function fixture(options = {}) {
  const f = await h.fixture({ target: options.target ?? target, goal: 'Testa repot och rapportera utförda kontroller, även när de hittar fel.' });
  Object.assign(f, { loseResponse: false, hold: false, cleanup: true, ambiguous: false, unavailable: false, ...options }); contexts.set(f.id, f); return f;
}
function finish(job, f, status = job.mode === 'inspect' ? 'review' : 'failed') {
  const at = new Date().toISOString(); job.status = status; job.revision++; job.updatedAt = at; job.finishedAt = at;
  const commit = f.commit ?? sha;
  job.commit = commit; job.cleanup = { resourceId: job.id, confirmed: f.cleanup, observedAt: at };
  const scripts = f.scripts ?? { test: 'node --test' }, selectedScript = ['test', 'test:unit', 'typecheck', 'lint'].find(key => Object.hasOwn(scripts, key)) ?? 'auto';
  job.package = { name: 'fixture', scripts, packageManager: 'npm', lock: true };
  job.projects = f.projects ?? [{ directory: '.', kind: 'node' }];
  job.plan = f.ambiguous ? null : { directory: '.', runtime: 'node22', operationKind: job.mode === 'inspect' ? 'inspect' : 'test', selectedScript, install: [['npm', 'ci']], command: ['npm', '--ignore-scripts', 'run', selectedScript, '--'] };
  job.testExitCode = job.mode === 'inspect' ? null : 1;
  job.message = job.mode === 'inspect' ? 'Repository inspected; no tests executed.' : 'Test command completed with exit code 1.';
  job.logs = job.mode === 'inspect' ? `Observed commit ${commit}; package contains test script.` : `Command npm run test\nCommit ${commit}\nFAIL expected 2 but got 3\nTest exit code 1`;
  return job;
}
globalThis.fetch = async (url, options = {}) => {
  assert.ok(String(url).startsWith(process.env.REPO_RUNNER_URL), 'Unexpected network transport');
  const parsed = new URL(url), method = options.method ?? 'GET'; transport.push({ method, path: parsed.pathname });
  if (parsed.pathname === '/health') return Response.json({ autonomousExecution: { version: 1, admission: true, frozenCommit: true } });
  if (method === 'GET') {
    const ids = (parsed.searchParams.get('ids') || '').split(',');
    if (ids.some(id => contexts.get(jobs.get(id)?.execution.missionId)?.unavailable)) throw new Error('Synthetic executor unavailable');
    return Response.json({ jobs: ids.flatMap(id => jobs.has(id) ? [jobs.get(id)] : []) });
  }
  if (parsed.pathname.endsWith('/cancel')) {
    const job = jobs.get(parsed.pathname.split('/')[2]); assert.ok(job); const f = contexts.get(job.execution.missionId);
    if (f.unavailable) throw new Error('Synthetic stop acknowledgement lost');
    return Response.json(finish(job, f, 'cancelled'));
  }
  assert.equal(parsed.pathname, '/jobs');
  const input = validate(JSON.parse(options.body)), f = contexts.get(input.execution.missionId); assert.ok(f);
  const run = await h.row(schema.repositoryRuns, input.id); assert.ok(run, 'Physical intent is persisted before external start');
  assert.equal(run.config.execution.attemptId, input.execution.attemptId);
  const task = await h.row(schema.missionTasks, input.execution.taskId); assert.ok(task.sources.some(source => source.type === 'repository' && source.id === input.id));
  await admission.admitMissionExecutor({ execution: input.execution, resourceId: input.id, operationId: 'job', kind: `repository.${input.mode}`, payloadHash: executionHash({ fingerprint: executionHash(input) }) });
  if (!jobs.has(input.id)) {
    const at = new Date().toISOString(); const job = { ...input, fingerprint: executionHash(input), revision: 1, status: 'running', message: 'Synthetic executor running', logs: '', commit: null, package: null, testExitCode: null, createdAt: at, updatedAt: at, finishedAt: null };
    jobs.set(input.id, f.hold ? job : finish(job, f));
  } else assert.equal(jobs.get(input.id).fingerprint, executionHash(input));
  if (f.loseResponse) { f.loseResponse = false; throw new Error('Synthetic response lost after committed physical admission'); }
  return Response.json(jobs.get(input.id));
};
// Only the model is synthetic. Every citation is obtained through the authored
// saved-evidence reader, then the real delivery/evidence validator must accept it.
h.scripts.writeMissionReport = async (snapshot, read, _signal, options) => {
  await options.beforeModel();
  const findings = [];
  for (const criterion of snapshot.config.criteria) {
    const delivered = snapshot.delivery.criteria.find(value => value.criterionId === criterion.id)?.complete;
    const refs = new Map(snapshot.tasks.filter(task => task.criterionIds.includes(criterion.id)).flatMap(task => task.sources.flatMap(source => source.evidence)).map(evidence => [evidence.id, evidence]));
    const readIds = [];
    for (const evidence of refs.values()) {
      const result = await read(evidence.id);
      if (!result.unavailable && !result.limited && result.text) readIds.push(evidence.id);
    }
    const supported = delivered && readIds.length > 0;
    findings.push({ criterionId: criterion.id, verdict: supported ? 'supported' : 'needs_evidence',
      conclusion: supported ? 'The identified test command ran on the inspected commit and reported exit 1. This supports completed QA execution, not a working product.' : 'The scoped command was not fully verified.',
      evidenceIds: readIds, observations: reportFixtureObservations(snapshot, criterion.id, readIds, 'The identified test command ran on the inspected commit and reported exit 1. This supports completed QA execution, not a working product.'), nextStep: supported ? '' : 'Resolve the recorded execution blockage.' });
  }
  return { draft: { summary: 'Synthetic report: repository execution results are saved, including the negative command result when present.', findings, limitations: ['Synthetic transport/model fixture; no physical Linux execution claimed.'] }, usage: { inputTokens: 20, outputTokens: 20, totalTokens: 40, toolCalls: findings.reduce((n, f) => n + f.evidenceIds.length, 0), steps: 1 } };
};
async function check(name, fn) { try { await fn(); checks.push(name); console.log(`PASS ${name}`); } catch (error) { failures.push({ name, message: error.message, stack: error.stack }); console.error(`FAIL ${name}: ${error.message}`); } }
const dispatches = f => [...jobs.values()].filter(job => job.execution.missionId === f.id);
const starts = f => dispatches(f).length;
async function reserveDiscovery(f) {
  const current = await h.attempts.claimMission(f.id); assert.ok(current); const lease = h.attempts.leaseIdentity(current);
  const task = (await h.state(f)).tasks.find(task => task.spec.kind === 'discovery');
  const result = await h.attempts.reserveMissionAttempt(lease, task.id, { usesModel: false, resource: { kind: 'otto', poolKey: process.env.REPO_RUNNER_URL } }); assert.equal(result.status, 'reserved');
  await h.attempts.releaseMissionLease(lease, 0); return result.attempt;
}
async function inspectedDiscovery(f) {
  const reserved = await reserveDiscovery(f);
  const leaseMission = await h.attempts.claimMission(f.id), lease = h.attempts.leaseIdentity(leaseMission);
  await h.attempts.markMissionDispatch(lease, reserved.id);
  const adapter = await import('../server/utils/mission-repository.ts');
  await adapter.dispatchMissionRepository(lease, reserved.id);
  await db.update(schema.missionAttempts).set({ status: 'completed', finishedAt: new Date() }).where(eq(schema.missionAttempts.id, reserved.id));
  await db.update(schema.missionTasks).set({ state: 'completed' }).where(eq(schema.missionTasks.id, reserved.taskId));
  await h.attempts.releaseMissionResource(reserved.id, reserved.dispatchId, true);
  await h.attempts.releaseMissionLease(lease, 0);
  return reserved;
}
async function selectInspectedSurface(f, prepare = false) {
  const { reconcileRepositoryDiscovery } = await import('../server/utils/mission-repository-plan.ts');
  const { planMissionEnvironment } = await import('../server/utils/mission-environment-plan.ts');
  return db.transaction(async tx => {
    await h.control.lockMission(tx, f.id);
    const [mission] = await tx.select().from(schema.missions).where(eq(schema.missions.id, f.id));
    const tasks = await tx.select().from(schema.missionTasks).where(eq(schema.missionTasks.missionId, f.id));
    const discovery = tasks.find(task => task.spec.kind === 'discovery');
    const decision = await reconcileRepositoryDiscovery(tx, mission, discovery);
    if (prepare && decision.state === 'requires_browser') await planMissionEnvironment(tx, mission, discovery, decision.inspectionId, decision.commit);
    return decision;
  });
}
try {
  await check('controller drives inspect → pinned test → read evidence → one saved report, including a negative command result', async () => {
    const f = await fixture(), closed = await h.settle(f);
    assert.equal(closed.mission.lifecycle, 'closed'); assert.equal(closed.mission.closureReason, 'investigated');
    assert.equal(closed.reports.length, 1); assert.equal(closed.reports[0].document.partial, false); assert.equal(closed.reports[0].document.findings[0].verdict, 'supported');
    assert.ok(closed.reports[0].document.findings[0].observations.some(observation => /exit 1/.test(observation.text)));
    assert.ok(closed.reports[0].document.findings[0].observations.every(observation => observation.evidenceIds.every(id => closed.reports[0].document.findings[0].evidenceIds.includes(id)))); assert.equal(closed.claims.length, 0);
    assert.equal(starts(f), 2); const test = dispatches(f).find(job => job.mode === 'test'); assert.equal(test.expectedCommit, sha); assert.equal(test.testExitCode, 1);
    assert.deepEqual(closed.mission.config.criteria[0].delivery.sourceRefs, [{ type: 'repository', id: test.id }]);
    assert.equal(closed.reports[0].document.tests.length, 0, 'Command results must not fabricate testcase counts');
    assert.equal(closed.mission.config.goal, f.config.goal);
  });
  await check('acknowledgement loss and controller restart recover original dispatch without another job', async () => {
    const f = await fixture({ loseResponse: true }); await h.pass(f);
    const interrupted = await h.state(f), original = interrupted.attempts.find(attempt => attempt.kind === 'discovery');
    assert.equal(original.status, 'dispatch_unknown'); assert.equal(starts(f), 1); assert.equal((await h.row(schema.repositoryRuns, original.dispatchId)).job, null);
    // Drop transport object identity as a process restart would; only the saved
    // immutable job/DB state remains. No callback or chat continuation is driven.
    for (const [id, job] of jobs) jobs.set(id, JSON.parse(JSON.stringify(job)));
    const closed = await h.settle(f); assert.equal(closed.mission.lifecycle, 'closed'); assert.equal(starts(f), 2);
    assert.equal(closed.attempts.filter(attempt => attempt.kind === 'discovery').length, 1); assert.equal(closed.attempts.find(attempt => attempt.kind === 'discovery').id, original.id); assert.equal(closed.reports.length, 1);
  });
  await check('restart after reservation starts the exact persisted attempt, never a replacement', async () => {
    const f = await fixture(), reserved = await reserveDiscovery(f); assert.equal(starts(f), 0);
    const closed = await h.settle(f); assert.equal(closed.mission.lifecycle, 'closed'); assert.equal(closed.attempts.find(attempt => attempt.kind === 'discovery').id, reserved.id); assert.equal(dispatches(f)[0].id, reserved.dispatchId); assert.equal(starts(f), 2);
  });
  await check('uncertain cleanup retains global claim while a partial report completes, then late cleanup releases it', async () => {
    const f = await fixture({ cleanup: false }), closed = await h.settle(f);
    assert.equal(starts(f), 1); assert.equal(closed.mission.lifecycle, 'closed'); assert.equal(closed.reports[0].document.partial, true); assert.equal(closed.claims.length, 1); assert.equal(closed.claims[0].state, 'uncertain');
    const job = dispatches(f)[0]; job.cleanup.confirmed = true; job.revision++; await repository.saveRepositoryJob(job);
    await h.reconcileClosedMissionResources(); assert.equal((await h.state(f)).claims.length, 0); assert.equal(starts(f), 1);
  });
  await check('pause revokes new effects while cancellation status and confirmed cleanup remain available', async () => {
    const f = await fixture({ hold: true }); await h.pass(f); const before = await h.state(f), original = before.attempts[0];
    await h.operate(f, 'pause'); await h.pass(f);
    const paused = await h.state(f); assert.equal(paused.mission.lifecycle, 'paused'); assert.equal(paused.claims.length, 0); assert.equal(starts(f), 1); assert.equal(dispatches(f)[0].status, 'cancelled');
    await assert.rejects(admission.admitMissionExecutor({ execution: dispatches(f)[0].execution, resourceId: original.dispatchId, operationId: 'late-command', kind: 'repository.command', payloadHash: 'a'.repeat(64) }));
    await h.pass(f); assert.equal(starts(f), 1);
  });
  await check('old completed discovery after a same-plan mandate change cannot deadlock independent final reporting or create a check', async () => {
    const f = await fixture(), reserved = await reserveDiscovery(f);
    // Fault boundary: original worker and attempt finished before graph planning,
    // followed by a same-plan authorization-epoch change (as consent expansion
    // does). Actual pause/resume instead creates an explicitly renewed plan.
    const leaseMission = await h.attempts.claimMission(f.id), lease = h.attempts.leaseIdentity(leaseMission);
    await h.attempts.markMissionDispatch(lease, reserved.id);
    const adapter = await import('../server/utils/mission-repository.ts'); await adapter.dispatchMissionRepository(lease, reserved.id);
    await db.update(schema.missionAttempts).set({ status: 'completed', finishedAt: new Date() }).where(eq(schema.missionAttempts.id, reserved.id));
    await db.update(schema.missionTasks).set({ state: 'completed' }).where(eq(schema.missionTasks.id, reserved.taskId));
    await h.attempts.releaseMissionResource(reserved.id, reserved.dispatchId, true); await h.attempts.releaseMissionLease(lease, 0);
    const before = (await h.state(f)).mission;
    await db.update(schema.missions).set({ mandateRevision: before.mandateRevision + 1, fence: before.fence + 1 }).where(eq(schema.missions.id, f.id));
    const closed = await h.settle(f); assert.equal(closed.mission.lifecycle, 'closed'); assert.equal(starts(f), 1); assert.equal(closed.reports[0].document.partial, true);
    assert.equal(closed.tasks.find(task => task.spec.kind === 'discovery').state, 'blocked'); assert.equal(closed.tasks.filter(task => task.spec.kind === 'repository_check').length, 0);
  });
  await check('explicit resume of a finished repository mission verifies its new check rather than retaining stale delivery identities', async () => {
    const f = await fixture(), first = await h.settle(f); assert.equal(first.reports[0].document.partial, false);
    const originalSnapshot = await h.row(schema.missionSnapshots, first.reports[0].snapshotId), originalReport = first.reports[0].document;
    const oldCheck = dispatches(f).find(job => job.mode === 'test'); f.commit = 'b'.repeat(40); await h.operate(f, 'resume');
    const resumed = await h.settle(f), latest = resumed.reports.sort((a, b) => b.createdAt - a.createdAt)[0];
    assert.equal(resumed.mission.lifecycle, 'closed'); assert.equal(starts(f), 4); assert.equal(latest.document.partial, false);
    const newCheck = dispatches(f).find(job => job.mode === 'test' && job.id !== oldCheck.id);
    assert.equal(newCheck.expectedCommit, f.commit); assert.equal(newCheck.commit, f.commit);
    assert.deepEqual(resumed.mission.config.criteria[0].delivery.sourceRefs, [{ type: 'repository', id: newCheck.id }]);
    assert.deepEqual(await h.row(schema.missionSnapshots, originalSnapshot.id), originalSnapshot);
    assert.deepEqual((await h.row(schema.missionReports, first.reports[0].id)).document, originalReport);
  });
  await check('ambiguous monorepo produces an honest partial report without treating inspection as a test', async () => {
    const f = await fixture({ ambiguous: true }), closed = await h.settle(f);
    assert.equal(starts(f), 1); assert.equal(closed.mission.lifecycle, 'closed'); assert.equal(closed.mission.closureReason, 'blocked');
    assert.equal(closed.reports[0].document.partial, true); assert.equal(closed.reports[0].document.tests.length, 0);
    assert.equal(closed.tasks.filter(task => task.spec.kind === 'repository_check').length, 0);
    assert.match(closed.tasks.find(task => task.spec.kind === 'planning').blockedReason, /Vilken projektkatalog/);
  });
  await check('resume never rewrites explicitly changed criterion text or delivery source identities', async () => {
    for (const change of ['text', 'sourceRefs']) {
      const f = await fixture(), first = await h.settle(f), initial = first.mission.config;
      const edited = structuredClone(initial.criteria[0]);
      if (change === 'text') edited.text = 'Explicit user requirement: preserve this custom scope.';
      else edited.delivery.sourceRefs.push({ type: 'repository', id: dispatches(f).find(job => job.mode === 'inspect').id });
      // Fault/user-edit fixture. Exact hash provenance must not adopt a modified
      // contract even if it keeps the server's old criterion ID and prose.
      await db.update(schema.missions).set({ config: { ...initial, criteria: [edited] } }).where(eq(schema.missions.id, f.id));
      await h.operate(f, 'resume'); const resumed = await h.settle(f);
      assert.deepEqual(resumed.mission.config.criteria, [edited]); assert.equal(resumed.mission.config.goal, initial.goal);
      assert.equal(resumed.reports.sort((a, b) => b.createdAt - a.createdAt)[0].document.partial, true);
    }
  });
  await check('executor outage past deadline ends logical work honestly and retains an unconfirmed physical claim', async () => {
    const f = await fixture({ hold: true }); await h.pass(f); const initial = await h.state(f); f.unavailable = true;
    const deadline = new Date(Date.now() - 130000);
    await db.update(schema.missionAttempts).set({ deadlineAt: deadline }).where(eq(schema.missionAttempts.id, initial.attempts[0].id));
    await db.update(schema.missions).set({ deadlineAt: deadline, mandate: { ...initial.mission.mandate, issuedAt: new Date(Date.now() - 600000).toISOString(), deadlineAt: deadline.toISOString() } }).where(eq(schema.missions.id, f.id));
    const closed = await h.settle(f); assert.equal(closed.mission.lifecycle, 'closed'); assert.equal(closed.mission.closureReason, 'deadline'); assert.equal(closed.reports[0].document.partial, true);
    assert.equal(closed.claims.length, 1); assert.equal(closed.claims[0].state, 'uncertain'); assert.equal(starts(f), 1);
    f.unavailable = false; const job = dispatches(f)[0]; finish(job, f, 'cancelled'); await repository.saveRepositoryJob(job); await h.reconcileClosedMissionResources(); assert.equal((await h.state(f)).claims.length, 0);
  });
  await check('inspection finishing after its real attempt deadline remains history and cannot authorize a new check', async () => {
    const f = await fixture({ hold: true }), reserved = await reserveDiscovery(f);
    // Set the short deadline before dispatch so the persisted execution and
    // runner fingerprint are genuine and unchanged; then let wall time expire.
    const deadline = new Date(Date.now() + 800);
    await db.update(schema.missionAttempts).set({ deadlineAt: deadline }).where(eq(schema.missionAttempts.id, reserved.id));
    await h.pass(f); assert.equal(starts(f), 1);
    await new Promise(resolve => setTimeout(resolve, Math.max(1, deadline.getTime() - Date.now() + 100)));
    const job = dispatches(f)[0]; finish(job, f); assert.ok(Date.parse(job.finishedAt) > deadline.getTime()); await repository.saveRepositoryJob(job);
    await h.pass(f); const after = await h.state(f);
    assert.equal(after.tasks.filter(task => task.spec.kind === 'repository_check').length, 0, 'Late terminal receipt must not enable dependent execution');
    assert.equal(after.tasks.find(task => task.spec.kind === 'discovery').state, 'blocked');
    assert.equal(after.claims.length, 0, 'Confirmed cleanup is still released for late results');
    assert.equal(starts(f), 1); assert.ok((await h.row(schema.repositoryRuns, job.id)).job, 'Late result is still saved as history');
  });
  await check('a receipt completed before deadline can be reconciled after deadline without losing its valid successor', async () => {
    const f = await fixture({ hold: true }), reserved = await reserveDiscovery(f);
    const deadline = new Date(Date.now() + 1000);
    await db.update(schema.missionAttempts).set({ deadlineAt: deadline }).where(eq(schema.missionAttempts.id, reserved.id));
    await h.pass(f); const job = dispatches(f)[0]; finish(job, f);
    assert.ok(Date.parse(job.finishedAt) < deadline.getTime());
    // The actual status endpoint supplies this durable completion later; no
    // callback is driven before the controller restarts after its deadline.
    await new Promise(resolve => setTimeout(resolve, Math.max(1, deadline.getTime() - Date.now() + 100)));
    await h.pass(f); const after = await h.state(f);
    assert.equal(after.tasks.find(task => task.spec.kind === 'discovery').state, 'completed');
    assert.equal(after.tasks.filter(task => task.spec.kind === 'repository_check').length, 1);
    assert.equal(starts(f), 2); assert.equal((await h.row(schema.repositoryRuns, job.id)).job.finishedAt, job.finishedAt);
    // This used to be the final fixture. Complete its deliberately held test
    // through the normal receipt/controller path before the next pool user.
    f.hold = false;
    const test = dispatches(f).find(value => value.mode === 'test'); finish(test, f); await repository.saveRepositoryJob(test);
    const closed = await h.settle(f); assert.equal(closed.mission.lifecycle, 'closed'); assert.equal(closed.claims.length, 0);
  });
  await check('auto chooses the existing test command once and preserves that bounded negative QA result', async () => {
    const f = await fixture({ target: { ...target, surface: 'auto' }, scripts: { test: 'node --test', start: 'node server.mjs' } });
    const initial = (await h.state(f)).mission, closed = await h.settle(f);
    assert.equal(closed.mission.lifecycle, 'closed'); assert.equal(closed.mission.closureReason, 'investigated');
    assert.equal(starts(f), 2); assert.equal(dispatches(f).find(job => job.mode === 'test').testExitCode, 1);
    assert.equal(closed.tasks.filter(task => ['environment_setup', 'browser_tests'].includes(task.spec.kind)).length, 0);
    assert.deepEqual(closed.mission.admission.target, initial.admission.target); assert.deepEqual(closed.mission.mandate, initial.mandate);
    assert.match(closed.mission.config.criteria[0].text, /Inga funktionella tester utlovas utöver detta kommando/);
    const decisions = (await h.rows(schema.missionEvents, f.id)).filter(event => event.kind === 'repository.surface_selected');
    assert.equal(decisions.length, 1); assert.equal(decisions[0].payload.selectedSurface, 'checks');
    assert.equal(closed.reports[0].document.partial, false);
  });
  await check('explicit checks with only a start script remains blocked without app or browser preparation', async () => {
    const f = await fixture({ target: { ...target, surface: 'checks' }, scripts: { start: 'node server.mjs' } }), closed = await h.settle(f);
    assert.equal(closed.mission.closureReason, 'blocked'); assert.equal(closed.reports[0].document.partial, true);
    assert.equal(starts(f), 1); assert.equal(closed.tasks.filter(task => ['repository_check', 'environment_setup', 'browser_tests'].includes(task.spec.kind)).length, 0);
    assert.equal((await h.rows(schema.missionEvents, f.id)).filter(event => event.kind === 'repository.surface_selected').length, 0);
    assert.equal(closed.mission.admission.target.surface, 'checks');
  });
  await check('auto unknown or ambiguous inspected metadata stays blocked and never guesses startup', async () => {
    for (const options of [{ scripts: {} }, { scripts: { start: 'node server.mjs' }, ambiguous: true }, { scripts: { start: 'node server.mjs' }, projects: [] }]) {
      const f = await fixture({ ...options, target: { ...target, surface: 'auto' } }), closed = await h.settle(f);
      assert.equal(closed.mission.closureReason, 'blocked'); assert.equal(closed.reports[0].document.partial, true); assert.equal(starts(f), 1);
      assert.equal(closed.tasks.filter(task => ['repository_check', 'environment_setup', 'browser_tests'].includes(task.spec.kind)).length, 0);
      const decisions = (await h.rows(schema.missionEvents, f.id)).filter(event => event.kind === 'repository.surface_selected');
      assert.equal(decisions.length, 1); assert.equal(decisions[0].payload.selectedSurface, 'blocked');
    }
  });
  await check('auto start-only and explicit application with tests preserve the exact existing environment chain', async () => {
    for (const surface of ['auto', 'application']) {
      const scripts = surface === 'auto' ? { start: 'node server.mjs' } : { test: 'node --test', start: 'node server.mjs' };
      const f = await fixture({ target: { ...target, surface }, scripts }), initial = (await h.state(f)).mission;
      const original = await inspectedDiscovery(f), first = await selectInspectedSurface(f, true), second = await selectInspectedSurface(f, true);
      assert.equal(first.state, 'requires_browser'); assert.equal(second.state, 'requires_browser'); assert.equal(first.inspectionId, original.dispatchId);
      const state = await h.state(f), tasks = state.tasks.filter(task => task.spec.kind === 'environment_setup');
      assert.equal(tasks.length, 1); assert.equal(tasks[0].spec.phase, 'prepare'); assert.equal(tasks[0].spec.expectedCommit, sha);
      assert.equal(tasks[0].spec.inspectedRunId, original.dispatchId); assert.deepEqual(tasks[0].dependsOn, [original.taskId]);
      assert.equal(state.tasks.filter(task => ['repository_check', 'browser_tests'].includes(task.spec.kind)).length, 0);
      assert.deepEqual(state.mission.config, initial.config); assert.deepEqual(state.mission.mandate, initial.mandate);
      assert.equal(starts(f), 1, 'Selecting an app route does not start it, read Vault or manufacture readiness');
      assert.equal(state.attempts.filter(attempt => attempt.kind !== 'discovery').length, 0);
      const events = await h.rows(schema.missionEvents, f.id);
      assert.equal(events.filter(event => event.kind === 'environment.preparation_planned').length, 1);
      const decisions = events.filter(event => event.kind === 'repository.surface_selected');
      assert.equal(decisions.length, surface === 'auto' ? 1 : 0);
      if (surface === 'auto') assert.equal(decisions[0].payload.selectedSurface, 'application');
    }
  });
  await check('auto cannot switch surface after its saved authenticated inspection decision', async () => {
    const f = await fixture({ target: { ...target, surface: 'auto' }, scripts: { start: 'node server.mjs' } });
    const original = await inspectedDiscovery(f); assert.equal((await selectInspectedSurface(f)).state, 'requires_browser');
    const inspection = await h.row(schema.repositoryRuns, original.dispatchId);
    const changed = structuredClone(inspection.job); changed.package.scripts.test = 'node --test'; changed.plan.selectedScript = 'test'; changed.plan.command = ['npm', '--ignore-scripts', 'run', 'test', '--'];
    // Explicit corrupted-history fault: the original request/fingerprint remains
    // bound, but altered inspection output must not authorize another route.
    await db.update(schema.repositoryRuns).set({ job: changed }).where(eq(schema.repositoryRuns.id, inspection.id));
    await assert.rejects(selectInspectedSurface(f), error => error.statusCode === 409);
    const state = await h.state(f); assert.equal(starts(f), 1); assert.equal(state.tasks.length, 1);
    const decisions = (await h.rows(schema.missionEvents, f.id)).filter(event => event.kind === 'repository.surface_selected');
    assert.equal(decisions.length, 1); assert.equal(decisions[0].payload.selectedSurface, 'application');
  });
  assert.deepEqual(failures, [], `Repository controller failures:\n${JSON.stringify(failures, null, 2)}`);
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, actualPostgreSQL: true, actualController: true, executor: 'synthetic HTTP', model: 'synthetic generation with actual evidence reads', scenarios: checks }, null, 2));
} finally { await h.close(); }
