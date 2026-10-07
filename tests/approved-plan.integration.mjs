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
const planner = await import('../server/utils/mission-environment-plan.ts');
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
    const job = { ...config, fingerprint: executionHash(config), revision: 1, status: 'review', message: 'Synthetic inspected commit', logs: `HEAD ${commit}`, commit, package: null, plan: { directory: '.', runtime: 'node24' }, testExitCode: null,
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
    const isApply = input.environmentExecution.phase === 'apply' || !!input.environmentExecution.approvedPlan;
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

async function fixture(previous) {
  const owner = previous?.owner ?? randomUUID(), workspace = previous?.workspace ?? randomUUID(), thread = randomUUID();
  const f = { owner, workspace, thread, consent: previous?.consent, secret: `synthetic-secret-${randomUUID()}` }; fixtures.push(f);
  if (!previous) await db.insert(schema.user).values({ id: owner, name: 'Environment fixture', email: `${owner}@example.test` });
  if (!previous) await db.insert(schema.workspaces).values({ id: workspace, userId: owner, name: 'Environment fixture' });
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
  const reserved = await attempts.reserveMissionAttempt(f.lease, task.id, { usesModel: task.spec.kind === 'environment_setup' && task.spec.phase === 'prepare' && !task.spec.approvedPreparation, resource: { kind: 'otto', poolKey: process.env.REPO_RUNNER_URL } });
  assert.equal(reserved.status, 'reserved', JSON.stringify(reserved));
  if (deadlineAt) await db.update(schema.missionAttempts).set({ deadlineAt }).where(eq(schema.missionAttempts.id, reserved.attempt.id));
  await attempts.markMissionDispatch(f.lease, reserved.attempt.id); return row(schema.missionAttempts, reserved.attempt.id);
}
async function settled(attempt) {
  // Fixture terminal acknowledgement; the full controller's graph is covered in
  // repository-controller and the later complete environment-controller suite.
  await db.update(schema.missionAttempts).set({ status: 'completed', finishedAt: new Date() }).where(eq(schema.missionAttempts.id, attempt.id));
  await db.update(schema.missionTasks).set({ state: 'completed', sources: [{ type: attempt.kind === 'discovery' ? 'repository' : 'setup', id: attempt.dispatchId }] }).where(eq(schema.missionTasks.id, attempt.taskId));
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
    environment: { repoUrl, root: '/workspace/repository', directory: '/workspace/repository', commit, command: 'npm run dev -- --host 0.0.0.0', port: 3000, httpStatus: null, probeKind: 'identity',
      executionProfile: { version: 1, runtime: 'node24', imageDigest: `sha256:${'1'.repeat(64)}`, packageManager: 'npm', packageManagerVersion: '11.5.0', installDirectory: '/workspace/repository', lockfile: 'package-lock.json', lockfileSha256: '2'.repeat(64), ignoreScripts: true },
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

async function originals() {
  const old = await fixture();
  await prepared(old, true); await grant(old);
  await db.update(schema.missions).set({ lifecycle: 'closed', closureReason: 'blocked', closedAt: new Date(), leaseToken: null, leaseUntil: null }).where(eq(schema.missions.id, old.id));
  return old;
}
async function select(f) {
  const [discovery] = await db.select().from(schema.missionTasks).where(eq(schema.missionTasks.missionId, f.id));
  return db.transaction(async tx => {
    await control.lockMission(tx, f.id);
    return planner.planMissionEnvironment(tx, await row(schema.missions, f.id), discovery, f.inspectedRunId, commit);
  });
}
async function reused(f, selected) {
  const attempt = await reserve(f, selected);
  assert.equal(attempt.reservedTokens, 0);
  await environment.dispatchMissionEnvironment(f.lease, attempt.id);
  const job = jobs.get(attempt.dispatchId);
  assert.ok(job.environmentExecution.approvedPlan);
  assert.equal(job.environmentExecution.approvedPlan.planHash, f.consent.planHash);
  Object.assign(job, { status: 'needs_configuration', sequence: job.sequence + 1, cleanup: 'confirmed', executorStopped: true,
    updatedAt: new Date().toISOString(), usage: { providerCalls: 0, tokens: 0, accounting: 'deterministic-prepare' },
    environment: { ...job.environmentExecution.approvedPlan.plan, variables: [{ name: 'APP_KEY', required: true, reason: 'Approved requirement' }], probeKind: 'identity', httpStatus: null } });
  await environment.receiveMissionEnvironmentResult(job); await settled(attempt); f.prepared = structuredClone(job);
  return attempt;
}

try {
  await check('same approved plan gets a new current-mission identity receipt, then unchanged apply and one-shot release', async () => {
    const old = await originals(), prior = await row(schema.setupJobs, old.prepared.jobId);
    const f = await fixture(old), selected = await select(f);
    assert.equal(selected.spec.approvedPreparation.sourceSetupJobId, old.prepared.jobId);
    assert.equal(selected.spec.approvedPreparation.consentId, old.consent.id);
    await reused(f, selected);
    assert.notEqual(f.prepared.jobId, old.prepared.jobId);
    assert.notEqual(f.prepared.id, old.prepared.id);
    assert.equal(f.prepared.execution.missionId, f.id);
    assert.deepEqual(await row(schema.setupJobs, old.prepared.jobId), prior);
    const current = await row(schema.missions, f.id);
    const applyTask = await db.transaction(tx => planner.planMissionEnvironmentApply(tx, current, { ...selected, state: 'completed', sources: [{ type: 'setup', id: f.prepared.jobId }] }));
    assert.equal(applyTask.spec.consentId, old.consent.id);
    assert.equal(applyTask.spec.approvedPreparation, undefined);
    assert.equal(applyTask.spec.sourceSetupJobId, f.prepared.jobId);
    f.apply = await reserve(f, applyTask); await environment.dispatchMissionEnvironment(f.lease, f.apply.id);
    const released = await release(f);
    assert.deepEqual(Object.keys(released.values), ['APP_KEY']);
    assert.equal(released.values.APP_KEY, old.secret);
    await deny(release(f));
    safeMetadata(await row(schema.setupJobs, f.prepared.jobId), old);
  });
  await check('rotation or revocation after frozen selection denies dispatch before executor transport, without model fallback', async () => {
    for (const change of ['rotate', 'revoke']) {
      const old = await originals(), f = await fixture(old), selected = await select(f), attempt = await reserve(f, selected);
      if (change === 'rotate') await vault.saveVaultEntry(f.owner, f.workspace, { repoUrl, expectedRevision: 1, values: { APP_KEY: 'rotated-synthetic' }, forget: [] });
      else await consents.revokeEnvironmentConsent(f.owner, f.workspace, old.consent.id, { expectedRevision: 1 });
      const count = sends.length;
      await deny(environment.dispatchMissionEnvironment(f.lease, attempt.id));
      assert.equal(sends.length, count);
      assert.equal((await row(schema.missionTasks, selected.id)).spec.approvedPreparation.consentId, old.consent.id);
      await cleanup(f);
    }
  });
  await check('current executor admission rejects a revoked grant and never permits Codex for deterministic prepare', async () => {
    const old = await originals(), f = await fixture(old), selected = await select(f), attempt = await reserve(f, selected);
    await environment.dispatchMissionEnvironment(f.lease, attempt.id);
    const job = await row(schema.setupJobs, attempt.dispatchId);
    const input = { execution: job.autonomy.execution, resourceId: job.autonomy.resourceId, operationId: 'environment:approved-plan:publish', kind: 'sandbox.command', payloadHash: 'f'.repeat(64) };
    await admission.admitMissionExecutor(input);
    await deny(admission.admitMissionExecutor({ ...input, operationId: 'forbidden-model', kind: 'codex.initialize' }));
    await consents.revokeEnvironmentConsent(f.owner, f.workspace, old.consent.id, { expectedRevision: 1 });
    await deny(admission.admitMissionExecutor(input));
  });
  await check('another owner or runtime cannot select the saved grant', async () => {
    const old = await originals(), unrelated = await fixture();
    const selected = await select(unrelated);
    assert.equal(selected.spec.approvedPreparation, undefined);
    const originalRuntime = process.env.PAT_RUNTIME_SCOPE;
    try {
      process.env.PAT_RUNTIME_SCOPE = `${originalRuntime}-other`;
      const f = await fixture(old), next = await select(f);
      assert.equal(next.spec.approvedPreparation, undefined);
      await cleanup(f);
    } finally { process.env.PAT_RUNTIME_SCOPE = originalRuntime; }
  });
  await check('changed source fingerprint or selected project cannot inherit consent', async () => {
    for (const change of ['fingerprint', 'project']) {
      const old = await originals(), f = await fixture(old);
      if (change === 'fingerprint') await db.update(schema.setupJobs).set({ result: { ...old.prepared, fingerprint: 'b'.repeat(64) } }).where(eq(schema.setupJobs.id, old.prepared.jobId));
      else {
        const inspection = await row(schema.repositoryRuns, f.inspectedRunId);
        await db.update(schema.repositoryRuns).set({ job: { ...inspection.job, plan: { ...inspection.job.plan, directory: 'apps/other' } } }).where(eq(schema.repositoryRuns.id, f.inspectedRunId));
      }
      assert.equal((await select(f)).spec.approvedPreparation, undefined);
      await cleanup(f);
    }
  });
  await check('rotation while an admission waits for the original Vault lock is denied after the lock', async () => {
    const old = await originals(), f = await fixture(old), selected = await select(f), attempt = await reserve(f, selected);
    await environment.dispatchMissionEnvironment(f.lease, attempt.id);
    const job = await row(schema.setupJobs, attempt.dispatchId);
    let unlock, entered;
    const held = new Promise(resolve => { unlock = resolve; });
    const locked = new Promise(resolve => { entered = resolve; });
    lockReleases.add(unlock);
    const holder = db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${vault.environmentVaultScope(f.workspace, repoUrl)}, 0))`);
      entered(); await held;
      // Synthetic fixture-only rotation at the same lock used by the actual
      // Vault writer. No secret values need to be read or changed for this test.
      await tx.update(schema.projectEnvironments).set({ revision: 2 }).where(eq(schema.projectEnvironments.workspaceId, f.workspace));
    });
    pending.push(holder); await locked;
    const denied = deny(admission.admitMissionExecutor({ execution: job.autonomy.execution, resourceId: job.autonomy.resourceId,
      operationId: 'environment:approved-plan:publish', kind: 'sandbox.command', payloadHash: 'a'.repeat(64) }));
    pending.push(denied);
    try {
      for (let index = 0; index < 100; index++) {
        const [{ count }] = await db.execute(sql`select count(*)::int as count from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())`);
        if (count) break;
        if (index === 99) throw Error('The scoped synthetic test did not reach a Vault lock wait');
        await delay(10);
      }
      unlock(); await holder; await denied;
      assert.equal((await row(schema.setupJobs, job.id)).autonomy.release, undefined);
    } finally {
      // Release before check() enters fixture cleanup, which needs the mission
      // lock held by the blocked admission. Assertion failure must not deadlock.
      unlock(); lockReleases.delete(unlock);
      await Promise.allSettled([holder, denied]);
    }
  });
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ status: 'passed', actualPostgreSQL: true, executor: 'synthetic HTTP only', checks: checks.length, scenarios: checks }));
} finally {
  for (const release of lockReleases) release();
  await Promise.allSettled(pending);
  globalThis.fetch = originalFetch;
  try {
    for (const owner of new Set(fixtures.map(f => f.owner))) {
      await db.delete(schema.threads).where(eq(schema.threads.userId, owner));
      await db.delete(schema.user).where(eq(schema.user.id, owner));
    }
  } finally { await app.close(); }
}
