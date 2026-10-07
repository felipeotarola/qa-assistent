// Actual PostgreSQL, authored admission/consent/crypto/environment adapters.
// Executor HTTP is synthetic: no Linux process, real secret, or model is used.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { eq, sql } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';
import { environmentPlanHash } from '../shared/mission-environment.mjs';
import { validate } from '../infra/repo-runner/runner.mjs';
import { executionHash } from '../infra/execution/admission.mjs';

process.env.PAT_RUNTIME_SCOPE = `autonomy-test:environment-${randomUUID()}`;
process.env.MISSIONS_ENABLED = 'true'; process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true';
process.env.ENV_VAULT_KEY = `isolated-environment-${randomUUID()}`;
process.env.REPO_RUNNER_URL = `http://${randomUUID()}.environment.fixture.invalid`;
process.env.REPO_RUNNER_KEY = 'synthetic-environment-executor';
const app = await isolatedApp(), { db, schema } = app;
const control = await import('../server/utils/mission-control.ts');
const attempts = await import('../server/utils/mission-attempts.ts');
const repository = await import('../server/utils/mission-repository.ts');
const admission = await import('../server/utils/mission-executor-admission.ts');
const environment = await import('../server/utils/mission-environment.ts');
const consents = await import('../server/utils/environment-consents.ts');
const vault = await import('../server/utils/project-vault.ts');
const row = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
const fixtures = [], jobs = new Map(), sends = [], originalFetch = globalThis.fetch;
const checks = [], failures = [], lockReleases = new Set(), pending = [];
const commit = 'a'.repeat(40), repoUrl = 'https://github.com/fixture/environment';
let loseStart = false, rejectStart = false;
const deny = promise => assert.rejects(promise, error => [403, 404, 409].includes(error.statusCode));
function safeMetadata(value, f) { assert.ok(!JSON.stringify(value).includes(f.secret), 'Secret must not leave the explicit release response'); }

globalThis.fetch = async (url, options = {}) => {
  assert.ok(String(url).startsWith(process.env.REPO_RUNNER_URL), 'Unexpected network operation');
  const parsed = new URL(url), input = options.body ? JSON.parse(options.body) : null;
  sends.push({ path: parsed.pathname, action: input?.action, id: input?.jobId ?? input?.id });
  if (parsed.pathname === '/health') return Response.json({ autonomousExecution: { version: 1, admission: true, frozenCommit: true, environment: true } });
  if (parsed.pathname === '/jobs' && options.method === 'GET') return Response.json({ jobs: (parsed.searchParams.get('ids') || '').split(',').flatMap(id => jobs.has(id) ? [jobs.get(id)] : []) });
  if (parsed.pathname === '/jobs') {
    const config = validate(input), now = new Date().toISOString();
    await admission.admitMissionExecutor({ execution: config.execution, resourceId: config.id, operationId: 'job', kind: 'repository.inspect', payloadHash: executionHash(config) });
    const job = { ...config, fingerprint: executionHash(config), revision: 1, status: 'review', message: 'Synthetic inspected commit', logs: `HEAD ${commit}`, commit, package: null, plan: null, testExitCode: null,
      createdAt: now, updatedAt: now, finishedAt: now, cleanup: { resourceId: config.id, confirmed: true, observedAt: now } };
    jobs.set(job.id, job); return Response.json(job);
  }
  if (parsed.pathname === '/sandbox') {
    if (input.action === 'ensure') {
      const job = await row(schema.setupJobs, input.execution.dispatchId); assert.ok(job?.autonomy, 'Setup intent is durable before ensure');
      assert.equal(job.autonomy.resourceId, input.id);
      await admission.admitMissionExecutor({ execution: input.execution, resourceId: input.id, operationId: input.operationId, kind: 'sandbox.ensure', payloadHash: executionHash(input) });
    }
    return Response.json({ id: input.id, status: input.action === 'stop' ? 'stopped' : 'ready' });
  }
  assert.equal(parsed.pathname, '/codex');
  const saved = await row(schema.setupJobs, input.jobId); assert.ok(saved?.autonomy);
  if (input.action === 'start') {
    if (rejectStart) { rejectStart = false; throw new Error('Synthetic start never reached worker'); }
    const f = fixtures.find(value => value.id === input.execution.missionId); safeMetadata(input, f);
    const isApply = input.environmentExecution.phase === 'apply';
    await admission.admitMissionExecutor({ execution: input.execution, resourceId: input.id, operationId: isApply ? 'environment:init' : 'codex:start', kind: isApply ? 'sandbox.command' : 'codex.initialize', payloadHash: executionHash(input) });
    if (!jobs.has(saved.id)) jobs.set(saved.id, { jobId: saved.id, id: input.id, workspaceId: saved.workspaceId, status: 'running', message: 'Synthetic admitted environment',
      updatedAt: new Date().toISOString(), sequence: 1, execution: saved.autonomy.execution, environmentExecution: saved.autonomy.environmentExecution, fingerprint: saved.autonomy.fingerprint,
      cleanup: 'not-confirmed', executorStopped: false });
    if (loseStart) { loseStart = false; throw new Error('Synthetic response lost after physical start admission'); }
  } else if (input.action === 'cancel') {
    const job = jobs.get(saved.id); if (!job) throw new Error('Job not found');
    Object.assign(job, { status: 'cancelled', sequence: job.sequence + 1, updatedAt: new Date().toISOString(), cleanup: 'confirmed', executorStopped: true });
  } else assert.equal(input.action, 'mission_status');
  return Response.json(jobs.get(saved.id) ?? { absent: true, id: input.id, jobId: saved.id, execution: saved.autonomy.execution });
};

async function fixture() {
  const owner = randomUUID(), workspace = randomUUID(), thread = randomUUID();
  const f = { owner, workspace, thread, secret: `synthetic-secret-${randomUUID()}` }; fixtures.push(f);
  await db.insert(schema.user).values({ id: owner, name: 'Environment fixture', email: `${owner}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspace, userId: owner, name: 'Environment fixture' });
  await db.insert(schema.threads).values({ id: thread, userId: owner, workspaceId: workspace, title: 'Environment fixture' });
  const mission = await control.acceptMission(owner, workspace, thread, { requestId: randomUUID(), intent: 'explore', goal: 'Starta appen i isolerad miljö och undersök dess faktiska beteende.',
    target: { kind: 'repository', url: repoUrl, ref: 'main', surface: 'application' }, caseKeys: [], sourceRefs: [] });
  f.id = mission.id; f.lease = attempts.leaseIdentity(await attempts.claimMission(mission.id));
  const [discovery] = await db.select().from(schema.missionTasks).where(eq(schema.missionTasks.missionId, mission.id));
  const inspection = await reserve(f, discovery); await repository.dispatchMissionRepository(f.lease, inspection.id);
  f.inspectedRunId = inspection.dispatchId; await settled(inspection);
  return f;
}
async function reserve(f, task, deadlineAt) {
  const reserved = await attempts.reserveMissionAttempt(f.lease, task.id, { usesModel: task.spec.kind === 'environment_setup', resource: { kind: 'otto', poolKey: process.env.REPO_RUNNER_URL } });
  assert.equal(reserved.status, 'reserved', JSON.stringify(reserved));
  if (deadlineAt) await db.update(schema.missionAttempts).set({ deadlineAt }).where(eq(schema.missionAttempts.id, reserved.attempt.id));
  await attempts.markMissionDispatch(f.lease, reserved.attempt.id); return row(schema.missionAttempts, reserved.attempt.id);
}
async function settled(attempt) {
  // Fixture terminal acknowledgement; the full controller's graph is covered in
  // repository-controller and the later complete environment-controller suite.
  await db.update(schema.missionAttempts).set({ status: 'completed', finishedAt: new Date() }).where(eq(schema.missionAttempts.id, attempt.id));
  await db.update(schema.missionTasks).set({ state: 'completed' }).where(eq(schema.missionTasks.id, attempt.taskId));
  const [claim] = await db.select().from(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, attempt.id));
  await attempts.releaseMissionResource(attempt.id, claim.executorResourceId, true);
}
async function task(f, spec) {
  return db.transaction(async tx => { await control.lockMission(tx, f.id); return control.addMissionTask(tx, await row(schema.missions, f.id), { operationId: randomUUID(), title: 'Environment adapter fixture', spec }); });
}
async function prepared(f, required = false) {
  const t = await task(f, { kind: 'environment_setup', phase: 'prepare', repoUrl, inspectedRunId: f.inspectedRunId, expectedCommit: commit });
  const attempt = await reserve(f, t); await environment.dispatchMissionEnvironment(f.lease, attempt.id);
  const job = jobs.get(attempt.dispatchId);
  Object.assign(job, { status: required ? 'needs_configuration' : 'completed', sequence: job.sequence + 1, updatedAt: new Date().toISOString(), cleanup: 'confirmed', executorStopped: true,
    environment: { repoUrl, root: '/workspace/environment', directory: '/workspace/environment', commit, command: 'npm run dev -- --host 0.0.0.0', port: 3000, httpStatus: null,
      executionProfile: { version: 1, runtime: 'node24', imageDigest: `sha256:${'1'.repeat(64)}`, packageManager: 'npm', packageManagerVersion: '11.5.0', installDirectory: '/workspace/environment', lockfile: 'package-lock.json', lockfileSha256: '2'.repeat(64), ignoreScripts: true },
      variables: required ? [{ name: 'APP_KEY', required: true, reason: 'Synthetic required setting' }] : [] } });
  await environment.receiveMissionEnvironmentResult(job); await settled(attempt);
  f.prepared = structuredClone(job); return job;
}
async function grant(f) {
  const saved = await vault.saveVaultEntry(f.owner, f.workspace, { repoUrl, expectedRevision: 0, values: { APP_KEY: f.secret, UNSELECTED_KEY: 'synthetic-unselected' }, forget: [] });
  f.consent = await consents.grantEnvironmentConsent(f.owner, f.workspace, f.prepared.jobId, { requestId: randomUUID(), expectedPlanHash: environmentPlanHash(f.prepared.environment), expectedVaultRevision: saved.revision, allowedNames: ['APP_KEY'] });
  // Narrow adapter fixture starts after the typed user wait has authorized this
  // existing grant. Wait-answer epoch changes have separate controller tests.
  const m = await row(schema.missions, f.id); await db.update(schema.missions).set({ mandate: { ...m.mandate, consentIds: [f.consent.id] } }).where(eq(schema.missions.id, f.id));
  return f.consent;
}
async function apply(f, { deadlineAt, dispatch = true } = {}) {
  const t = await task(f, { kind: 'environment_setup', phase: 'apply', repoUrl, inspectedRunId: f.inspectedRunId, expectedCommit: commit, sourceSetupJobId: f.prepared.jobId,
    planHash: environmentPlanHash(f.prepared.environment), ...(f.consent ? { consentId: f.consent.id } : {}) });
  f.apply = await reserve(f, t, deadlineAt); if (dispatch) await environment.dispatchMissionEnvironment(f.lease, f.apply.id);
  return f.apply;
}
async function release(f) {
  const job = await row(schema.setupJobs, f.apply.dispatchId);
  return environment.releaseMissionEnvironment({ execution: job.autonomy.execution, resourceId: job.autonomy.resourceId, operationId: 'environment:release',
    sourceSetupJobId: f.prepared.jobId, planHash: environmentPlanHash(f.prepared.environment) });
}
async function cleanup(f) {
  for (const attempt of await db.select().from(schema.missionAttempts).where(eq(schema.missionAttempts.missionId, f.id))) {
    const [claim] = await db.select().from(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, attempt.id));
    if (claim) {
      // No physical process exists in this synthetic HTTP fixture. Finish its
      // accounting row before releasing the shared test pool for the next case.
      await db.update(schema.missionAttempts).set({ status: 'cancelled' }).where(eq(schema.missionAttempts.id, attempt.id));
      await attempts.releaseMissionResource(attempt.id, claim.executorResourceId, true);
    }
  }
}
async function check(name, operation) {
  const start = fixtures.length;
  try { await operation(); checks.push(name); console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, message: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
  finally { for (const f of fixtures.slice(start)) if (f.id) await cleanup(f); }
}

try {
  await check('prepare persists exact source, claim and fingerprint before executor HTTP; replay keeps one physical identity', async () => {
    const f = await fixture(), job = await prepared(f);
    const saved = await row(schema.setupJobs, job.jobId); assert.equal(saved.notification, 'mission'); assert.equal(saved.autonomy.execution.dispatchId, saved.id);
    assert.equal(saved.autonomy.resourceId, job.id); assert.equal(saved.result.fingerprint, saved.autonomy.fingerprint); safeMetadata(saved, f);
    const before = sends.length; await environment.dispatchMissionEnvironment(f.lease, saved.autonomy.execution.attemptId).catch(error => assert.equal(error.statusCode, 409));
    assert.equal(sends.length, before, 'A completed attempt has no new execution authority');
  });
  await check('callbacks require exact fingerprint, scope and sequence; historical late receipts remain non-authorizing', async () => {
    const f = await fixture(), job = await prepared(f);
    assert.equal((await environment.receiveMissionEnvironmentResult(job)).accepted, false);
    for (const patch of [{ fingerprint: 'b'.repeat(64) }, { id: randomUUID() }, { workspaceId: randomUUID() }, { environment: { ...job.environment, commit: 'b'.repeat(40) } }, { message: 'Conflicting same sequence' }]) await deny(environment.receiveMissionEnvironmentResult({ ...job, ...patch }));
    await db.update(schema.missions).set({ lifecycle: 'paused' }).where(eq(schema.missions.id, f.id));
    assert.equal((await environment.receiveMissionEnvironmentResult({ ...job, sequence: job.sequence + 1, message: 'Late historical cleanup' })).accepted, true);
    await deny(environment.dispatchMissionEnvironment(f.lease, job.execution.attemptId));
  });
  await check('fresh apply normalizes prepared plan, uses a new sandbox and releases no keys for a keyless plan', async () => {
    const f = await fixture(); await prepared(f); await apply(f);
    const saved = await row(schema.setupJobs, f.apply.dispatchId); assert.notEqual(saved.autonomy.resourceId, f.prepared.id); assert.notEqual(saved.id, f.prepared.jobId);
    assert.equal(saved.autonomy.environmentExecution.planHash, environmentPlanHash(f.prepared.environment));
    const result = await release(f); assert.deepEqual(result.values, {}); assert.ok(Date.parse(result.validUntil) <= f.apply.deadlineAt.getTime());
    await deny(release(f));
  });
  await check('Vault release is exactly once and only includes names from the current consent; saved metadata never includes values', async () => {
    const f = await fixture(); await prepared(f, true); await grant(f); await apply(f);
    const replies = await Promise.allSettled([release(f), release(f)]);
    assert.equal(replies.filter(r => r.status === 'fulfilled').length, 1); assert.equal(replies.filter(r => r.status === 'rejected').length, 1);
    assert.deepEqual(replies.find(r => r.status === 'fulfilled').value.values, { APP_KEY: f.secret });
    safeMetadata(await row(schema.setupJobs, f.apply.dispatchId), f);
    safeMetadata(await db.select().from(schema.missionEvents).where(eq(schema.missionEvents.missionId, f.id)), f);
  });
  await check('rotation, revocation, changed source plan and stale mandate deny release without consuming its receipt', async () => {
    for (const mutation of ['rotate', 'revoke', 'plan', 'epoch']) {
      const f = await fixture(); await prepared(f, true); await grant(f); await apply(f);
      if (mutation === 'rotate') await vault.saveVaultEntry(f.owner, f.workspace, { repoUrl, expectedRevision: 1, values: { APP_KEY: 'synthetic-rotated' }, forget: [] });
      if (mutation === 'revoke') await consents.revokeEnvironmentConsent(f.owner, f.workspace, f.consent.id, { expectedRevision: f.consent.revision });
      if (mutation === 'plan') await db.update(schema.setupJobs).set({ result: { ...f.prepared, environment: { ...f.prepared.environment, command: 'npm run other' } } }).where(eq(schema.setupJobs.id, f.prepared.jobId));
      if (mutation === 'epoch') { const m = await row(schema.missions, f.id); await db.update(schema.missions).set({ mandateRevision: m.mandateRevision + 1 }).where(eq(schema.missions.id, f.id)); }
      await deny(release(f)); assert.equal((await row(schema.setupJobs, f.apply.dispatchId)).autonomy.release, undefined);
      await cleanup(f);
    }
  });
  await check('lost start response reconciles same physical identity without a duplicate start; pause still permits stop receipts', async () => {
    const f = await fixture(); await prepared(f); await apply(f, { dispatch: false }); loseStart = true;
    await assert.rejects(environment.dispatchMissionEnvironment(f.lease, f.apply.id), /lost/);
    const before = sends.filter(s => s.action === 'start').length;
    const result = await environment.reconcileMissionEnvironment(await row(schema.missions, f.id), f.apply);
    assert.equal(result.result.jobId, f.apply.dispatchId); assert.equal(sends.filter(s => s.action === 'start').length, before);
    await db.update(schema.missions).set({ lifecycle: 'paused' }).where(eq(schema.missions.id, f.id));
    await deny(environment.dispatchMissionEnvironment(f.lease, f.apply.id));
    const stopped = await environment.reconcileMissionEnvironment(await row(schema.missions, f.id), f.apply, { cancel: true });
    assert.equal(stopped.cleanupConfirmed, true); assert.equal(stopped.result.status, 'cancelled');
  });
  await check('current runtime cannot accept a callback for a different saved runtime', async () => {
    const f = await fixture(), job = await prepared(f), foreign = `${process.env.PAT_RUNTIME_SCOPE}-foreign`;
    const saved = await row(schema.setupJobs, job.jobId), execution = { ...saved.autonomy.execution, runtime: foreign };
    // Fault fixture creates a coherently bound foreign deployment's row in the
    // shared database. A current runtime must still reject that private receipt.
    const { environmentRequestFingerprint } = await import('../shared/mission-environment.mjs');
    const fingerprint = environmentRequestFingerprint(execution, saved.task, saved.autonomy.environmentExecution);
    await db.update(schema.missions).set({ runtime: foreign }).where(eq(schema.missions.id, f.id));
    await db.update(schema.setupJobs).set({ runtime: foreign, autonomy: { ...saved.autonomy, execution, fingerprint } }).where(eq(schema.setupJobs.id, saved.id));
    await deny(environment.receiveMissionEnvironmentResult({ ...job, execution, fingerprint, sequence: job.sequence + 1 }));
  });
  await check('exact worker absence permits original dispatch replay, while cancel still stops its existing sandbox', async () => {
    const f = await fixture(); await prepared(f); await apply(f, { dispatch: false }); rejectStart = true;
    await assert.rejects(environment.dispatchMissionEnvironment(f.lease, f.apply.id), /never reached/);
    const absent = await environment.reconcileMissionEnvironment(await row(schema.missions, f.id), f.apply);
    assert.equal(absent.unsubmitted, true); assert.equal(absent.cleanupConfirmed, false);
    const stopped = await environment.reconcileMissionEnvironment(await row(schema.missions, f.id), f.apply, { cancel: true });
    assert.equal(stopped.unsubmitted, true); assert.equal(stopped.cleanupConfirmed, true); assert.ok(stopped.executorResourceId);
    assert.ok(sends.some(s => s.action === 'stop' && s.id === stopped.executorResourceId));
  });
  await check('retained app rechecks consent and Vault after release, never extending its original deadline', async () => {
    for (const mutation of ['rotate', 'revoke', 'epoch', 'expired']) {
      const f = await fixture(); await prepared(f, true); await grant(f); await apply(f); await release(f);
      const saved = await row(schema.setupJobs, f.apply.dispatchId), running = jobs.get(saved.id);
      const ready = { ...running, status: 'completed', sequence: running.sequence + 1, cleanup: 'retained', executorStopped: true,
        environment: { ...f.prepared.environment, httpStatus: 200, probeKind: 'http', processId: randomUUID(), observedAt: new Date().toISOString() } };
      await environment.receiveMissionEnvironmentResult(ready);
      await db.update(schema.missionAttempts).set({ status: 'completed', finishedAt: new Date() }).where(eq(schema.missionAttempts.id, f.apply.id));
      await db.update(schema.missionTasks).set({ state: 'completed' }).where(eq(schema.missionTasks.id, f.apply.taskId));
      const input = { execution: saved.autonomy.execution, resourceId: saved.autonomy.resourceId, jobId: saved.id };
      const allowed = await environment.authorizeMissionEnvironmentRetention(input);
      assert.ok(Date.parse(allowed.retainUntil) <= f.apply.deadlineAt.getTime()); assert.ok(Date.parse(allowed.validUntil) <= (await attempts.databaseNow(db)).getTime() + 5000);
      if (mutation === 'rotate') await vault.saveVaultEntry(f.owner, f.workspace, { repoUrl, expectedRevision: 1, values: { APP_KEY: 'synthetic-rotated-after-release' }, forget: [] });
      if (mutation === 'revoke') await consents.revokeEnvironmentConsent(f.owner, f.workspace, f.consent.id, { expectedRevision: f.consent.revision });
      if (mutation === 'epoch') await db.update(schema.missions).set({ mandateRevision: saved.autonomy.execution.mandateRevision + 1 }).where(eq(schema.missions.id, f.id));
      if (mutation === 'expired') await db.update(schema.missionAttempts).set({ deadlineAt: new Date(Date.now() - 1) }).where(eq(schema.missionAttempts.id, f.apply.id));
      await deny(environment.authorizeMissionEnvironmentRetention(input));
      await cleanup(f);
    }
  });
  await check('deadline expiring while waiting for Vault lock denies release using fresh database time', async () => {
    const f = await fixture(); await prepared(f, true); await grant(f);
    const deadline = new Date(Date.now() + 1500); await apply(f, { deadlineAt: deadline });
    let unlock, entered; const held = new Promise(resolve => { unlock = resolve; }); const locked = new Promise(resolve => { entered = resolve; }); lockReleases.add(unlock);
    const holder = db.transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${vault.environmentVaultScope(f.workspace, repoUrl)}, 0))`); entered(); await held; }); pending.push(holder); await locked;
    const waiting = deny(release(f)); pending.push(waiting);
    for (let n = 0; n < 60; n++) {
      const [{ count }] = await db.execute(sql`select count(*)::int as count from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())`);
      if (count) break;
      if (n === 59) throw new Error('No actual Vault lock waiter observed'); await delay(10);
    }
    await delay(Math.max(1, deadline.getTime() - Date.now() + 75)); unlock(); lockReleases.delete(unlock); await holder; await waiting;
    assert.equal((await row(schema.setupJobs, f.apply.dispatchId)).autonomy.release, undefined);
  });
  assert.deepEqual(failures, [], 'Environment adapter regression failures');
  console.log(JSON.stringify({ status: 'passed', actualPostgreSQL: true, executor: 'synthetic HTTP', checks: checks.length, scenarios: checks }, null, 2));
} finally {
  for (const release of lockReleases) release(); await Promise.allSettled(pending);
  globalThis.fetch = originalFetch;
  for (const f of fixtures) await db.delete(schema.user).where(eq(schema.user.id, f.owner));
  await app.close();
}
