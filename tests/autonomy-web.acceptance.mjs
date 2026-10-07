// Opt-in real models/auth/scheduler/Chromium. SQL observation is read-only.
// --audit checks fixture hashes and real columns without auth or model work.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv, promisify } from 'node:util';
import postgres from 'postgres';
import { Client } from 'eve/client';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { assertIsolatedRoundTrip, isolatedProcessEnvironment, readIsolationFixture } from './helpers/autonomy-isolation.mjs';
import { stopIsolatedApp, startIsolatedApp, verifyIsolatedAppArtifacts } from './helpers/start-isolated-app.mjs';
import { auditTrace, auditWebCompletion, auditWebFault, sha256, webFaultReady, frozenWebReviewerPolicy } from './helpers/autonomy-web-audit.mjs';
import { utcObservationTypes } from './helpers/utc-postgres-observation.mjs';
import { assertWebRestartBinding, assertWebRestartConfiguration, observeWebBeforeDeadline, requireWebDeadline, restartWebAtBoundary } from './helpers/autonomy-web-restart.mjs';
import { observeWindowsRuntime, requireWindowsRuntimeStopped, verifyRuntimeIdentity } from './helpers/isolated-runtime-identity.mjs';
import { resolveIsolatedCli } from './helpers/isolated-build-integrity.mjs';

const auditOnly = process.argv.includes('--audit');
if (!auditOnly && !process.argv.includes('--execute')) throw new Error('Explicit --execute required for paid isolated model acceptance');
assert.ok(!(auditOnly && process.argv.includes('--execute')), '--audit and --execute are mutually exclusive');
const option = (key, fallback) => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const scenario = option('scenario', 'normal'), repetitions = Number(option('repetitions', '3'));
const continueOnFailure = process.argv.includes('--continue-on-failure');
assert.ok(['normal', 'controller-restart', 'report-restart'].includes(scenario));
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 3);
const fixture = await readIsolationFixture();
isolatedProcessEnvironment(fixture); // Validate ALL service origins before auth/network access.
const origin = fixture.app?.origin, root = resolve('.data/autonomy-isolation', `application-${fixture.runtimeScope.split(':')[1]}`);
assert.equal(origin, 'http://127.0.0.1:58000'); assert.equal(fixture.browser.url, 'http://127.0.0.1:58092');
assert.equal(resolve(fixture.app.root), root);
assert.equal(resolve(fixture.app.runtimePath), resolve(root, 'runtime.json'));
assert.equal(resolve(fixture.app.sourceManifestPath), resolve(root, 'source-manifest.json'));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const oracleBytes = await readFile('tests/fixtures/autonomy-site/oracle.json'), oracle = JSON.parse(oracleBytes);
const siteSha256 = sha256(await readFile('tests/fixtures/autonomy-site/server.mjs'));
assert.equal(siteSha256, '8b819076df65c86d1c16e99eea827c80ae1c22e22c731d202e292ec294a6fdf2');
assert.equal(sha256(oracleBytes), '88f5049a65f7a32bf51f15cb98b963437bf5c06985c382238bcf8f8eb5bfb57e');
const site = await json('.data/autonomy-isolation/linux/site-manifest.json');
assert.equal(site.serverSha256, siteSha256); assert.equal(site.oracleSha256, sha256(oracleBytes));
assert.equal(site.origin, oracle.origin); assert.equal(site.oracleNotServed, true);
const sql = postgres(fixture.databaseUrl, { prepare: false, max: 2, types: utcObservationTypes, connection: { TimeZone: 'UTC', default_transaction_read_only: 'on' } });
const runId = randomUUID(), output = resolve('.data/autonomy-isolation', `web-acceptance-${runId}.json`);
const protocol = { version: 7, timestampObservation: 'utc-oid1114-v1', scenario, repetitions, continueOnFailure, automatedGate: false, gate: false, gateEligible: repetitions === 3, sourceHash: fixture.app.sourceSha256,
  oracleContract: 'submitted-search-catalogue-reviewed-known-defects-v7',
  defectPolicy: 'reviewed-known-defect-v1',
  harnessSha256: sha256(await readFile(new URL(import.meta.url))), auditSha256: sha256(await readFile(new URL('./helpers/autonomy-web-audit.mjs', import.meta.url))),
  reportProseReview: { status: 'pending', limitation: 'Not certified by deterministic oracle; inspect saved report prose before the overall P2a gate.' },
  runtime: fixture.runtimeScope, model: 'glm-5.3-flash', reasoning: 'low', observationSeconds: 1500,
  schedulerIntervalSeconds: 60, controllerLeaseSeconds: 90, reportLeaseSeconds: 240,
  prompt: 'Testa http://qa-fixture.test, inklusive navigeringen och sökfunktionen, och spara en rapport över vad som fungerar och eventuella problem.',
  fixture: { kind: 'simulated-public-origin', origin: oracle.origin, siteSha256, oracleSha256: sha256(oracleBytes), oracleNotInPrompt: true,
    limitation: 'Query values are redacted. Search verifies a nonempty submitted GET search and identifiable rendered catalogue results; the exact query value and whether it semantically matches those results are not independently verified.' },
  startedAt: new Date().toISOString(), attempts: [] };
const secrets = new Set([fixture.internalApiSecret, fixture.auth.anonKey, fixture.auth.serviceRoleKey, fixture.browser.key, fixture.databaseUrl].filter(Boolean));
const redact = value => {
  let result = String(value);
  for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
  return result.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED JWT]');
};
const persist = () => writeFile(output, redact(JSON.stringify(protocol, null, 2)));
const safeError = error => redact(error?.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : `${error?.name || 'Error'}: ${error?.code || 'Acceptance operation failed; inspect private runtime logs'}`).slice(0, 600);
let cookie, otherCookie, restartPreparation;
async function observe(workspaceId) {
  const [missions, tasks, attempts, jobs, runs, reviews, reports, claims, events, captures, versions, browsers, reportItems] = await Promise.all([
    sql`select id,status,lifecycle,phase,closure_reason,config,mandate,mandate_revision,plan_revision,deadline_at,report_deadline_at,lease_until,closed_at from pat_missions where workspace_id=${workspaceId} and runtime=${fixture.runtimeScope}`,
    sql`select t.id,t.state,t.blocked_reason,t.spec,t.sources,t.plan_revision,t.supplement_round,t.operation_id,t.depends_on,t.created_at from pat_mission_tasks t join pat_missions m on m.id=t.mission_id where m.workspace_id=${workspaceId} order by t.created_at`,
    sql`select a.id,a.task_id,a.kind,a.status,a.dispatch_id,a.operation_id,a.attempt_no,a.executor_resource_id,a.error,a.usage,a.tool_calls,a.created_at,a.finished_at,a.lease_until,a.deadline_at,a.plan_revision,a.mandate_revision,a.supplement_round,a.cancel_requested_at from pat_mission_attempts a join pat_missions m on m.id=a.mission_id where m.workspace_id=${workspaceId} order by a.created_at`,
    sql`select b.id,b.status,b.session_id,b.dispatch_lease_until,b.report from pat_browser_jobs b join pat_threads t on t.id=b.thread_id where t.workspace_id=${workspaceId}`,
    sql`select id,item_id,case_id,plan_version,snapshot,target,runtime,result,started_at,finished_at,mission_attempt_id from pat_test_runs where workspace_id=${workspaceId}`,
    sql`select id,run_id,status,assessment,input,error,source_hash,input_hash,reviewer_version,created_at,finished_at from pat_result_assessments where workspace_id=${workspaceId} and runtime=${fixture.runtimeScope}`,
    sql`select r.id,r.status,r.item_id,r.attempts,r.error,r.document,r.usage,r.lease_until,r.lease_token,r.read_receipts,r.finished_at from pat_mission_reports r join pat_missions m on m.id=r.mission_id where m.workspace_id=${workspaceId}`,
    sql`select id,state,owner,attempt_id from pat_mission_resource_claims where workspace_id=${workspaceId}`,
    sql`select e.kind,e.payload,e.event_key,e.created_at from pat_mission_events e join pat_missions m on m.id=e.mission_id where m.workspace_id=${workspaceId} order by e.revision`,
    sql`select c.id,c.run_id,c.item_id,c.url,c.action,c.error,i.provenance,i.content,i.deleted_at from pat_test_captures c join pat_test_runs r on r.id=c.run_id left join pat_workspace_items i on i.id=c.item_id where r.workspace_id=${workspaceId}`,
    sql`select v.item_id,v.version,v.created_at from pat_workspace_item_versions v join pat_workspace_items i on i.id=v.item_id where i.workspace_id=${workspaceId} and i.content->>'kind'='test_plan'`,
    sql`select id,session_id,agent_id from pat_browser_assignments where workspace_id=${workspaceId}`,
    sql`select i.id,i.version,i.deleted_at from pat_workspace_items i join pat_mission_reports r on r.item_id=i.id where i.workspace_id=${workspaceId}`,
  ]);
  return { missions, tasks, attempts, jobs, runs, reviews, reports, claims, events, captures, versions, browsers, reportItems };
}
async function freezeRuntime() {
  const verified = await verifyIsolatedAppArtifacts(fixture, { requireRuntime: true });
  const runtime = verified.runtime;
  protocol.modelRequestIntervalMs ??= runtime.modelRequestIntervalMs ?? 0;
  assert.equal(runtime.modelRequestIntervalMs ?? 0, protocol.modelRequestIntervalMs, 'Provider pacing changed during trial');
  assert.equal(runtime.sourceSha256, protocol.sourceHash);
  protocol.buildIntegrity ??= { sourceSha256: verified.sourceSha256, dependencySha256: verified.dependencySha256, services: verified.services, workflowStore: verified.workflowStore };
  assert.deepEqual({ sourceSha256: verified.sourceSha256, dependencySha256: verified.dependencySha256, services: verified.services, workflowStore: verified.workflowStore }, protocol.buildIntegrity, 'Compiled isolation identity or workflow store changed during trial');
  const reviewerSources = await Promise.all(['web', 'eve'].map(service => readFile(resolve(root, service, 'shared/result-assessment.ts'))));
  assert.deepEqual(reviewerSources[0], reviewerSources[1], 'Services must use the exact same frozen reviewer source');
  const reviewerPolicy = frozenWebReviewerPolicy(reviewerSources[0]);
  protocol.reviewerPolicy ??= reviewerPolicy;
  assert.deepEqual(reviewerPolicy, protocol.reviewerPolicy, 'Reviewer policy changed during observation');
  return runtime;
}
async function verifyFixtureService() {
  const linux = await json('.data/autonomy-isolation/linux/fixture.json');
  assert.match(linux.name, /^SynaAutonomy-[a-f0-9]{12}$/);
  assert.equal(resolve(linux.path), resolve('.data/autonomy-isolation/linux', linux.name));
  const read = async args => (await promisify(execFile)('wsl.exe', ['-d', linux.name, '-u', 'root', '--exec', ...args], { encoding: 'utf8', timeout: 15000, windowsHide: true })).stdout.trim();
  const headers = await read(['curl', '--silent', '--show-error', '--head', '--max-time', '10', 'http://192.0.2.10/']);
  assert.match(headers, /^HTTP\/1.1 200/m); assert.ok(headers.toLowerCase().includes(`x-fixture-sha256: ${siteSha256}`));
  const browserImage = await read(['docker', 'inspect', '-f', '{{.Image}}', 'qa-browser']);
  assert.equal(browserImage, (await json('.data/autonomy-isolation/linux/browser-policy-build.json')).image);
  return { distro: linux.name, browserImage, observedSiteSha256: siteSha256, checkedAt: new Date().toISOString() };
}
async function loginAccount(account) {
  secrets.add(account.password);
  const cookies = new Map();
  const auth = createServerClient(fixture.auth.url, fixture.auth.anonKey, {
    cookieOptions: { name: 'pat_supabase_auth', path: '/', sameSite: 'lax' },
    cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(c => cookies.set(c.name, c.value)) },
  });
  const login = await auth.auth.signInWithPassword({ email: account.email, password: account.password });
  assert.equal(login.error, null, 'Ordinary account login failed'); assert.equal(login.data.user.id, account.userId);
  assert.equal(login.data.user.role, 'authenticated', 'Acceptance must use an ordinary account');
  secrets.add(login.data.session.access_token); secrets.add(login.data.session.refresh_token);
  const value = [...cookies].map(([name, entry]) => `${name}=${entry}`).join('; '); secrets.add(value);
  return value;
}
async function api(path, body) {
  const response = await fetch(origin + path, { method: 'POST', redirect: 'error', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, `${path}: ${response.status}`); return response.json();
}
async function privateRead(path, access = cookie) {
  return fetch(origin + path, { headers: access ? { cookie: access } : {}, redirect: 'manual', signal: AbortSignal.timeout(20000) });
}
async function assertPrivate(path) {
  const statuses = [];
  for (const access of [null, otherCookie]) {
    const denied = await privateRead(path, access); await denied.body?.cancel();
    assert.ok([401, 403, 404].includes(denied.status), 'Private evidence/report leaked to a non-owner'); statuses.push(denied.status);
  }
  return statuses;
}
async function evidence(state, workspaceId) {
  const captures = state.captures.filter(capture => capture.item_id && !capture.deleted_at && ['browser-action', 'test-capture'].includes(capture.provenance?.producer));
  assert.ok(captures.length <= 240, 'Frozen evidence inspection budget exceeded');
  const byteEvidence = new Set(), traces = [], receipts = []; let total = 0;
  for (const capture of captures) {
    const path = `/api/workspaces/${workspaceId}/items/${capture.item_id}/file`;
    assert.ok(capture.content.size <= 4 * 1024 * 1024 && total + capture.content.size <= 64 * 1024 * 1024, 'Frozen evidence byte budget exceeded');
    const response = await privateRead(path); assert.equal(response.status, 200, 'Owner cannot open saved evidence');
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; assert.ok(size <= capture.content.size && total + size <= 64 * 1024 * 1024); chunks.push(chunk.value); } }
    finally { await reader.cancel().catch(() => {}); }
    const bytes = Buffer.concat(chunks); total += size;
    assert.equal(size, capture.content.size); assert.equal(sha256(bytes), capture.provenance.sha256, 'Attested evidence hash differs from actual bytes');
    assert.equal(capture.provenance.origin, 'tool'); assert.equal(capture.provenance.sourceType, 'test'); assert.equal(capture.provenance.sourceId, capture.run_id);
    if (capture.provenance.producer === 'browser-action') traces.push(auditTrace(capture, bytes, state));
    else assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Screenshot is not PNG bytes');
    byteEvidence.add(capture.item_id);
    receipts.push({ itemId: capture.item_id, sha256: sha256(bytes), bytes: size, denialStatuses: await assertPrivate(path) });
  }
  return { byteEvidence, traces, receipts, totalBytes: total };
}
async function prepareRestart(runtime) {
  assert.equal(runtime.mode, 'application');
  assert.ok(!runtime.reportFault && !runtime.reportFaultConfigFile && !runtime.securityContext, 'WEB restart requires a normal runtime without other fault/SEC transports');
  // Resolve the already authorized credential before any submission or stop.
  // Keep it only in memory; a changed/missing file after stop is irrelevant.
  const modelToken = parseEnv(await readFile('.env', 'utf8')).GRUNDEN_API_TOKEN?.trim();
  assert.ok(modelToken, 'Isolated restart requires the same explicit model credential');
  secrets.add(modelToken);
  const source = await json(resolve(root, 'source-manifest.json'));
  assert.equal(source.sourceSha256, protocol.sourceHash);
  const eveCli = await resolveIsolatedCli(source.dependencySnapshot, resolve(root, 'eve'), 'eve');
  const options = { services: ['web'], autonomy: true, siteFixture: true, benchmarkFixture: true,
    extraVariantsFixture: !!runtime.extraVariantsFixture, evidenceGapFixture: !!runtime.evidenceGapFixture, sharedOtto: true, modelToken,
    modelRequestIntervalMs: runtime.modelRequestIntervalMs ?? 0, workflowStoreId: runtime.workflowStore.id };
  isolatedProcessEnvironment(fixture, options);
  protocol.restartSafety = { version: 1, helperSha256: sha256(await readFile(new URL('./helpers/autonomy-web-restart.mjs', import.meta.url))),
    preparedAt: new Date().toISOString(), credential: 'authorized input validated before submission; value never persisted' };
  return { options, runtime: structuredClone(runtime), nodeExecutable: source.dependencySnapshot.runtime.executable, eveCli };
}
async function restoreOriginalWeb(beforeRuntime) {
  // Full source/build validation also runs after ambiguous stop failures.
  // Its absence cannot be replaced by a successful health response.
  const verified = await verifyIsolatedAppArtifacts(fixture);
  assert.deepEqual({ sourceSha256: verified.sourceSha256, dependencySha256: verified.dependencySha256, services: verified.services },
    { sourceSha256: protocol.buildIntegrity.sourceSha256, dependencySha256: protocol.buildIntegrity.dependencySha256, services: protocol.buildIntegrity.services });
  const current = JSON.parse((await readFile(resolve(root, 'runtime.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assertWebRestartBinding(beforeRuntime, current);
  const observed = await observeWindowsRuntime(beforeRuntime);
  const identity = { root, runtime: beforeRuntime, nodeExecutable: restartPreparation.nodeExecutable, eveCli: restartPreparation.eveCli, observed, requireRecordedIdentity: true };
  verifyRuntimeIdentity({ ...identity, services: ['eve'] });
  if (observed.processes.some(row => row.pid === beforeRuntime.web.pid) || observed.listeners.some(row => row.port === 58000)) {
    verifyRuntimeIdentity({ ...identity, services: ['web'] });
    assert.equal(current.web.pid, beforeRuntime.web.pid, 'Live original web has an inconsistent runtime receipt');
    return { status: 'original_running', runtime: beforeRuntime };
  }
  await requireWindowsRuntimeStopped(root, beforeRuntime, ['web']);
  await startIsolatedApp(fixture, restartPreparation.options);
  return { status: 'restarted', runtime: await freezeRuntime() };
}
async function restart(attempt, observed, deadlineAt) {
  assert.ok(restartPreparation, 'Restart prerequisites were not prepared');
  attempt.fault = {};
  await restartWebAtBoundary({ deadlineAt, observed, record: attempt.fault, ports: {
    verify: async () => {
      const current = await freezeRuntime();
      assertWebRestartConfiguration(restartPreparation.runtime, current);
      return current;
    },
    persist,
    stop: () => stopIsolatedApp(fixture, ['web']),
    observeStopped: () => observe(attempt.workspaceId),
    restore: restoreOriginalWeb,
    audit: fault => auditWebFault(scenario, observed, fault.stoppedState, fault.afterRuntime, fault.beforeRuntime),
  } });
}
try {
  if (auditOnly) {
    await observe(`audit-no-workspace-${randomUUID()}`);
    assert.equal((await sql`show transaction_read_only`)[0].transaction_read_only, 'on');
    console.log(JSON.stringify({ audit: 'passed', schemaQueries: 13, fixtureHashes: 'matched', authenticatedRequests: 0, modelCalls: 0 }));
  } else {
    protocol.processes = await freezeRuntime(); protocol.service = await verifyFixtureService();
    if (scenario !== 'normal') restartPreparation = await prepareRestart(protocol.processes);
    protocol.harnessSha256 = sha256(await readFile('tests/autonomy-web.acceptance.mjs'));
    protocol.oracleAuditSha256 = sha256(await readFile('tests/helpers/autonomy-web-audit.mjs'));
    protocol.timestampParserSha256 = sha256(await readFile('tests/helpers/utc-postgres-observation.mjs'));
    const ordinaryAccount = await json('.data/autonomy-isolation/ordinary-user.json');
    cookie = await loginAccount(ordinaryAccount);
    // Local GoTrue fixture setup only. Service role never reaches Syna/model.
    const admin = createClient(fixture.auth.url, fixture.auth.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const other = { email: `autonomy-denial-${runId}@example.test`, password: randomUUID() + randomUUID() };
    const created = await admin.auth.admin.createUser({ ...other, email_confirm: true });
    assert.equal(created.error, null, 'Local comparison account creation failed');
    otherCookie = await loginAccount({ ...other, userId: created.data.user.id });
    protocol.otherOrdinaryUserId = created.data.user.id; await persist();
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      const attempt = { repetition, startedAt: new Date().toISOString(), snapshots: [] };
      protocol.attempts.push(attempt); await persist();
      try {
        await freezeRuntime();
        const workspace = (await api('/api/workspaces', { name: `Autonomy web ${scenario} ${runId.slice(0, 8)}-${repetition}` })).workspace;
        const thread = (await api('/api/threads', { workspaceId: workspace.id, title: 'Testa en webbplats' })).thread;
        Object.assign(attempt, { workspaceId: workspace.id, threadId: thread.id });
        assertIsolatedRoundTrip({ workspaceId: workspace.id, threadId: thread.id, userId: ordinaryAccount.userId }, {
          workspaces: [...await sql`select id,user_id from pat_workspaces where id=${workspace.id}`],
          threads: [...await sql`select id,workspace_id,user_id from pat_threads where id=${thread.id}`],
        });
        attempt.databaseRoundTripAt = new Date().toISOString();
        const empty = await observe(workspace.id); assert.equal(empty.missions.length + empty.runs.length + empty.versions.length + empty.reports.length, 0);
        const client = new Client({ host: origin, redirect: 'error', headers: { cookie, 'x-pat-browser-thread': thread.id, 'x-pat-message-id': randomUUID(), 'x-pat-chat-model': protocol.model, 'x-pat-reasoning': protocol.reasoning } });
        const submitted = await client.sessions.create({ message: protocol.prompt });
        attempt.sessionId = submitted.session.state.sessionId; attempt.acceptedAt = new Date().toISOString();
        const deadline = Date.parse(attempt.acceptedAt) + protocol.observationSeconds * 1000;
        await persist();
        requireWebDeadline(deadline);
        // No result()/subscribe()/status call: chat disconnected immediately.
        let last;
        while (Date.now() < deadline) {
          const state = await observeWebBeforeDeadline(deadline, () => observe(workspace.id));
          if (JSON.stringify(last) !== JSON.stringify(state)) { last = state; attempt.snapshots.push({ at: new Date().toISOString(), ...state }); await persist(); }
          requireWebDeadline(deadline);
          if (webFaultReady(scenario, state) && !attempt.fault) await restart(attempt, state, deadline);
          requireWebDeadline(deadline);
          if (state.missions.length && state.missions.every(mission => mission.lifecycle === 'closed')) { attempt.closedAt = new Date().toISOString(); break; }
          await new Promise(done => setTimeout(done, scenario === 'normal' ? 1000 : 250));
        }
        const final = attempt.snapshots.at(-1);
        assert.ok(attempt.closedAt, 'Mission did not close before fixed observation deadline');
        assert.ok(Date.parse(attempt.closedAt) < deadline, 'Mission closed after fixed observation deadline');
        if (scenario !== 'normal') assert.ok(attempt.fault?.restartedAt, 'Required fault boundary was not reached');
        await freezeRuntime();
        const reads = await evidence(final, workspace.id); attempt.evidenceReads = reads.receipts; attempt.evidenceBytes = reads.totalBytes;
        assert.ok(protocol.reviewerPolicy, 'Reviewer policy must be frozen before evaluating results');
        const { report, matched, complements, verifiedDefects, knownDefectObservations } = auditWebCompletion(final, { runtime: fixture.runtimeScope, oracle, history: attempt.snapshots, reviewerPolicy: protocol.reviewerPolicy, defectPolicy: protocol.defectPolicy, ...reads }); attempt.oracleMatches = matched; attempt.knownDefectObservations = knownDefectObservations;
        attempt.authorizedComplements = complements; attempt.preservedVerifiedDefects = verifiedDefects;
        if (scenario === 'report-restart') { assert.equal(report.id, attempt.fault.before.reports.find(row => row.status === 'running').id); assert.ok(report.attempts >= 2, 'Report lease was not recovered'); }
        const path = `/api/workspaces/${workspace.id}/reports/${report.id}`;
        attempt.reopenedAt = new Date().toISOString();
        const opened = await privateRead(path); assert.equal(opened.status, 200);
        const body = await opened.json(); assert.equal(body.itemId, report.item_id); assert.deepEqual(body.document, report.document); assert.equal(body.stale, false);
        attempt.reportDenialStatuses = await assertPrivate(path);
        const logs = (await readFile(resolve(root, 'scheduled-http.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        attempt.scheduler = logs.filter(entry => entry.timestamp >= attempt.acceptedAt && entry.timestamp <= attempt.closedAt && ['/api/internal/autonomy/drain', '/api/internal/result-reviews/drain', '/api/internal/mission-reports/drain'].includes(entry.path));
        for (const path of ['/api/internal/autonomy/drain', '/api/internal/result-reviews/drain', '/api/internal/mission-reports/drain']) assert.ok(attempt.scheduler.some(entry => entry.path === path && entry.method === 'POST' && entry.status === 200), `Actual scheduled drain not evidenced: ${path}`);
        attempt.result = 'passed';
      } catch (error) { attempt.result = 'failed'; attempt.error = safeError(error); }
      attempt.finishedAt = new Date().toISOString(); await persist();
      console.log(JSON.stringify({ runId, scenario, repetition, result: attempt.result, error: attempt.error, artifact: output }));
      if (attempt.result === 'failed' && !continueOnFailure) {
        protocol.notStarted = { repetitions: repetitions - repetition, reason: 'Stopped at the first failed trial for investigation; no later trial was submitted.' };
        break;
      }
      // Failed histories remain intact; no cancellation, follow-up or state repair.
    }
    protocol.finishedAt = new Date().toISOString();
    protocol.result = protocol.attempts.length === repetitions && protocol.attempts.every(attempt => attempt.result === 'passed') ? 'passed' : 'failed';
    protocol.automatedGate = protocol.gateEligible && protocol.result === 'passed';
    // The overall gate also needs an independent reading of the saved reports.
    // Automated findings cannot certify arbitrary model-written prose.
    await persist(); process.exitCode = protocol.result === 'passed' ? 0 : 1;
  }
} finally { await sql.end(); }
