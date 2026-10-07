// Actual isolated PostgreSQL, authored controller/graph/preview/admission and
// evidence persistence. Runner HTTP, browser DOM and models are synthetic.
// This is lifecycle/fault verification, not physical browser acceptance.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { runInNewContext } from 'node:vm';
import { and, eq } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';
import { executionHash } from '../infra/execution/admission.mjs';
import { validate } from '../infra/repo-runner/runner.mjs';
import { environmentPlanHash } from '../shared/mission-environment.mjs';
import { browserPolicyDigest } from '../infra/browser/policy.mjs';

process.env.REPO_RUNNER_URL = `http://${randomUUID()}.preview-controller.fixture.invalid`;
process.env.REPO_RUNNER_KEY = 'synthetic-preview-controller';
process.env.ENV_VAULT_KEY = `synthetic-preview-controller-${randomUUID()}`;
const contexts = new Map(), jobs = new Map(), previewSessions = new Map(), observed = [], transport = [];
const origin = 'http://172.30.0.20:3000', commit = 'a'.repeat(40), repoUrl = 'https://github.com/fixture/preview';
const previewModule = new URL('../server/utils/mission-preview.ts', import.meta.url).href;
const browserModule = new URL('../server/utils/browser.ts', import.meta.url).href;
globalThis.previewControllerChromium = { async connectOverCDP(url) {
  const attemptId = new URL(url).pathname.slice(1), session = previewSessions.get(attemptId); assert.ok(session);
  const f = contexts.get(session.execution.missionId);
  const [claim] = await h.db.select().from(h.schema.missionResourceClaims).where(eq(h.schema.missionResourceClaims.attemptId, attemptId));
  assert.equal(claim.executorResourceId, session.sessionId, 'Discovery must bind its actual physical session before CDP');
  return { contexts: () => [{ async newPage() { return {
    async goto(value) { assert.equal(value, f.origin ?? origin); observed.push({ attemptId, missionId: f.id }); if (f.navigationError) throw new Error('Synthetic ambiguous navigation'); return { status: () => 200 }; },
    async evaluate(callback) {
      const value = f.dom ?? { title: 'Synthetic app', text: 'Read public articles.', links: [{ url: `${f.origin ?? origin}/articles`, label: 'Articles' }] };
      return runInNewContext(`(${callback.toString()})()`, { document: { title: value.title, body: { innerText: value.text }, querySelectorAll: () => value.links.map(link => ({ href: link.url, textContent: link.label })) } });
    },
    url: () => f.pageUrl ?? `${f.origin ?? origin}/`,
  }; } }], async close() {
    if (f.crashAfterObservation) { f.crashAfterObservation = false; await h.db.update(h.schema.missions).set({ leaseUntil: new Date(0) }).where(eq(h.schema.missions.id, f.id)); }
  } };
} };
const browserHook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === previewModule && specifier === 'playwright-core') return { url: 'data:text/javascript,export const chromium = globalThis.previewControllerChromium;', shortCircuit: true };
  // This regression ends deliberately at CDP connection: it must first complete
  // the actual nested preview admission/retention callbacks without deadlock.
  if (context.parentURL === browserModule && specifier === 'playwright-core') return { url: 'data:text/javascript,export const chromium = { async connectOverCDP() { throw new Error("Synthetic CDP boundary reached"); } };', shortCircuit: true };
  return next(specifier, context);
} });
const h = await controllerFixture(), { db, schema } = h;
const admission = await import('../server/utils/mission-executor-admission.ts');
const environment = await import('../server/utils/mission-environment.ts');
const previews = await import('../server/utils/mission-preview.ts');
const consents = await import('../server/utils/environment-consents.ts');
const vault = await import('../server/utils/project-vault.ts');
const originalBrowser = h.scripts.browserJobAction;
h.scripts.browserJobAction = async (...args) => {
  const input = args[2];
  if (input.action === 'start') {
    const [attempt] = await db.select().from(schema.missionAttempts).where(eq(schema.missionAttempts.dispatchId, input.jobId));
    if (!contexts.get(attempt.missionId).actualBrowserAction) {
      const session = await previews.openMissionPreview(attempt.id); assert.equal(session.policy.allowedOrigins[0], contexts.get(attempt.missionId).origin ?? origin);
    }
  }
  return originalBrowser(...args);
};
const originalBrowserRequest = h.scripts.vpsBrowserRequest;
h.scripts.vpsBrowserRequest = async (path, method, previewId) => {
  if (!previewId) return originalBrowserRequest(path, method, previewId);
  const session = [...previewSessions.values()].find(value => value.sandboxId === previewId); assert.ok(session);
  const application = [...jobs.values()].find(value => value.id === previewId && value.environmentExecution?.phase === 'apply'); assert.ok(application);
  if (path === '/heartbeat') {
    const receipt = await environment.authorizeMissionEnvironmentRetention({ execution: application.execution, resourceId: application.id, jobId: application.jobId }); assert.equal(receipt.allowed, true);
    await admission.admitMissionExecutor({ execution: session.execution, resourceId: session.execution.dispatchId, operationId: 'preview:session', kind: 'environment.preview', payloadHash: session.requestHash });
    return { renewed: true };
  }
  if (method === 'DELETE') { previewSessions.delete(session.execution.attemptId); return { closed: true }; }
  assert.equal(method, 'GET'); assert.equal(path, `/sessions/${session.sessionId}`); return session;
};
const fakeFetch = async (url, options = {}) => {
  assert.ok(String(url).startsWith(process.env.REPO_RUNNER_URL), 'No public research or arbitrary internal network is allowed');
  const parsed = new URL(url), input = options.body ? JSON.parse(options.body) : null;
  transport.push({ path: parsed.pathname, action: input?.action, id: input?.jobId ?? input?.id });
  if (parsed.pathname === '/health') return Response.json({ autonomousExecution: { version: 1, admission: true, frozenCommit: true, environment: true } });
  if (parsed.pathname === '/jobs' && options.method === 'GET') return Response.json({ jobs: (parsed.searchParams.get('ids') || '').split(',').flatMap(id => jobs.has(id) ? [jobs.get(id)] : []) });
  if (parsed.pathname === '/jobs') {
    const config = validate(input), at = new Date().toISOString();
    await admission.admitMissionExecutor({ execution: config.execution, resourceId: config.id, operationId: 'job', kind: 'repository.inspect', payloadHash: executionHash(config) });
    const job = { ...config, fingerprint: executionHash(config), revision: 1, status: 'review', message: 'Observed app repository', logs: `HEAD ${commit}`, commit,
      package: { name: 'fixture', scripts: { dev: 'node server.js' }, packageManager: 'npm', lock: true }, plan: null, testExitCode: null,
      createdAt: at, updatedAt: at, finishedAt: at, cleanup: { resourceId: config.id, confirmed: true, observedAt: at } };
    jobs.set(job.id, job); return Response.json(job);
  }
  if (parsed.pathname === '/sandbox') {
    if (input.action === 'ensure') await admission.admitMissionExecutor({ execution: input.execution, resourceId: input.id, operationId: input.operationId, kind: 'sandbox.ensure', payloadHash: executionHash(input) });
    if (input.action === 'stop') {
      assert.ok(![...previewSessions.values()].some(session => session.sandboxId === input.id), 'Environment cannot stop before its physical preview');
    }
    return Response.json({ id: input.id, status: input.action === 'stop' ? 'stopped' : 'ready' });
  }
  if (parsed.pathname === '/preview') {
    const f = contexts.get(input.execution.missionId); assert.ok(f);
    const currentOrigin = f.origin ?? origin;
    const application = jobs.get(input.expectedEnvironment.jobId); assert.ok(application);
    assert.equal(input.expectedEnvironment.planHash, application.environmentExecution.planHash); assert.equal(input.expectedEnvironment.processId, application.environment.processId);
    if (input.action === 'target') return Response.json({ origin: currentOrigin, envJobId: application.jobId, planHash: application.environmentExecution.planHash });
    const requestHash = executionHash({ sandboxId: input.id, port: input.port, execution: input.execution, policy: input.policy, expectedEnvironment: input.expectedEnvironment });
    const saved = previewSessions.get(input.execution.attemptId);
    if (saved) assert.equal(saved.requestHash, requestHash);
    if (input.action === 'open') {
      await admission.admitMissionExecutor({ execution: input.execution, resourceId: input.execution.dispatchId, operationId: 'preview:create', kind: 'environment.preview', payloadHash: requestHash });
      assert.equal(input.policy.allowedOrigins[0], currentOrigin); assert.equal(input.policy.readOnly, true);
      const [claim] = await db.select().from(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, input.execution.attemptId));
      assert.equal(claim.executorResourceId, null, 'Unknown physical session remains an unbound reservation before provider acknowledgement');
      assert.equal((await h.row(schema.missionAttempts, input.execution.attemptId)).executorResourceId, input.execution.dispatchId);
      const session = saved ?? { requestHash, execution: input.execution, sandboxId: input.id, sessionId: randomUUID(), previewUrl: currentOrigin,
        connectUrl: `ws://synthetic.preview/${input.execution.attemptId}`, liveUrl: 'https://synthetic.preview/viewer', expiresAt: input.policy.deadlineAt, policyVersion: 1, policyDigest: browserPolicyDigest(input.policy) };
      previewSessions.set(input.execution.attemptId, session);
      if (f.losePreviewAck) { f.losePreviewAck = false; throw new Error('Synthetic open accepted but acknowledgement lost'); }
      return Response.json(session);
    }
    if (input.action === 'close') {
      if (f.unknownCleanup) throw new Error('Synthetic physical cleanup unavailable');
      previewSessions.delete(input.execution.attemptId); return Response.json({ confirmed: true });
    }
    assert.equal(input.action, 'status'); return Response.json({ ...(saved ? { session: saved } : {}), absent: !saved, cleanupConfirmed: !saved && !f.unknownCleanup });
  }
  assert.equal(parsed.pathname, '/codex');
  const saved = await h.row(schema.setupJobs, input.jobId); assert.ok(saved?.autonomy);
  const f = contexts.get(saved.autonomy.execution.missionId); assert.ok(f);
  if (input.action === 'mission_retain') {
    if (f.rejectRetention) throw new Error('Synthetic worker denies retaining expired app');
    const receipt = await environment.authorizeMissionEnvironmentRetention({ execution: input.execution, resourceId: input.id, jobId: input.jobId });
    return Response.json({ retained: true, jobId: input.jobId, id: input.id, expiresAt: receipt.retainUntil });
  }
  if (input.action === 'start') {
    const isApply = input.environmentExecution.phase === 'apply';
    await admission.admitMissionExecutor({ execution: input.execution, resourceId: input.id, operationId: isApply ? 'environment:init' : 'codex:start', kind: isApply ? 'sandbox.command' : 'codex.initialize', payloadHash: executionHash(input) });
    if (isApply) await environment.releaseMissionEnvironment({ execution: input.execution, resourceId: input.id, operationId: 'environment:release', planHash: input.environmentExecution.planHash, sourceSetupJobId: input.environmentExecution.sourceSetupJobId });
    const plan = isApply ? input.environmentExecution.plan : { repoUrl, root: '/workspace/environment', directory: '/workspace/environment', commit, command: 'npm run dev -- --host 0.0.0.0', port: 3000,
      executionProfile: { version: 1, runtime: 'node24', imageDigest: `sha256:${'1'.repeat(64)}`, packageManager: 'npm', packageManagerVersion: '11.5.0', installDirectory: '/workspace/environment', lockfile: 'package-lock.json', lockfileSha256: '2'.repeat(64), ignoreScripts: true },
      variables: f.required ? [{ name: 'APP_KEY', required: true, reason: 'Synthetic setting' }] : [] };
    const result = { jobId: saved.id, id: input.id, workspaceId: saved.workspaceId, status: isApply || !f.required ? 'completed' : 'needs_configuration', message: 'Synthetic isolated environment result',
      updatedAt: new Date().toISOString(), sequence: 1, execution: saved.autonomy.execution, environmentExecution: saved.autonomy.environmentExecution, fingerprint: saved.autonomy.fingerprint,
      cleanup: isApply ? 'retained' : 'confirmed', executorStopped: true,
      environment: { ...plan, variables: plan.variables.map(variable => ({ ...variable, reason: variable.reason ?? 'Explicit variable from the verified plan' })), ...(isApply ? { processId: randomUUID(), probeKind: 'http', observedAt: new Date().toISOString(), httpStatus: 200 } : { httpStatus: null }) } };
    jobs.set(saved.id, result);
  } else if (input.action === 'cancel') {
    const result = jobs.get(saved.id); Object.assign(result, { status: 'cancelled', cleanup: 'confirmed', executorStopped: true, updatedAt: new Date().toISOString(), sequence: result.sequence + 1 });
  } else assert.equal(input.action, 'mission_status');
  return Response.json(jobs.get(saved.id));
};
globalThis.fetch = fakeFetch;

const checks = [], failures = [];
async function check(name, fn) {
  try { await fn(); checks.push(name); console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, message: error.message, stack: error.stack }); console.error(`FAIL ${name}: ${error.message}`); }
  finally {
    // Remove only this test's isolated fixture rows between scenarios so an
    // intentionally uncertain claim cannot block an unrelated synthetic test.
    for (const f of contexts.values()) {
      await db.delete(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.missionId, f.id));
      await db.update(schema.missions).set({ lifecycle: 'closed', status: 'closed' }).where(eq(schema.missions.id, f.id));
    }
    contexts.clear(); previewSessions.clear(); jobs.clear();
  }
}
async function fixture(options = {}) {
  const f = await h.fixture({ target: { kind: 'repository', url: repoUrl, ref: 'main', surface: 'application' }, goal: 'Starta appen och testa den i webbläsaren. Rapportera sparade observationer.' });
  Object.assign(f, options); contexts.set(f.id, f); return f;
}
const previewsFor = f => observed.filter(value => value.missionId === f.id);
async function complete(f) { await h.finishBrowser(f); const closed = await h.settle(f, 20); await h.reconcileClosedMissionResources(); await h.reconcileClosedMissionResources(); return closed; }
try {
  await check('inspect → prepare → apply → saved preview observation → plan → Iris → review/report retains the app until browser cleanup', async () => {
    const f = await fixture(), ready = await h.browserReady(f);
    assert.equal(previewsFor(f).length, 1); assert.equal(h.calls.filter(c => c.kind === 'research' && c.missionId === f.id).length, 0);
    assert.equal(ready.mission.config.target.url, `${origin}/`); assert.equal(ready.mission.config.target.revision, commit);
    assert.equal(ready.claims.length, 2); assert.equal(ready.tasks.find(t => t.spec.kind === 'preview_discovery').state, 'completed');
    const browser = ready.tasks.find(t => t.spec.kind === 'browser_tests'); assert.equal(browser.spec.target.url, `${origin}/`);
    const discovery = ready.attempts.find(a => a.kind === 'preview_discovery'); assert.ok(!previewSessions.has(discovery.id), 'Discovery physical session is closed before Iris');
    const closed = await complete(f); assert.equal(closed.mission.lifecycle, 'closed'); assert.equal(closed.reports.length, 1); assert.equal(closed.reports[0].document.partial, true);
    assert.equal((await h.state(f)).claims.length, 0); assert.equal(previewSessions.size, 0);
  });
  await check('lost preview-open acknowledgement closes the exact original session and produces a bounded partial report, never a new navigation', async () => {
    const f = await fixture({ losePreviewAck: true }), closed = await h.settle(f, 20);
    assert.equal(previewsFor(f).length, 0); assert.equal(closed.reports.length, 1); assert.equal(closed.reports[0].document.partial, true);
    assert.equal(closed.attempts.filter(a => a.kind === 'preview_discovery').length, 1); assert.equal(closed.tasks.filter(t => t.spec.kind === 'planning').length, 0);
    assert.equal(previewSessions.size, 0); await h.reconcileClosedMissionResources(); assert.equal((await h.state(f)).claims.length, 0);
  });
  await check('restart after atomic observation commit recovers saved source without a second navigation or plan', async () => {
    const f = await fixture({ crashAfterObservation: true }); await h.browserReady(f);
    assert.equal(previewsFor(f).length, 1); const state = await h.state(f); assert.equal(state.tasks.filter(t => t.spec.kind === 'planning').length, 1);
    assert.equal(state.attempts.filter(a => a.kind === 'preview_discovery').length, 1); await complete(f);
  });
  await check('unknown preview cleanup retains BOTH browser and app claims through partial reporting; a later physical receipt releases them in order', async () => {
    const f = await fixture({ unknownCleanup: true }), closed = await h.settle(f, 20);
    assert.equal(closed.reports.length, 1); assert.equal(closed.claims.length, 2); assert.equal(previewsFor(f).length, 1);
    await h.reconcileClosedMissionResources(); assert.equal((await h.state(f)).claims.length, 2);
    f.unknownCleanup = false; await h.reconcileClosedMissionResources(); await h.reconcileClosedMissionResources();
    assert.equal((await h.state(f)).claims.length, 0); assert.equal(previewSessions.size, 0);
  });
  await check('a legitimate consent epoch change preserves already-consumed inspection and preparation while apply uses the new mandate', async () => {
    const f = await fixture({ required: true }); const waiting = await h.until(f, s => s.tasks.some(t => t.state === 'waiting'));
    const preparation = waiting.tasks.find(t => t.spec.kind === 'environment_setup' && t.spec.phase === 'prepare');
    const source = await h.row(schema.setupJobs, preparation.sources.find(s => s.type === 'setup').id);
    const saved = await vault.saveVaultEntry(h.owner, f.workspace, { repoUrl, expectedRevision: 0, values: { APP_KEY: 'synthetic-preview-setting' }, forget: [] });
    const grant = await consents.grantEnvironmentConsent(h.owner, f.workspace, source.id, { requestId: randomUUID(), expectedPlanHash: environmentPlanHash(source.result.environment), expectedVaultRevision: saved.revision, allowedNames: ['APP_KEY'] });
    const [wait] = await db.select().from(schema.missionWaits).where(and(eq(schema.missionWaits.missionId, f.id), eq(schema.missionWaits.state, 'waiting')));
    await h.control.controlMission(h.owner, f.workspace, f.thread, { action: 'answer', missionId: f.id, requestId: randomUUID(), expectedMandateRevision: waiting.mission.mandateRevision, waitId: wait.id, answer: { kind: 'environment_consent', consentId: grant.id } });
    const ready = await h.browserReady(f); assert.equal(ready.tasks.find(t => t.spec.kind === 'discovery').state, 'completed'); assert.equal(ready.tasks.find(t => t.id === preparation.id).state, 'completed');
    const old = ready.attempts.find(a => a.taskId === preparation.id), apply = ready.attempts.find(a => ready.tasks.find(t => t.id === a.taskId)?.spec.phase === 'apply');
    assert.equal(old.mandateRevision, waiting.mission.mandateRevision); assert.equal(apply.mandateRevision, waiting.mission.mandateRevision + 1);
    assert.equal(previewsFor(f).length, 1); await complete(f);
  });
  await check('a physical retention denial blocks further browser actions and cleans the retained environment', async () => {
    const f = await fixture(); await h.until(f, s => s.tasks.some(t => t.spec.kind === 'preview_discovery' && t.state === 'completed'));
    f.rejectRetention = true; const closed = await h.settle(f, 20);
    assert.equal(closed.reports.length, 1); assert.equal(closed.tasks.filter(t => t.spec.kind === 'browser_tests').length, 0); await h.reconcileClosedMissionResources(); assert.equal((await h.state(f)).claims.length, 0);
  });
  await check('pause after saved observation prevents planning but preserves the original receipt and cleans both resources', async () => {
    const f = await fixture({ crashAfterObservation: true });
    await h.until(f, () => previewsFor(f).length === 1);
    const [before] = await db.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, f.id), eq(schema.missionEvents.kind, 'preview.observation'))); assert.ok(before);
    await h.operate(f, 'pause'); await h.pass(f); await h.pass(f);
    const paused = await h.state(f); assert.equal(paused.mission.lifecycle, 'paused'); assert.equal(paused.tasks.filter(t => t.spec.kind === 'planning').length, 0);
    assert.equal(paused.claims.length, 0); assert.equal(previewSessions.size, 0); assert.equal(previewsFor(f).length, 1);
    assert.deepEqual((await h.row(schema.missionEvents, before.id)).payload, before.payload);
    assert.ok(await h.row(schema.workspaceItems, before.payload.itemId));
  });
  await check('revoked consent after apply prevents preview planning and cancels the retained physical environment', async () => {
    const f = await fixture({ required: true }); const waiting = await h.until(f, s => s.tasks.some(t => t.state === 'waiting'));
    const preparation = waiting.tasks.find(t => t.spec.kind === 'environment_setup' && t.spec.phase === 'prepare'), source = await h.row(schema.setupJobs, preparation.sources.find(s => s.type === 'setup').id);
    const saved = await vault.saveVaultEntry(h.owner, f.workspace, { repoUrl, expectedRevision: 0, values: { APP_KEY: 'synthetic-preview-revoked' }, forget: [] });
    const grant = await consents.grantEnvironmentConsent(h.owner, f.workspace, source.id, { requestId: randomUUID(), expectedPlanHash: environmentPlanHash(source.result.environment), expectedVaultRevision: saved.revision, allowedNames: ['APP_KEY'] });
    const [wait] = await db.select().from(schema.missionWaits).where(and(eq(schema.missionWaits.missionId, f.id), eq(schema.missionWaits.state, 'waiting')));
    await h.control.controlMission(h.owner, f.workspace, f.thread, { action: 'answer', missionId: f.id, requestId: randomUUID(), expectedMandateRevision: waiting.mission.mandateRevision, waitId: wait.id, answer: { kind: 'environment_consent', consentId: grant.id } });
    await h.until(f, s => s.tasks.some(t => t.spec.kind === 'preview_discovery' && t.state === 'completed'));
    // Explicit revocation fault. The mission epoch itself is unchanged, so the
    // next controller retention pass must consult the current consent row.
    await db.update(schema.environmentConsents).set({ revokedAt: new Date(), revision: grant.revision + 1 }).where(eq(schema.environmentConsents.id, grant.id));
    const closed = await h.settle(f, 20); assert.equal(closed.reports.length, 1); assert.equal(closed.tasks.filter(t => t.spec.kind === 'browser_tests').length, 0);
    assert.equal(closed.reports[0].document.partial, true); await h.reconcileClosedMissionResources(); assert.equal((await h.state(f)).claims.length, 0);
  });
  await check('actual browserAction releases consent locks before preview and heartbeat callback transactions', async () => {
    const f = await fixture({ required: true, actualBrowserAction: true }); const waiting = await h.until(f, s => s.tasks.some(t => t.state === 'waiting'));
    const preparation = waiting.tasks.find(t => t.spec.kind === 'environment_setup' && t.spec.phase === 'prepare'), source = await h.row(schema.setupJobs, preparation.sources.find(s => s.type === 'setup').id);
    const saved = await vault.saveVaultEntry(h.owner, f.workspace, { repoUrl, expectedRevision: 0, values: { APP_KEY: 'synthetic-browser-consent-lock' }, forget: [] });
    const grant = await consents.grantEnvironmentConsent(h.owner, f.workspace, source.id, { requestId: randomUUID(), expectedPlanHash: environmentPlanHash(source.result.environment), expectedVaultRevision: saved.revision, allowedNames: ['APP_KEY'] });
    const [wait] = await db.select().from(schema.missionWaits).where(and(eq(schema.missionWaits.missionId, f.id), eq(schema.missionWaits.state, 'waiting')));
    await h.control.controlMission(h.owner, f.workspace, f.thread, { action: 'answer', missionId: f.id, requestId: randomUUID(), expectedMandateRevision: waiting.mission.mandateRevision, waitId: wait.id, answer: { kind: 'environment_consent', consentId: grant.id } });
    const ready = await h.browserReady(f), attempt = ready.attempts.find(value => value.kind === 'browser_tests'), task = ready.tasks.find(value => value.id === attempt.taskId);
    const sessionId = `synthetic-iris-${randomUUID()}`;
    await db.update(schema.browserJobs).set({ sessionId }).where(eq(schema.browserJobs.id, attempt.dispatchId));
    const { testRunAction } = await import('../server/utils/test-runs.ts'), { browserAction } = await import('../server/utils/browser.ts');
    const [itemId, caseId] = task.spec.caseKeys[0].split(':');
    const run = await testRunAction(h.owner, f.workspace, f.thread, { action: 'start', itemId, caseId, expectedVersion: task.spec.planVersions[0].version, requestId: randomUUID(),
      environment: task.spec.target.environment, target: task.spec.target, mission: { missionId: f.id, taskId: task.id } }, { execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } });
    const started = Date.now();
    const result = await browserAction(h.owner, f.thread, { action: 'open', runId: run.id, url: run.snapshot.entryUrl }, sessionId, { browserJobId: attempt.dispatchId, executorSessionId: sessionId, callId: randomUUID() });
    assert.equal(result.status, 'action_failed'); assert.equal(result.phase, 'connect', 'Both nested admission and retention callbacks finished before the synthetic CDP fault');
    assert.ok(Date.now() - started < 5000, 'No SQL lock wait against the outer browser transaction');
    assert.ok(previewSessions.has(attempt.id));
    const physical = previewSessions.get(attempt.id);
    const [claim] = await db.select().from(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, attempt.id));
    assert.equal(claim.executorResourceId, physical.sessionId); assert.notEqual(claim.executorResourceId, attempt.dispatchId);
    assert.equal((await h.row(schema.missionAttempts, attempt.id)).executorResourceId, attempt.dispatchId);
    await h.operate(f, 'cancel'); await h.pass(f); await h.pass(f);
    await h.reconcileClosedMissionResources(); assert.equal((await h.state(f)).claims.length, 0); assert.equal(previewSessions.size, 0);
  });
  await check('preview heartbeat binds dispatch to the immutable physical receipt and rejects forged sessions, receipt hashes and claim fences', async () => {
    const f = await fixture(), state = await h.browserReady(f), attempt = state.attempts.find(value => value.kind === 'browser_tests');
    const session = previewSessions.get(attempt.id), input = { execution: session.execution, resourceId: attempt.dispatchId,
      operationId: 'preview:session', kind: 'environment.preview', payloadHash: session.requestHash };
    const [claim] = await db.select().from(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, attempt.id));
    const [opened] = await db.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, f.id), eq(schema.missionEvents.eventKey, `preview-opened:${attempt.id}`)));
    assert.equal(claim.executorResourceId, session.sessionId); assert.equal(opened.payload.sessionId, session.sessionId);
    assert.equal((await admission.admitMissionExecutor(input)).allowed, true);
    const before = (await h.row(schema.missionAttempts, attempt.id)).toolCalls;
    assert.equal((await admission.admitMissionExecutor(input)).allowed, true);
    assert.equal((await h.row(schema.missionAttempts, attempt.id)).toolCalls, before, 'Heartbeat replay does not recharge the operation');
    const starts = transport.filter(value => value.path === '/preview' && value.action === 'open').length;
    for (const changed of [{ executorResourceId: randomUUID() }, { executorResourceId: attempt.dispatchId }, { executorResourceId: null }, { fence: claim.fence + 1 }, { leaseToken: randomUUID() }]) {
      await db.update(schema.missionResourceClaims).set(changed).where(eq(schema.missionResourceClaims.id, claim.id));
      await assert.rejects(admission.admitMissionExecutor(input), error => error.statusCode === 409);
      await assert.rejects(previews.openMissionPreview(attempt.id), error => error.statusCode === 409);
      await db.update(schema.missionResourceClaims).set({ executorResourceId: claim.executorResourceId, fence: claim.fence, leaseToken: claim.leaseToken }).where(eq(schema.missionResourceClaims.id, claim.id));
    }
    for (const changed of [{ sessionId: randomUUID() }, { sandboxId: randomUUID() }, { attemptId: randomUUID() }, { requestHash: '0'.repeat(64) }]) {
      await db.update(schema.missionEvents).set({ payload: { ...opened.payload, ...changed } }).where(eq(schema.missionEvents.id, opened.id));
      await assert.rejects(admission.admitMissionExecutor(input), error => error.statusCode === 409);
      await assert.rejects(previews.openMissionPreview(attempt.id), error => error.statusCode === 409);
      await db.update(schema.missionEvents).set({ payload: opened.payload }).where(eq(schema.missionEvents.id, opened.id));
    }
    assert.equal(transport.filter(value => value.path === '/preview' && value.action === 'open').length, starts, 'No denied binding can create another physical session');
    assert.equal((await admission.admitMissionExecutor(input)).allowed, true);
    await h.operate(f, 'cancel'); await h.pass(f); await h.pass(f); await h.reconcileClosedMissionResources();
    assert.equal((await h.state(f)).claims.length, 0); assert.equal(previewSessions.size, 0);
  });
  await check('existing preview intent uses status-only and idempotent receipt; confirmed absence never creates a replacement session', async () => {
    const f = await fixture(), state = await h.browserReady(f), attempt = state.attempts.find(value => value.kind === 'browser_tests');
    const first = previewSessions.get(attempt.id), starts = transport.filter(value => value.path === '/preview' && value.action === 'open').length;
    const receipt = await previews.openMissionPreview(attempt.id); assert.equal(receipt.session.sessionId, first.sessionId);
    assert.equal(transport.filter(value => value.path === '/preview' && value.action === 'open').length, starts);
    const events = await db.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, f.id), eq(schema.missionEvents.eventKey, `preview-opened:${attempt.id}`))); assert.equal(events.length, 1);
    previewSessions.delete(attempt.id); await assert.rejects(previews.openMissionPreview(attempt.id));
    assert.equal(transport.filter(value => value.path === '/preview' && value.action === 'open').length, starts);
    await h.operate(f, 'cancel'); await h.pass(f); await h.pass(f);
  });
  await check('lost Iris preview acknowledgement keeps an unbound claim until exact status recovery binds the original physical session', async () => {
    const f = await fixture({ actualBrowserAction: true }), state = await h.browserReady(f), attempt = state.attempts.find(value => value.kind === 'browser_tests');
    const before = transport.filter(value => value.path === '/preview' && value.action === 'open').length;
    f.losePreviewAck = true;
    await assert.rejects(previews.openMissionPreview(attempt.id), /acknowledgement lost/);
    const original = previewSessions.get(attempt.id); assert.ok(original);
    const [unbound] = await db.select().from(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, attempt.id));
    assert.equal(unbound.executorResourceId, null); assert.equal(unbound.state, 'claimed');
    const receipt = await previews.openMissionPreview(attempt.id); assert.equal(receipt.session.sessionId, original.sessionId);
    assert.equal((await h.row(schema.missionResourceClaims, unbound.id)).executorResourceId, original.sessionId);
    assert.equal(transport.filter(value => value.path === '/preview' && value.action === 'open').length, before + 1);
    await h.operate(f, 'cancel'); await h.pass(f); await h.pass(f); await h.reconcileClosedMissionResources();
    assert.equal((await h.state(f)).claims.length, 0); assert.equal(previewSessions.size, 0);
  });
  await check('explicit repository-app resume resolves a new server-assigned origin without rewriting the historical target', async () => {
    const f = await fixture(); await h.until(f, s => s.tasks.some(t => t.spec.kind === 'preview_discovery' && t.state === 'completed'));
    // Finish the first bounded scope before spending an Iris reservation. Resume
    // correctly keeps the accumulated mission budget; it does not reset it.
    await h.operate(f, 'cancel'); const closed = await h.settle(f, 20); await h.reconcileClosedMissionResources();
    const original = await h.row(schema.missionSnapshots, closed.reports[0].snapshotId); assert.equal(original.input.config.target.url, `${origin}/`);
    // This transport has no opaque tools: every synthetic physical operation
    // above passed the actual admission endpoint. Supply its exact final count
    // so this origin test does not instead exhaust conservative unknown budgets.
    for (const attempt of closed.attempts.filter(value => value.kind !== 'report')) await db.update(schema.missionAttempts).set({ usage: { ...attempt.usage, toolCalls: attempt.toolCalls } }).where(eq(schema.missionAttempts.id, attempt.id));
    f.origin = 'http://172.30.0.22:3000'; await h.operate(f, 'resume'); assert.equal((await h.state(f)).mission.config.target, null);
    const ready = await h.until(f, s => s.attempts.some(value => value.kind === 'browser_tests' && value.planRevision === s.mission.planRevision));
    assert.equal(ready.mission.config.target.url, `${f.origin}/`); assert.equal((await h.row(schema.missionSnapshots, original.id)).input.config.target.url, `${origin}/`);
    await h.operate(f, 'cancel'); await h.pass(f); await h.pass(f);
  });
  await check('preview DOM redacts known quoted/backslash values before serialization and omits oversized fields without leaking prefixes', async () => {
    const secret = 'SYNTHETIC-private-"quoted"-\\backslash-secret';
    const f = await fixture({ dom: { title: `App ${secret}`, text: 'x'.repeat(11990) + secret, links: [{ url: `${origin}/articles`, label: `Link ${secret}` }, { url: `${origin}/help`, label: 'x'.repeat(155) + secret }] } });
    await vault.saveVaultEntry(h.owner, f.workspace, { repoUrl, expectedRevision: 0, values: { APP_KEY: secret }, forget: [] });
    await h.until(f, s => s.tasks.some(value => value.spec.kind === 'preview_discovery' && value.state === 'completed'));
    const [event] = await db.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, f.id), eq(schema.missionEvents.kind, 'preview.observation')));
    const item = await h.row(schema.workspaceItems, event.payload.itemId), source = JSON.parse(item.content.text);
    assert.ok(!JSON.stringify(item).includes('SYNTHETIC-private')); assert.match(source.title, /REDACTED/); assert.match(source.links[0].label, /REDACTED/);
    assert.equal(source.text, ''); assert.equal(source.links[1].label, ''); assert.equal(source.omittedOversizedContent, true);
    await h.operate(f, 'cancel'); await h.pass(f); await h.pass(f);
  });
  await check('a final observed URL containing a known Vault value cannot become immutable source provenance', async () => {
    const secret = 'SYNTHETIC-preview-url-secret', f = await fixture({ pageUrl: `${origin}/?echo=${secret}` });
    await vault.saveVaultEntry(h.owner, f.workspace, { repoUrl, expectedRevision: 0, values: { APP_KEY: secret }, forget: [] });
    const closed = await h.settle(f, 20); assert.equal(closed.reports.length, 1); assert.equal(closed.reports[0].document.partial, true);
    const events = await db.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, f.id), eq(schema.missionEvents.kind, 'preview.observation'))); assert.equal(events.length, 0);
    const items = await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, f.workspace)); assert.ok(!JSON.stringify(items).includes(secret));
  });
  console.log(JSON.stringify({ passed: checks.length, failures }, null, 2)); if (failures.length) process.exitCode = 1;
} finally { await h.close(); browserHook.deregister(); delete globalThis.previewControllerChromium; }
