// Actual isolated PostgreSQL + authored adapter/admission/H3 callback. Only the
// external Linux executor's transport is substituted; no model/checkout runs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { eq } from 'drizzle-orm';
import { createApp, toNodeListener } from 'h3';
import { isolatedApp } from './helpers/isolated-app.mjs';
import { executionHash } from '../infra/execution/admission.mjs';
import { validate } from '../infra/repo-runner/runner.mjs';

process.env.PAT_RUNTIME_SCOPE = `autonomy-test:repository-${randomUUID()}`;
process.env.MISSIONS_ENABLED = 'true'; process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true';
process.env.REPO_RUNNER_URL = `http://${randomUUID()}.repository-executor.fixture.invalid`;
process.env.REPO_RUNNER_KEY = 'synthetic-executor-only-key';
const app = await isolatedApp(), { db, schema } = app;
const control = await import('../server/utils/mission-control.ts');
const attempts = await import('../server/utils/mission-attempts.ts');
const admission = await import('../server/utils/mission-executor-admission.ts');
const adapter = await import('../server/utils/mission-repository.ts');
const planning = await import('../server/utils/mission-repository-plan.ts');
const repositories = await import('../server/utils/repositories.ts');
const callback = (await import('../server/api/internal/repository-result.post.ts')).default;
const server = createServer(toNodeListener(createApp().use('/callback', callback)));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const originalFetch = globalThis.fetch, jobs = new Map(), calls = [], contexts = [];
const owner = randomUUID(), workspace = randomUUID(), thread = randomUUID();
let loseResponse = false, oldWorker = false, unknownTransport = false;
const row = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
const target = { kind: 'repository', url: 'https://github.com/fixture/repo', ref: 'main' };
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith(origin)) return originalFetch(url, options);
  assert.ok(String(url).startsWith(process.env.REPO_RUNNER_URL), 'Unexpected external transport');
  const path = new URL(url); calls.push(path.pathname);
  if (unknownTransport) throw new Error('Synthetic unavailable executor');
  if (path.pathname === '/health') return Response.json({ autonomousExecution: oldWorker ? undefined : { version: 1, admission: true, frozenCommit: true } });
  if (options.method === 'GET') return Response.json({ jobs: (path.searchParams.get('ids') || '').split(',').flatMap(id => jobs.has(id) ? [jobs.get(id)] : []) });
  if (path.pathname.endsWith('/cancel')) {
    const job = jobs.get(path.pathname.split('/')[2]); assert.ok(job);
    const now = new Date().toISOString();
    if (!['passed', 'failed', 'blocked', 'cancelled', 'review'].includes(job.status)) { job.status = 'cancelled'; job.finishedAt = now; }
    job.revision++; job.updatedAt = now;
    job.cleanup = { resourceId: job.id, confirmed: true, observedAt: now };
    return Response.json(job);
  }
  assert.equal(path.pathname, '/jobs'); const input = validate(JSON.parse(options.body));
  const run = await row(schema.repositoryRuns, input.id); assert.ok(run, 'Intent exists before HTTP');
  const task = await row(schema.missionTasks, input.execution.taskId); assert.ok(task.sources.some(source => source.type === 'repository' && source.id === input.id));
  const attempt = await row(schema.missionAttempts, input.execution.attemptId); assert.equal(attempt.executorResourceId, input.id);
  const [claim] = await db.select().from(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, attempt.id)); assert.equal(claim.executorResourceId, input.id);
  // This reacquires the mission lock in another transaction, proving HTTP was
  // reached only after the adapter's persistence transaction committed.
  await admission.admitMissionExecutor({ execution: input.execution, resourceId: input.id, operationId: 'job', kind: `repository.${input.mode}`, payloadHash: executionHash({ fingerprint: executionHash(input) }) });
  if (!jobs.has(input.id)) {
    const now = new Date().toISOString(); jobs.set(input.id, { ...input, fingerprint: executionHash(input), revision: 1, status: 'running', message: 'Synthetic executor', logs: '', commit: null, package: null, testExitCode: null, createdAt: now, updatedAt: now, finishedAt: null });
  } else assert.equal(jobs.get(input.id).fingerprint, executionHash(input));
  if (loseResponse) { loseResponse = false; throw new Error('Synthetic accepted job but response lost'); }
  return Response.json(jobs.get(input.id));
};
let checks = 0;
async function check(name, operation) { await operation(); checks++; console.log(`PASS ${name}`); }
async function mission(options = {}) {
  const mission = await control.acceptMission(owner, workspace, thread, { requestId: randomUUID(), intent: 'explore', goal: 'Undersök repot och spara vad som faktiskt observeras.', target: options.target ?? target, caseKeys: [], sourceRefs: [] });
  const claimed = await attempts.claimMission(mission.id); assert.ok(claimed);
  const lease = attempts.leaseIdentity(claimed);
  const tasks = await db.select().from(schema.missionTasks).where(eq(schema.missionTasks.missionId, mission.id));
  const task = tasks.find(value => value.spec?.kind === 'discovery'); assert.ok(task);
  const reserved = await attempts.reserveMissionAttempt(lease, task.id, { usesModel: false, resource: { kind: 'otto', poolKey: process.env.REPO_RUNNER_URL } }); assert.equal(reserved.status, 'reserved');
  await attempts.markMissionDispatch(lease, reserved.attempt.id);
  const context = { mission, lease, task, attempt: reserved.attempt }; contexts.push(context); return context;
}
async function terminal(f, status = 'review', cleanup = true) {
  const job = jobs.get(f.attempt.dispatchId); job.status = status; job.revision++; job.commit = 'a'.repeat(40); job.finishedAt = new Date().toISOString(); job.updatedAt = job.finishedAt;
  job.cleanup = { resourceId: job.id, confirmed: cleanup, observedAt: job.finishedAt };
  if (status === 'review') job.plan = null;
  return job;
}
async function release(f) {
  await db.update(schema.missionAttempts).set({ status: 'completed' }).where(eq(schema.missionAttempts.id, f.attempt.id));
  await db.update(schema.missionTasks).set({ state: 'completed' }).where(eq(schema.missionTasks.id, f.task.id));
  await attempts.releaseMissionResource(f.attempt.id, f.attempt.dispatchId, true);
}
async function derive(f, expected = null) {
  return db.transaction(async tx => {
    await control.lockMission(tx, f.mission.id);
    return planning.reconcileRepositoryDiscovery(tx, expected || await row(schema.missions, f.mission.id), f.task);
  });
}
try {
  await db.insert(schema.user).values({ id: owner, name: 'Isolated executor fixture', email: `${owner}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspace, userId: owner, name: 'Executor fixture' });
  await db.insert(schema.threads).values({ id: thread, userId: owner, workspaceId: workspace, title: 'Executor fixture' });
  const first = await mission();
  await check('persist-before-send and live physical admission bind exact source, epoch and claim', async () => {
    const result = await adapter.dispatchMissionRepository(first.lease, first.attempt.id); assert.equal(result.status, null); assert.equal(result.job.id, first.attempt.dispatchId); assert.equal(result.cleanupConfirmed, false);
    const again = await adapter.dispatchMissionRepository(first.lease, first.attempt.id); assert.equal(again.job.id, result.job.id); assert.equal(jobs.size, 1);
  });
  await check('GET repository listing is pure for autonomous unfinished work', async () => { const before = calls.length; await repositories.listRepositories(owner, workspace); assert.equal(calls.length, before); });
  await check('owner-facing repository reads omit executor authority and journals while private saved receipts remain intact', async () => {
    const job = jobs.get(first.attempt.dispatchId); job.commandJournal = { 'command:0': { fingerprint: 'a'.repeat(64), state: 'completed' } }; job.revision++; await repositories.saveRepositoryJob(job);
    const full = await repositories.listRepositories(owner, workspace), compact = await repositories.listRepositories(owner, workspace, true), single = await repositories.getRepositoryRun(owner, workspace, job.id);
    for (const run of [...full.runs, ...compact.runs, single]) {
      assert.equal(run.config.execution, undefined); assert.equal(run.job.execution, undefined); assert.equal(run.job.fingerprint, undefined); assert.equal(run.job.commandJournal, undefined);
    }
    const saved = await row(schema.repositoryRuns, job.id); assert.ok(saved.config.execution); assert.ok(saved.job.execution); assert.ok(saved.job.commandJournal); assert.ok(saved.job.fingerprint);
  });
  await check('manual tool cannot bypass controlled attempt binding', async () => {
    const saved = await row(schema.repositoryRuns, first.attempt.dispatchId), before = calls.length;
    await assert.rejects(repositories.repositoryAction(owner, workspace, { action: 'start', repositoryId: saved.repositoryId, requestId: randomUUID(), mode: 'inspect', mission: { missionId: first.mission.id, taskId: first.task.id } }, thread), /bundna/);
    assert.equal(calls.length, before);
  });
  await check('callback preserves exact binding and null plan, rejects forged binding/SHA/fingerprint', async () => {
    const job = await terminal(first);
    const send = value => originalFetch(`${origin}/callback`, { method: 'POST', headers: { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal((await send(job)).status, 200);
    for (const change of [{ execution: undefined }, { execution: { ...job.execution, attemptId: randomUUID() } }, { fingerprint: 'b'.repeat(64) }, { cleanup: { ...job.cleanup, resourceId: randomUUID() } }]) assert.equal((await send({ ...job, ...change, revision: job.revision + 1 })).status, 409);
    const saved = await row(schema.repositoryRuns, job.id); assert.deepEqual(saved.job.execution, job.execution); assert.equal(saved.job.plan, null);
  });
  await check('terminal inspection requires explicit cleanup receipt', async () => {
    const result = await adapter.reconcileMissionRepository(await row(schema.missions, first.mission.id), first.attempt); assert.equal(result.status, 'completed'); assert.equal(result.cleanupConfirmed, true);
    await release(first);
  });
  let successor;
  await check('inspection creates one exact-SHA check and preserves original goal, with inspection excluded from QA delivery', async () => {
    const job = jobs.get(first.attempt.dispatchId); job.revision++;
    job.plan = { directory: '.', runtime: 'node22', operationKind: 'inspect', selectedScript: 'test', install: [['npm', 'ci']], command: ['npm', 'run', 'test'] };
    job.package = { name: 'fixture', scripts: { test: 'node --test' }, packageManager: 'npm', lock: true };
    await repositories.saveRepositoryJob(job);
    const before = await row(schema.missions, first.mission.id), one = await derive(first), two = await derive(first); successor = one.task;
    assert.equal(one.state, 'ready'); assert.equal(two.task.id, one.task.id); assert.equal(one.task.spec.expectedCommit, 'a'.repeat(40)); assert.equal(one.task.spec.inspectedRunId, job.id);
    const current = await row(schema.missions, first.mission.id); assert.equal(current.config.goal, before.config.goal); assert.match(current.config.criteria[0].text, /exakt inspekterad commit/); assert.doesNotMatch(current.config.criteria[0].text, /valt testfalls/);
    assert.deepEqual((await row(schema.missionTasks, first.task.id)).criterionIds, []);
    assert.deepEqual((await row(schema.missionTasks, first.task.id)).sources, [{ type: 'repository', id: job.id }]);
    assert.deepEqual(successor.criterionIds, ['qa']);
    const graph = await db.select().from(schema.missionTasks).where(eq(schema.missionTasks.missionId, first.mission.id)); assert.equal(graph.filter(t => t.spec?.kind === 'repository_check').length, 1);
  });
  await check('changed inspected SHA/plan and obsolete epoch cannot create or change a successor', async () => {
    const run = await row(schema.repositoryRuns, first.attempt.dispatchId), current = await row(schema.missions, first.mission.id);
    const before = { calls: calls.length, jobs: jobs.size,
      tasks: await db.select().from(schema.missionTasks).where(eq(schema.missionTasks.missionId, first.mission.id)),
      events: await db.select().from(schema.missionEvents).where(eq(schema.missionEvents.missionId, first.mission.id)) };
    const rejectChangedInspection = async () => {
      await assert.rejects(derive(first), error => error.statusCode === 409 && error.statusMessage === 'Repoinspektionens valda testyta har ändrats.');
      assert.equal(calls.length, before.calls, 'Changed inspection must not reach the executor');
      assert.equal(jobs.size, before.jobs);
      assert.deepEqual(await db.select().from(schema.missionTasks).where(eq(schema.missionTasks.missionId, first.mission.id)), before.tasks);
      assert.deepEqual(await db.select().from(schema.missionEvents).where(eq(schema.missionEvents.missionId, first.mission.id)), before.events);
    };
    // Fault injection bypasses the private callback to simulate corrupted saved
    // facts. Planning still must not silently retarget the logical operation.
    await db.update(schema.repositoryRuns).set({ job: { ...run.job, commit: 'b'.repeat(40) } }).where(eq(schema.repositoryRuns.id, run.id));
    await rejectChangedInspection();
    await db.update(schema.repositoryRuns).set({ job: { ...run.job, plan: { ...run.job.plan, command: ['npm', 'run', 'other'] } } }).where(eq(schema.repositoryRuns.id, run.id));
    await rejectChangedInspection();
    await db.update(schema.repositoryRuns).set({ job: run.job }).where(eq(schema.repositoryRuns.id, run.id));
    await db.update(schema.missions).set({ mandateRevision: current.mandateRevision + 1 }).where(eq(schema.missions.id, current.id));
    const oldSnapshot = await derive(first, current), oldAttempt = await derive(first);
    assert.equal(oldSnapshot.state, 'stale'); assert.equal(oldAttempt.state, 'stale'); assert.equal(oldAttempt.task, null);
    await db.update(schema.missions).set({ mandateRevision: current.mandateRevision }).where(eq(schema.missions.id, current.id));
    assert.equal((await derive(first)).task.id, successor.id);
  });
  await check('test follow-on uses the saved inspection SHA even after branch configuration changes', async () => {
    const inspected = await row(schema.repositoryRuns, first.attempt.dispatchId);
    await db.update(schema.repositories).set({ ref: 'moved-branch' }).where(eq(schema.repositories.id, inspected.repositoryId));
    const task = successor;
    const reserved = await attempts.reserveMissionAttempt(first.lease, task.id, { usesModel: false, resource: { kind: 'otto', poolKey: process.env.REPO_RUNNER_URL } }); assert.equal(reserved.status, 'reserved');
    await attempts.markMissionDispatch(first.lease, reserved.attempt.id);
    const result = await adapter.dispatchMissionRepository(first.lease, reserved.attempt.id); assert.equal(result.job.expectedCommit, 'a'.repeat(40)); assert.equal(result.job.ref, 'main');
    assert.deepEqual((await row(schema.missions, first.mission.id)).config.criteria[0].delivery.sourceRefs, [{ type: 'repository', id: reserved.attempt.dispatchId }]);
    const f = { ...first, task, attempt: reserved.attempt }; await terminal(f, 'failed');
    await assert.rejects(repositories.saveRepositoryJob({ ...jobs.get(f.attempt.dispatchId), commit: 'b'.repeat(40) }), /avviker/);
    const completed = await adapter.reconcileMissionRepository(await row(schema.missions, first.mission.id), f.attempt); assert.equal(completed.status, 'completed', 'A test command finding failure still completes its execution'); await release(f);
  });
  await check('closed mission retains saved exact historical inspection without a new dispatch', async () => {
    await db.update(schema.missions).set({ lifecycle: 'closed', status: 'closed' }).where(eq(schema.missions.id, first.mission.id));
    const before = calls.length; const result = await adapter.reconcileMissionRepository(await row(schema.missions, first.mission.id), first.attempt);
    assert.equal(result.job.id, first.attempt.dispatchId); assert.equal(calls.length, before);
  });
  const ambiguous = await mission();
  await check('ambiguous inspection creates one blocked question, without an unspecified executable test', async () => {
    await adapter.dispatchMissionRepository(ambiguous.lease, ambiguous.attempt.id); await terminal(ambiguous); await repositories.saveRepositoryJob(jobs.get(ambiguous.attempt.dispatchId)); await release(ambiguous);
    const before = jobs.size, one = await derive(ambiguous), two = await derive(ambiguous);
    assert.equal(one.state, 'blocked'); assert.equal(one.task.state, 'blocked'); assert.equal(one.task.spec.kind, 'planning'); assert.match(one.task.blockedReason, /Vilken projektkatalog/); assert.equal(one.task.id, two.task.id); assert.equal(jobs.size, before);
  });
  const selected = await mission();
  await check('explicit testcase selection and requirement text are never rewritten as repository QA', async () => {
    await adapter.dispatchMissionRepository(selected.lease, selected.attempt.id); await terminal(selected); await repositories.saveRepositoryJob(jobs.get(selected.attempt.dispatchId)); await release(selected);
    const current = await row(schema.missions, selected.mission.id), key = `${randomUUID()}:${randomUUID()}`;
    // Saved selection fixture: this helper does not start/read a browser run;
    // the environment/browser branch owns validation of the actual case rows.
    const config = { ...current.config, caseKeys: [key], criteria: [{ id: 'explicit', text: 'Verify the chosen authenticated flow.', delivery: { kind: 'test_cases', caseKeys: [key] } }] };
    await db.update(schema.missions).set({ config }).where(eq(schema.missions.id, current.id));
    const result = await derive(selected); assert.equal(result.state, 'requires_browser'); assert.equal(result.task, null); assert.deepEqual((await row(schema.missions, current.id)).config, config);
    assert.equal((await db.select().from(schema.missionTasks).where(eq(schema.missionTasks.missionId, current.id))).length, 1);
  });
  await check('application target retains inspected facts without replacing its QA scope with a repository check', async () => {
    const f = await mission({ target: { ...target, surface: 'application' } });
    await adapter.dispatchMissionRepository(f.lease, f.attempt.id); await terminal(f); await repositories.saveRepositoryJob(jobs.get(f.attempt.dispatchId)); await release(f);
    const before = await row(schema.missions, f.mission.id), result = await derive(f);
    assert.equal(result.state, 'requires_browser'); assert.equal(result.commit, 'a'.repeat(40)); assert.equal(result.task, null);
    assert.deepEqual((await row(schema.missions, f.mission.id)).config, before.config);
    assert.equal((await db.select().from(schema.missionTasks).where(eq(schema.missionTasks.missionId, f.mission.id))).length, 1);
  });
  await check('strategy rejects late or invalid completion even if an old controller marked the attempt completed', async () => {
    const f = await mission(); await adapter.dispatchMissionRepository(f.lease, f.attempt.id); await terminal(f); await release(f);
    const job = jobs.get(f.attempt.dispatchId);
    for (const finishedAt of [new Date(f.attempt.deadlineAt.getTime() + 1).toISOString(), 'invalid-time']) {
      // Direct persistence is intentional fault injection of an older controller
      // having marked late execution complete; production callbacks are unchanged.
      await db.update(schema.repositoryRuns).set({ job: { ...job, finishedAt } }).where(eq(schema.repositoryRuns.id, job.id));
      const result = await derive(f); assert.equal(result.state, 'stale'); assert.equal(result.task, null);
      assert.equal((await db.select().from(schema.missionTasks).where(eq(schema.missionTasks.missionId, f.mission.id))).length, 1);
    }
  });
  const lost = await mission();
  await check('lost response reconciles the original dispatch without another start', async () => {
    loseResponse = true; await assert.rejects(adapter.dispatchMissionRepository(lost.lease, lost.attempt.id), /lost/);
    const before = calls.filter(path => path === '/jobs').length;
    const result = await adapter.reconcileMissionRepository(await row(schema.missions, lost.mission.id), lost.attempt); assert.equal(result.job.id, lost.attempt.dispatchId);
    assert.equal(calls.filter(path => path === '/jobs').length, before + 1, 'Only GET status was added');
  });
  await check('pause blocks start but retains exact cancellation and cleanup reconciliation', async () => {
    await db.update(schema.missions).set({ lifecycle: 'paused' }).where(eq(schema.missions.id, lost.mission.id));
    await assert.rejects(adapter.dispatchMissionRepository(lost.lease, lost.attempt.id));
    const result = await adapter.reconcileMissionRepository(await row(schema.missions, lost.mission.id), lost.attempt, { cancel: true }); assert.equal(result.status, 'cancelled'); assert.equal(result.cleanupConfirmed, true); await release(lost);
  });
  for (const ref of ['b06245b39072432cfd23468caefd4c9031f7fb53', 'B06245B39072432CFD23468CAEFD4C9031F7FB53']) {
    await check(`discovery pins full commit ref ${ref === ref.toLowerCase() ? 'lowercase' : 'uppercase'} before dispatch and rejects a different checkout`, async () => {
      const f = await mission({ target: { ...target, ref } });
      const result = await adapter.dispatchMissionRepository(f.lease, f.attempt.id), expectedCommit = ref.toLowerCase();
      assert.equal(result.job.expectedCommit, expectedCommit); assert.equal(result.job.ref, ref);
      const saved = await row(schema.repositoryRuns, f.attempt.dispatchId);
      assert.equal(saved.config.expectedCommit, expectedCommit); assert.equal(saved.config.ref, ref);
      const repeated = await adapter.dispatchMissionRepository(f.lease, f.attempt.id); assert.equal(repeated.job.id, result.job.id);
      assert.equal(repeated.job.expectedCommit, expectedCommit);
      const job = await terminal(f); job.commit = expectedCommit;
      await assert.rejects(repositories.saveRepositoryJob({ ...job, commit: 'c'.repeat(40) }), /avviker/);
      await assert.rejects(repositories.saveRepositoryJob({ ...job, expectedCommit: undefined }), /avviker/);
      await repositories.saveRepositoryJob(job);
      const completed = await adapter.reconcileMissionRepository(await row(schema.missions, f.mission.id), f.attempt);
      assert.equal(completed.status, 'completed'); assert.equal(completed.job.commit, expectedCommit); await release(f);
    });
  }
  await check('branches, tags and abbreviated refs retain their original discovery semantics', async () => {
    for (const ref of ['', 'main', 'release/v1', 'v1.2.3', 'b06245b', 'a'.repeat(39), 'a'.repeat(41), `g${'a'.repeat(39)}`]) {
      const f = await mission({ target: { ...target, ref } });
      const result = await adapter.dispatchMissionRepository(f.lease, f.attempt.id);
      assert.equal(result.job.expectedCommit, undefined); assert.equal(result.job.ref, ref);
      assert.equal((await row(schema.repositoryRuns, f.attempt.dispatchId)).config.expectedCommit, undefined);
      await terminal(f); await repositories.saveRepositoryJob(jobs.get(f.attempt.dispatchId)); await release(f);
    }
  });
  await check('terminal repository status is read-only; explicit cleanup repairs only the exact original binding', async () => {
    const f = await mission(); await adapter.dispatchMissionRepository(f.lease, f.attempt.id);
    const job = await terminal(f, 'failed', false); await repositories.saveRepositoryJob(job);
    const historical = { status: job.status, finishedAt: job.finishedAt, logs: job.logs, commit: job.commit, execution: structuredClone(job.execution) };
    const before = calls.filter(path => path.endsWith('/cancel')).length;
    const status = await adapter.reconcileMissionRepository(await row(schema.missions, f.mission.id), f.attempt);
    assert.equal(status.cleanupConfirmed, false); assert.equal(calls.filter(path => path.endsWith('/cancel')).length, before);
    const exact = job.execution; job.execution = { ...exact, attemptId: randomUUID() };
    const rejected = await adapter.reconcileMissionRepository(await row(schema.missions, f.mission.id), f.attempt, { cancel: true });
    assert.equal(rejected.unknown, true); assert.equal(rejected.cleanupConfirmed, false);
    assert.equal(calls.filter(path => path.endsWith('/cancel')).length, before, 'Forged worker binding is rejected before physical cancellation');
    job.execution = exact;
    const result = await adapter.reconcileMissionRepository(await row(schema.missions, f.mission.id), f.attempt, { cancel: true });
    assert.equal(result.cleanupConfirmed, true); assert.equal(result.status, 'completed');
    assert.equal(calls.filter(path => path.endsWith('/cancel')).length, before + 1);
    assert.deepEqual({ status: job.status, finishedAt: job.finishedAt, logs: job.logs, commit: job.commit, execution: job.execution }, historical);
    assert.equal((await row(schema.repositoryRuns, job.id)).job.cleanup.confirmed, true);
    await release(f);
  });
  const old = await mission();
  await check('old worker capability cannot receive autonomous work; pending GET does not repair it', async () => {
    oldWorker = true; const before = jobs.size; await assert.rejects(adapter.dispatchMissionRepository(old.lease, old.attempt.id), /protokoll/); oldWorker = false;
    assert.equal(jobs.size, before); const count = calls.length; await repositories.listRepositories(owner, workspace); assert.equal(calls.length, count);
  });
  await check('unavailable executor remains unknown and never fabricates physical cleanup', async () => {
    unknownTransport = true; const result = await adapter.reconcileMissionRepository(await row(schema.missions, old.mission.id), old.attempt, { cancel: true }); unknownTransport = false;
    assert.equal(result.unknown, true); assert.equal(result.cleanupConfirmed, false);
  });
  await check('cross-runtime or cross-mission reconciliation is denied before transport', async () => {
    const count = calls.length;
    await assert.rejects(adapter.reconcileMissionRepository({ ...old.mission, runtime: 'foreign' }, old.attempt));
    await assert.rejects(adapter.reconcileMissionRepository(first.mission, old.attempt)); assert.equal(calls.length, count);
  });
  console.log(`PASS repository execution integration: ${checks} checks`);
} catch (error) { console.error('Repository adapter integration failure:', error); throw error; } finally {
  globalThis.fetch = originalFetch;
  await new Promise(resolve => server.close(resolve));
  await db.delete(schema.threads).where(eq(schema.threads.id, thread));
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspace));
  await db.delete(schema.user).where(eq(schema.user.id, owner));
  await app.close();
}
