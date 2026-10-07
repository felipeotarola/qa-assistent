// Actual isolated PostgreSQL, authored controller/graph/preview/admission and
// evidence persistence. Runner HTTP, browser DOM and models are synthetic.
// This is lifecycle/fault verification, not physical browser acceptance.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';
import { executionHash } from '../infra/execution/admission.mjs';
import { validate } from '../infra/repo-runner/runner.mjs';
import { environmentPlanHash } from '../shared/mission-environment.mjs';
import { browserPolicyDigest } from '../infra/browser/policy.mjs';
import { previewHandoffHash } from '../shared/preview-handoff.mjs';
import { runChecks } from '../shared/test-run.ts';

process.env.REPO_RUNNER_URL = `http://${randomUUID()}.preview-controller.fixture.invalid`;
process.env.REPO_RUNNER_KEY = 'synthetic-preview-controller';
process.env.ENV_VAULT_KEY = `synthetic-preview-controller-${randomUUID()}`;
const contexts = new Map(), jobs = new Map(), previewSessions = new Map(), observed = [], transport = [];
const origin = 'http://172.30.0.20:3000', commit = 'a'.repeat(40), repoUrl = 'https://github.com/fixture/preview';
// Overlay retains authored module URLs even when this entry is private.
const previewModule = pathToFileURL(resolve('server/utils/mission-preview.ts')).href;
const browserModule = pathToFileURL(resolve('server/utils/browser.ts')).href;
let previewHookMatches = 0, browserHookMatches = 0;
globalThis.previewBrowserConnectAttempts = 0;
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
  if (context.parentURL === previewModule && specifier === 'playwright-core') { previewHookMatches++; return { url: 'data:text/javascript,export const chromium = globalThis.previewControllerChromium;', shortCircuit: true }; }
  // This regression ends deliberately at CDP connection: it must first complete
  // the actual nested preview admission/retention callbacks without deadlock.
  if (context.parentURL === browserModule && specifier === 'playwright-core') { browserHookMatches++; return { url: 'data:text/javascript,export const chromium = { async connectOverCDP() { globalThis.previewBrowserConnectAttempts++; throw new Error("Synthetic CDP boundary reached"); } };', shortCircuit: true }; }
  return next(specifier, context);
} });
const h = await controllerFixture(), { db, schema } = h;
const admission = await import('../server/utils/mission-executor-admission.ts');
const environment = await import('../server/utils/mission-environment.ts');
const previews = await import('../server/utils/mission-preview.ts');
const consents = await import('../server/utils/environment-consents.ts');
const vault = await import('../server/utils/project-vault.ts');
const { testRunAction } = await import('../server/utils/test-runs.ts');
const basePlanner = h.scripts.planMission;
h.scripts.planMission = async (...args) => {
  const result = await basePlanner(...args);
  result.draft.cases = [0, 1, 2].map(index => ({ ...result.draft.cases[0], title: `Independent preview case ${index}` }));
  return result;
};
const originalBrowser = h.scripts.browserJobAction;
h.scripts.browserJobAction = async (...args) => {
  const input = args[2];
  if (input.action === 'start') {
    const [attempt] = await db.select().from(schema.missionAttempts).where(eq(schema.missionAttempts.dispatchId, input.jobId));
    if ([...previewSessions.values()].some(session => session.authorization?.execution.attemptId === attempt.id)) {
      const [ack] = await db.select().from(schema.missionEvents).where(eq(schema.missionEvents.eventKey, `preview-handoff-ack:${attempt.id}`));
      assert.ok(ack, 'Iris may start only after durable exact handoff ack');
    } else if (!contexts.get(attempt.missionId).actualBrowserAction) {
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
    await admission.admitMissionExecutor({ execution: session.authorization?.execution ?? session.execution, resourceId: (session.authorization?.execution ?? session.execution).dispatchId, operationId: 'preview:session', kind: 'environment.preview', payloadHash: session.authorization?.requestHash ?? session.requestHash });
    return { renewed: true };
  }
  if (method === 'DELETE') { previewSessions.delete(session.execution.attemptId); return { closed: true }; }
  if (method === 'POST') return { control: path.includes('/human') ? 'human' : 'agent', controlEpoch: 2 };
  assert.equal(method, 'GET'); assert.equal(path, `/sessions/${session.sessionId}`); return { ...session, id: session.sessionId, status: 'ready', control: 'agent', controlEpoch: 2 };
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
  if (parsed.pathname === '/preview' && input.action === 'handoff') {
    const payload = input.handoff, f = contexts.get(payload.execution.missionId); assert.ok(f);
    const saved = [...previewSessions.values()].find(session => session.sessionId === payload.sessionId); assert.ok(saved);
    const requestHash = previewHandoffHash(payload);
    assert.equal(saved.requestHash, payload.creationRequestHash);
    if (f.beforeHandoff) await f.beforeHandoff(payload);
    if (f.rejectHandoff) throw new Error('Synthetic handoff rejection before commit');
    await admission.admitMissionExecutor({ execution: payload.execution, resourceId: payload.execution.dispatchId,
      operationId: `preview:handoff:${payload.handoffId}`, kind: 'environment.preview', payloadHash: requestHash });
    const receipt = { version: 1, handoffId: payload.handoffId, requestHash, creationRequestHash: saved.requestHash,
      sandboxId: saved.sandboxId, sessionId: saved.sessionId, policyDigest: saved.policyDigest,
      attemptId: payload.execution.attemptId, dispatchId: payload.execution.dispatchId, controlEpoch: 2, observedAt: new Date().toISOString() };
    saved.authorization = { execution: payload.execution, requestHash, receipt };
    if (f.afterHandoff) await f.afterHandoff(payload);
    if (f.loseHandoffAck) throw new Error('Synthetic acknowledgement lost after commit');
    return Response.json(receipt);
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
      if (f.beforeClose) await f.beforeClose();
      if (f.unknownCleanup) throw new Error('Synthetic physical cleanup unavailable');
      previewSessions.delete(input.execution.attemptId); return Response.json({ confirmed: true });
    }
    assert.equal(input.action, 'status'); return Response.json({ ...(saved ? { session: saved, ...(saved.authorization && !f.hideHandoffReceipt ? { handoff: saved.authorization.receipt } : {}) } : {}), absent: !saved, cleanupConfirmed: !saved && !f.unknownCleanup });
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
  catch (error) {
    failures.push({ name, message: error.message, stack: error.stack }); console.error(`FAIL ${name}: ${error.message}`);
    if (process.env.SYNA_PREVIEW_RETURN_BASELINE === '1') throw error;
  }
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

const start = async (f, attempt, index) => {
  const [itemId, caseId] = f.task.spec.caseKeys[index].split(':');
  const input = { action: 'start', itemId, caseId,
    expectedVersion: f.task.spec.planVersions.find(plan => plan.itemId === itemId).version,
    requestId: randomUUID(), environment: f.task.spec.target.environment, target: f.task.spec.target,
    mission: { missionId: f.id, taskId: f.task.id } };
  // Exact gate used by the authenticated internal test-run adapter before it
  // invokes its trusted service. The service options themselves are not a tool.
  await h.attempts.authorizeMissionOperation({ userId: h.owner, workspaceId: f.workspace, attemptId: attempt.id,
    dispatchId: attempt.dispatchId, callId: randomUUID(), tool: 'test_run', input });
  return testRunAction(h.owner, f.workspace, f.thread, input, { execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } });
};
async function returned(options = {}) {
  const f = await fixture(options);
  if (f.required) {
    const waiting = await h.until(f, state => state.tasks.some(task => task.state === 'waiting'));
    const preparation = waiting.tasks.find(task => task.spec.kind === 'environment_setup' && task.spec.phase === 'prepare');
    const source = await h.row(schema.setupJobs, preparation.sources.find(ref => ref.type === 'setup').id);
    f.vault = await vault.saveVaultEntry(h.owner, f.workspace, { repoUrl, expectedRevision: 0, values: { APP_KEY: 'synthetic-private-setting' }, forget: [] });
    f.consent = await consents.grantEnvironmentConsent(h.owner, f.workspace, source.id, { requestId: randomUUID(), expectedPlanHash: environmentPlanHash(source.result.environment), expectedVaultRevision: f.vault.revision, allowedNames: ['APP_KEY'] });
    const [wait] = await db.select().from(schema.missionWaits).where(and(eq(schema.missionWaits.missionId, f.id), eq(schema.missionWaits.state, 'waiting')));
    await h.control.controlMission(h.owner, f.workspace, f.thread, { action: 'answer', missionId: f.id, requestId: randomUUID(), expectedMandateRevision: waiting.mission.mandateRevision,
      waitId: wait.id, answer: { kind: 'environment_consent', consentId: f.consent.id } });
  }
  const ready = await h.browserReady(f);
  f.attempt = ready.attempts.find(row => row.kind === 'browser_tests'); f.task = ready.tasks.find(row => row.id === f.attempt.taskId);
  f.session = previewSessions.get(f.attempt.id); assert.ok(f.session);
  const agentId = `wrun_preview_auth_${randomUUID()}`;
  await db.update(schema.browserJobs).set({ sessionId: agentId }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
  f.failed = await start(f, f.attempt, 0);
  await testRunAction(h.owner, f.workspace, f.thread, { action: 'finish', runId: f.failed.id,
    result: { schemaVersion: 2, outcome: 'failed', actual: 'Synthetic confirmed failure stays unchanged.', observations: [{ kind: 'defect', title: 'Original defect', detail: 'Completed first case.' }], evidenceItemIds: [], remaining: [],
      checks: runChecks(f.failed.snapshot).map(check => ({ id: check.id, status: 'mismatch', actual: 'Synthetic observed mismatch.' })) } },
  { execution: { attemptId: f.attempt.id, dispatchId: f.attempt.dispatchId } });
  f.interrupted = await start(f, f.attempt, 1);
  [f.assignment] = await db.insert(schema.browserAssignments).values({ id: randomUUID(), workspaceId: f.workspace, userId: h.owner, threadId: f.thread, agentId,
    sessionId: f.session.sessionId, projectId: `vps-preview-policy-v1:${f.session.sandboxId}:${f.session.policyDigest}`, liveUrl: f.session.liveUrl,
    connectUrl: f.session.connectUrl, control: 'human', expiresAt: new Date(f.session.expiresAt) }).returning();
  await db.update(schema.missionResourceClaims).set({ owner: 'human' }).where(eq(schema.missionResourceClaims.attemptId, f.attempt.id));
  f.wait = await db.transaction(async tx => {
    await h.control.lockMission(tx, f.id);
    return h.control.createMissionWait(tx, await h.missions.ownedMission(h.owner, f.workspace, f.id, tx), { reason: 'human_browser', taskIds: [f.task.id], question: 'Return the same preview after authentication.' });
  });
  await db.update(schema.browserJobs).set({ status: 'completed', updatedAt: new Date() }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
  await db.update(schema.missionAttempts).set({ usage: { tokens: 100, toolCalls: 1, durationMs: 1 } }).where(eq(schema.missionAttempts.id, f.attempt.id));
  await h.pass(f);
  f.originalAttempt = await h.row(schema.missionAttempts, f.attempt.id);
  f.originalRuns = await db.select().from(schema.testRuns).where(eq(schema.testRuns.missionAttemptId, f.attempt.id));
  f.originalCreation = executionHash(f.session);
  await db.update(schema.browserAssignments).set({ control: 'agent' }).where(eq(schema.browserAssignments.id, f.assignment.id));
  const mission = await h.row(schema.missions, f.id);
  await h.control.controlMission(h.owner, f.workspace, f.thread, { action: 'answer', missionId: f.id, waitId: f.wait.id, expectedMandateRevision: mission.mandateRevision,
    requestId: randomUUID(), answer: { kind: 'browser_returned', sessionId: f.assignment.sessionId } });
  return f;
}

try {
  // The controller lazily imports browser.ts. Bind both fake CDP ports before
  // workload, inside cleanup so even a test-loader failure removes its owner.
  await import('../server/utils/browser.ts');
  assert.equal(previewHookMatches, 1, 'Preview must use the synthetic CDP port');
  assert.equal(browserHookMatches, 1, 'Browser must use the synthetic CDP port');
  console.log(JSON.stringify({ fixtureOwner: h.owner, runtime: process.env.PAT_RUNTIME_SCOPE }));
  await check('preview terminal Iris return transfers only authority; preserved outcomes and fresh exact run', async () => {
    const f = await returned({ required: true }), before = transport.length;
    await h.pass(f);
    const state = await h.state(f), next = state.attempts.find(row => row.kind === 'browser_tests' && row.id !== f.attempt.id);
    assert.ok(next); assert.equal(next.attemptNo, f.attempt.attemptNo + 1); assert.ok(next.deadlineAt <= f.attempt.deadlineAt);
    const ack = (await h.rows(schema.missionEvents, f.id)).find(row => row.eventKey === `preview-handoff-ack:${next.id}`); assert.ok(ack);
    assert.equal(ack.payload.receipt.sessionId, f.session.sessionId);
    assert.equal(state.claims.find(claim => claim.attemptId === next.id).executorResourceId, f.session.sessionId);
    assert.equal(state.claims.length, 2, 'Application remains retained alongside original preview');
    assert.deepEqual(await h.row(schema.missionAttempts, f.attempt.id), f.originalAttempt);
    assert.deepEqual(await db.select().from(schema.testRuns).where(eq(schema.testRuns.missionAttemptId, f.attempt.id)), f.originalRuns);
    assert.ok(!transport.slice(before).some(call => call.path === '/preview' && call.action === 'open'));
    await assert.rejects(start(f, next, 0), error => error.statusCode === 409);
    const fresh = await start(f, next, 1); assert.notEqual(fresh.id, f.interrupted.id); assert.deepEqual(fresh.snapshot, f.interrupted.snapshot);
    assert.equal((await h.row(schema.testRuns, fresh.id)).browserEntryReceipt, null); assert.equal(fresh.missionAttemptId, next.id);
    const cleanup = await previews.closeMissionPreview(f.attempt.id);
    assert.equal(cleanup.cleanupConfirmed, false, 'Late ancestor cannot close transferred physical browser');
    assert.ok(previewSessions.has(f.attempt.id));
  });
  await check('lost handoff ACK uses status once and persists exact receipt before Iris start', async () => {
    const f = await returned({ loseHandoffAck: true }), offset = transport.length;
    await h.pass(f);
    const state = await h.state(f), next = state.attempts.find(row => row.kind === 'browser_tests' && row.id !== f.attempt.id);
    assert.equal(h.calls.filter(call => call.kind === 'browser:start' && call.missionId === f.id).length, 2);
    const calls = transport.slice(offset).filter(call => call.path === '/preview');
    assert.deepEqual(calls.map(call => call.action), ['handoff', 'status']);
    assert.ok((await h.rows(schema.missionEvents, f.id)).some(row => row.eventKey === `preview-handoff-ack:${next.id}`));
  });
  await check('second human return uses the same physical session and ordinary operation attempt budget', async () => {
    const f = await returned(); await h.pass(f);
    const state = await h.state(f), next = state.attempts.find(row => row.kind === 'browser_tests' && row.id !== f.attempt.id);
    const fresh = await start(f, next, 1), agentId = `wrun_preview_again_${randomUUID()}`;
    await db.update(schema.browserJobs).set({ sessionId: agentId }).where(eq(schema.browserJobs.id, next.dispatchId));
    await db.update(schema.browserAssignments).set({ control: 'human' }).where(eq(schema.browserAssignments.id, f.assignment.id));
    await db.update(schema.missionResourceClaims).set({ owner: 'human' }).where(eq(schema.missionResourceClaims.attemptId, next.id));
    const wait = await db.transaction(async tx => {
      await h.control.lockMission(tx, f.id);
      return h.control.createMissionWait(tx, await h.missions.ownedMission(h.owner, f.workspace, f.id, tx), { reason: 'human_browser', taskIds: [f.task.id], question: 'Return this same browser again.' });
    });
    await db.update(schema.browserJobs).set({ status: 'completed', updatedAt: new Date() }).where(eq(schema.browserJobs.id, next.dispatchId));
    await db.update(schema.missionAttempts).set({ usage: { tokens: 100, toolCalls: 1, durationMs: 1 } }).where(eq(schema.missionAttempts.id, next.id));
    await h.pass(f);
    const terminal = await h.row(schema.missionAttempts, next.id);
    const [held] = await db.select().from(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, next.id));
    assert.equal(terminal.status, 'completed'); assert.ok(terminal.finishedAt);
    assert.equal(terminal.leaseToken, null); assert.equal(terminal.leaseUntil, null);
    assert.equal(held.leaseToken, next.leaseToken); assert.equal(held.fence, next.fence);
    assert.equal(held.executorResourceId, f.session.sessionId);
    await db.update(schema.browserAssignments).set({ control: 'agent' }).where(eq(schema.browserAssignments.id, f.assignment.id));
    await h.control.controlMission(h.owner, f.workspace, f.thread, { action: 'answer', missionId: f.id, waitId: wait.id, requestId: randomUUID(),
      expectedMandateRevision: state.mission.mandateRevision, answer: { kind: 'browser_returned', sessionId: f.session.sessionId } });
    await h.pass(f);
    const after = await h.state(f), attempts = after.attempts.filter(row => row.kind === 'browser_tests');
    assert.equal(attempts.length, after.mission.mandate.limits.maxOperationAttempts);
    const last = attempts.sort((a, b) => b.attemptNo - a.attemptNo)[0];
    assert.equal(last.id, next.id, 'A second return does not add a third operation attempt');
    assert.equal((await h.row(schema.testRuns, fresh.id)).result.outcome, 'interrupted');
    assert.equal((await h.row(schema.testRuns, f.failed.id)).result.outcome, 'failed');
    assert.equal(h.calls.filter(call => call.kind === 'browser:start' && call.missionId === f.id).length, 2);
  });
  await check('direct cleanup helper serializes its physical close with returned-session reservation', async () => {
    const f = await returned();
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    f.beforeClose = async () => { enter(); await barrier; };
    const closing = previews.closeMissionPreview(f.attempt.id);
    let reserved, lease, timer;
    try {
      await Promise.race([entered, closing.then(() => { throw new Error('Close ended before the intended barrier'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Close barrier deadline')), 5000); })]);
      lease = h.attempts.leaseIdentity(await h.attempts.claimMission(f.id));
      reserved = await h.attempts.reserveMissionAttempt(lease, f.task.id, { usesModel: true,
        resource: { kind: 'browser', poolKey: process.env.BROWSER_SERVICE_URL ?? 'browser-provider' } });
    } finally {
      clearTimeout(timer);
      release(); await closing;
      if (lease) await h.attempts.releaseMissionLease(lease);
    }
    assert.equal(reserved.status, 'deferred', 'An in-flight ancestor close must hold the same browser lock as claim transfer');
    assert.deepEqual(reserved.reasons, ['resource_busy']);
    assert.equal((await h.state(f)).attempts.filter(row => row.kind === 'browser_tests').length, 1);
  });
  await check('shorter new attempt retains immutable policy while current browser admission stays bounded', async () => {
    const f = await returned({ required: true });
    const claimed = await h.attempts.claimMission(f.id), lease = h.attempts.leaseIdentity(claimed);
    const reserved = await h.attempts.reserveMissionAttempt(lease, f.task.id, { usesModel: true,
      resource: { kind: 'browser', poolKey: process.env.BROWSER_SERVICE_URL ?? 'browser-provider' } });
    assert.equal(reserved.status, 'reserved');
    const next = reserved.attempt, shorter = new Date(next.deadlineAt.getTime() - 1000);
    assert.ok(shorter > new Date());
    await db.update(schema.missionAttempts).set({ deadlineAt: shorter }).where(eq(schema.missionAttempts.id, next.id));
    await db.update(schema.missionResourceClaims).set({ expiresAt: shorter }).where(eq(schema.missionResourceClaims.attemptId, next.id));
    await h.attempts.releaseMissionLease(lease); await h.pass(f);
    const [ack] = (await h.rows(schema.missionEvents, f.id)).filter(row => row.eventKey === `preview-handoff-ack:${next.id}`); assert.ok(ack);
    assert.equal(ack.payload.receipt.policyDigest, f.session.policyDigest);
    assert.ok(Date.parse(f.session.expiresAt) > shorter.getTime());
    const agentId = `wrun_preview_short_${randomUUID()}`;
    await db.update(schema.browserJobs).set({ sessionId: agentId }).where(eq(schema.browserJobs.id, next.dispatchId));
    const fresh = await start(f, next, 1), { browserAction } = await import('../server/utils/browser.ts');
    const connectedBefore = globalThis.previewBrowserConnectAttempts;
    const observed = await browserAction(h.owner, f.thread, { action: 'open', runId: fresh.id, url: fresh.snapshot.entryUrl }, agentId,
      { browserJobId: next.dispatchId, executorSessionId: agentId, callId: randomUUID() });
    assert.equal(globalThis.previewBrowserConnectAttempts, connectedBefore + 1, 'Only the intentional synthetic CDP boundary may fail');
    assert.equal(observed.status, 'action_failed'); assert.equal(observed.phase, 'connect');
    assert.equal((await h.row(schema.browserAssignments, f.assignment.id)).sessionId, f.session.sessionId);
  });
  await check('session cache without handoff receipt cannot authorize Iris; uncertain cleanup retains both resources', async () => {
    const f = await returned({ loseHandoffAck: true, hideHandoffReceipt: true });
    f.unknownCleanup = true; // Arm only after original preview discovery cleaned.
    await h.pass(f);
    const state = await h.state(f);
    assert.equal(h.calls.filter(call => call.kind === 'browser:start' && call.missionId === f.id).length, 1);
    assert.equal(state.claims.length, 2); assert.ok(!(await h.rows(schema.missionEvents, f.id)).some(row => row.kind === 'preview.handoff_ack'));
    assert.ok((await h.rows(schema.missionEvents, f.id)).some(row => row.kind === 'browser_return_invalidated'));
    f.unknownCleanup = false;
  });
  await check('before-commit rejection cannot replay handoff or create a browser', async () => {
    const f = await returned({ rejectHandoff: true }), offset = transport.length;
    await h.pass(f); await h.pass(f);
    const calls = transport.slice(offset).filter(call => call.path === '/preview');
    assert.equal(calls.filter(call => call.action === 'handoff').length, 1);
    assert.equal(calls.filter(call => call.action === 'open').length, 0);
    assert.equal(h.calls.filter(call => call.kind === 'browser:start' && call.missionId === f.id).length, 1);
  });
  for (const fault of ['revoke-consent', 'rotate-vault', 'expired-apply', 'wrong-session', 'changed-plan', 'pause', 'flag-off']) {
    await check(`${fault} before handoff denies without new Iris or preview`, async () => {
      const f = await returned({ required: true }), before = h.calls.filter(call => call.kind === 'browser:start' && call.missionId === f.id).length;
      if (fault === 'revoke-consent') await db.update(schema.environmentConsents).set({ revokedAt: new Date(), revision: f.consent.revision + 1 }).where(eq(schema.environmentConsents.id, f.consent.id));
      if (fault === 'rotate-vault') await vault.saveVaultEntry(h.owner, f.workspace, { repoUrl, expectedRevision: f.vault.revision, values: { APP_KEY: 'synthetic-revised-setting' }, forget: [] });
      if (fault === 'expired-apply') {
        const state = await h.state(f), application = state.attempts.find(attempt => state.tasks.find(task => task.id === attempt.taskId)?.spec.phase === 'apply');
        await db.update(schema.missionAttempts).set({ deadlineAt: new Date(0) }).where(eq(schema.missionAttempts.id, application.id));
      }
      if (fault === 'wrong-session') await db.update(schema.browserAssignments).set({ sessionId: randomUUID() }).where(eq(schema.browserAssignments.id, f.assignment.id));
      if (fault === 'changed-plan') await db.update(schema.workspaceItems).set({ version: f.task.spec.planVersions[0].version + 1 }).where(eq(schema.workspaceItems.id, f.task.spec.planVersions[0].itemId));
      if (fault === 'pause') await h.operate(f, 'pause');
      if (fault === 'flag-off') process.env.AUTONOMOUS_MISSIONS_ENABLED = 'false';
      try { await h.pass(f); await h.pass(f); }
      finally { process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; }
      assert.equal(h.calls.filter(call => call.kind === 'browser:start' && call.missionId === f.id).length, before);
      assert.deepEqual(await db.select().from(schema.testRuns).where(eq(schema.testRuns.missionAttemptId, f.attempt.id)), f.originalRuns);
    });
  }
  await check('pre-ACK START and wrong callback fail closed, admitted callback holds no outer SQL lock', async () => {
    const f = await returned({ required: true });
    f.beforeHandoff = async payload => {
      const attempt = await h.row(schema.missionAttempts, payload.execution.attemptId);
      await assert.rejects(start(f, attempt, 1));
      await assert.rejects(admission.admitMissionExecutor({ execution: payload.execution, resourceId: payload.execution.dispatchId,
        operationId: 'preview:session', kind: 'environment.preview', payloadHash: previewHandoffHash(payload) }));
      await assert.rejects(admission.admitMissionExecutor({ execution: payload.execution, resourceId: payload.execution.dispatchId,
        operationId: `preview:handoff:${randomUUID()}`, kind: 'environment.preview', payloadHash: previewHandoffHash(payload) }));
    };
    const started = Date.now(); await h.pass(f);
    assert.ok(Date.now() - started < 15000, 'Nested callback acquires mission/consent locks after app transaction ends');
    assert.equal(h.calls.filter(call => call.kind === 'browser:start' && call.missionId === f.id).length, 2);
  });
  await check('consent revocation after worker ack cannot publish authority or start Iris', async () => {
    const f = await returned({ required: true });
    f.afterHandoff = () => db.update(schema.environmentConsents).set({ revokedAt: new Date(), revision: f.consent.revision + 1 }).where(eq(schema.environmentConsents.id, f.consent.id));
    await h.pass(f);
    assert.equal(h.calls.filter(call => call.kind === 'browser:start' && call.missionId === f.id).length, 1);
    assert.ok(!(await h.rows(schema.missionEvents, f.id)).some(row => row.kind === 'preview.handoff_ack'));
  });
  console.log(JSON.stringify({ suite: 'preview-browser-return', scope: 'actual isolated PG/controller; synthetic runner/browser/model ports', passed: checks.length, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally { await h.close(); browserHook.deregister(); delete globalThis.previewControllerChromium; delete globalThis.previewBrowserConnectAttempts; }
