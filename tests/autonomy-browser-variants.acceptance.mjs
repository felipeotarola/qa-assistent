// Opt-in natural-prompt acceptance. No dotenv, process lifecycle, internal drain,
// hidden follow-up prompt or SQL mutation. WEB04 first executes a separate
// natural QA mission against A; only the later B mission is primary measurement.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { Client } from 'eve/client';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { assertIsolatedRoundTrip, isolatedProcessEnvironment, readIsolationFixture } from './helpers/autonomy-isolation.mjs';
import { verifyIsolatedAppArtifacts } from './helpers/start-isolated-app.mjs';
import { utcObservationTypes } from './helpers/utc-postgres-observation.mjs';
import { requireWebDeadline, observeWebBeforeDeadline } from './helpers/autonomy-web-restart.mjs';
import { auditTrace } from './helpers/autonomy-web-audit.mjs';
import { freezeBrowserReviewPolicy } from './helpers/browser-variants-current.mjs';
import { auditBrowserReports } from './helpers/browser-variants-reports.mjs';
import { assertDeployment, assertExtraDeployment, auditBrowserVariant, authenticationCandidate, browserVariantProtocol, browserVariants, closedExecutionIdentity, hash, originalWait, takeoverCandidate } from './helpers/browser-variants-protocol.mjs';
import { regressionEditCandidate, regressionFingerprint, regressionPlanTitle } from './helpers/browser-variants-regression.mjs';
import { actualRegressionPlan, actualHistoryExecutionProtocol, sealActualRegressionHistory, importActualRegressionHistory, projectRegressionMission, auditActualRegressionB } from './helpers/browser-variants-history.mjs';
import { auditAuthenticatedContinuation, readFixtureAuthAudit, readHumanPolicyVerification, submitFixtureLogin, validateHumanLogin } from './helpers/browser-variants-auth.mjs';
import { auditCancelledBrowserEffects, browserVariantRuntimeIdentity, cancelledExecutionBaseline, readBrowserEffectTrace } from './helpers/browser-variants-effects.mjs';

const args = process.argv.slice(2), option = (key, fallback) => args.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
assert.ok(args.every(value => ['--audit', '--execute'].includes(value) || /^--(task|variant|repetitions)=/.test(value)), 'Unknown harness option');
assert.notEqual(args.includes('--audit'), args.includes('--execute'), 'Choose exactly one of --audit or --execute');
const taskId = option('task', 'WEB-02'), variant = option('variant', 'normal');
const protocol = browserVariantProtocol(taskId, variant, Number(option('repetitions', '3')));
const fixture = await readIsolationFixture(); isolatedProcessEnvironment(fixture);
const origin = fixture.app?.origin, root = resolve('.data/autonomy-isolation', `application-${fixture.runtimeScope.split(':')[1]}`);
assert.equal(origin, 'http://127.0.0.1:58000'); assert.equal(fixture.browser?.url, 'http://127.0.0.1:58092');
assert.equal(resolve(fixture.app.root), root);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const isExtra = ['WEB-04', 'AUTH-09'].includes(taskId);
const oracleBytes = await readFile(isExtra ? 'tests/fixtures/browser-variants-extra-oracle.json' : 'tests/fixtures/autonomy-benchmark-sites/oracle.json');
const rawOracle = JSON.parse(oracleBytes);
const oracle = !isExtra ? rawOracle : taskId === 'WEB-04' ? { origin: rawOracle.regression.origin, tasks: [{ taskId, checks: rawOracle.regression.checks }] }
  : { origin: rawOracle.authentication.origin, tasks: [{ taskId, checks: [{ id: 'authenticated_profile', action: 'observe', toPath: '/account', heading: rawOracle.authentication.profile.heading,
    status: 200, classification: 'known_working', visibleText: Object.values(rawOracle.authentication.profile).slice(1) }] }] };
const hashes = {
  serverSha256: hash(await readFile(isExtra ? 'tests/fixtures/browser-variants-extra-site.mjs' : 'tests/fixtures/autonomy-benchmark-sites/server.mjs')),
  oracleSha256: hash(oracleBytes), resolverSha256: hash(await readFile(isExtra ? 'tests/helpers/browser-variants-extra-resolver.mjs' : 'tests/helpers/browser-variants-resolver.mjs')),
  runtimeScope: fixture.runtimeScope,
};
const deploymentPath = `.data/autonomy-isolation/linux/browser-variants${isExtra ? '-extra' : ''}-deployment.json`;
const deployment = await json(deploymentPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
let deploymentProblem;
try { (isExtra ? assertExtraDeployment : assertDeployment)(deployment, hashes); } catch (error) { deploymentProblem = error.message.split('\n')[0]; }
let humanPolicyReceipt, humanPolicyProblem;
if (protocol.humanPolicyReceiptRequired) try { humanPolicyReceipt = await readHumanPolicyVerification(deployment); } catch { humanPolicyProblem = 'A physical human POST/cookie verification receipt matching the current browser image and fixture is required'; }
if (args.includes('--audit')) {
  console.log(JSON.stringify({ audit: 'files_only', taskId, variant, hashes,
    blockers: [...protocol.blockers, ...(deploymentProblem ? [deploymentProblem] : []), ...(humanPolicyProblem ? [humanPolicyProblem] : [])],
    externalReview: protocol.externalReview, currentRuntimeVerified: false, networkRequests: 0, modelCalls: 0,
    catalog: browserVariants, protocol }, null, 2));
} else {
  assert.equal(protocol.blockers.length, 0, protocol.blockers.join(' '));
  assert.equal(deploymentProblem, undefined, 'Fixture is not deployed/verified; run --audit for prerequisites');
  assert.equal(humanPolicyProblem, undefined, 'Human login transport has not been verified for this exact browser image/fixture');
  await execute();
}

async function execute() {
  const runId = randomUUID(), output = resolve('.data/autonomy-isolation', `browser-variants-${runId}.json`);
  const artifact = { ...protocol, type: 'syna-browser-variants-acceptance', runId, sourceHash: fixture.app.sourceSha256,
    fixture: { ...hashes, origin: oracle.origin, kind: 'simulated-public-origin', oracleNotInPrompt: true },
    harnessSha256: hash(await readFile('tests/autonomy-browser-variants.acceptance.mjs')),
    parserSha256: hash(await readFile('tests/helpers/browser-variants-protocol.mjs')),
    effectParserSha256: hash(await readFile('tests/helpers/browser-variants-effects.mjs')),
    traceParserSha256: hash(await readFile('tests/helpers/autonomy-web-audit.mjs')),
    timestampParserSha256: hash(await readFile('tests/helpers/utc-postgres-observation.mjs')),
    startedAt: new Date().toISOString(), trials: Array.from({ length: protocol.repetitions }, (_, index) => ({ repetition: index + 1, status: 'not_started' })) };
  const reviewHelpers = ['autonomy-web-restart.mjs', 'browser-variants-history.mjs', 'browser-variants-current.mjs', 'browser-variants-reports.mjs', 'browser-variants-regression.mjs', 'mission-report-bindings.mjs', 'repo-benchmark-audit-v2.mjs', 'repo-benchmark-audit.mjs', 'autonomy-web-audit.mjs'];
  artifact.helperHashes = Object.fromEntries(await Promise.all(reviewHelpers.map(async name => [name, hash(await readFile('tests/helpers/' + name))])));
  if (humanPolicyReceipt) artifact.humanPolicyReceipt = humanPolicyReceipt;
  const secrets = new Set([fixture.databaseUrl, fixture.internalApiSecret, fixture.auth.anonKey, fixture.auth.serviceRoleKey, fixture.browser.key].filter(Boolean));
  const redact = text => { for (const secret of secrets) text = text.split(secret).join('[REDACTED]'); return text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED JWT]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]'); };
  const persist = () => writeFile(output, redact(JSON.stringify(artifact, null, 2)));
  let sql, cookie, foreignCookie, createAccount;
  async function freeze() {
    const verified = await verifyIsolatedAppArtifacts(fixture, { requireRuntime: true });
    for (const name of reviewHelpers) assert.equal(hash(await readFile('tests/helpers/' + name)), artifact.helperHashes[name], 'Browser oracle helper changed during the trial');
    const [reviewerWeb, reviewerEve, authoredChecks, webChecks, eveChecks] = await Promise.all([
      readFile(resolve(root, 'web/shared/result-assessment.ts')), readFile(resolve(root, 'eve/shared/result-assessment.ts')),
      readFile('shared/test-run.ts'), readFile(resolve(root, 'web/shared/test-run.ts')), readFile(resolve(root, 'eve/shared/test-run.ts')),
    ]);
    const policies = freezeBrowserReviewPolicy({ reviewer: { web: reviewerWeb, eve: reviewerEve }, runChecks: { authored: authoredChecks, web: webChecks, eve: eveChecks } },
      artifact.reviewerPolicy ? { reviewerPolicy: artifact.reviewerPolicy, runChecksPolicy: artifact.runChecksPolicy } : undefined);
    Object.assign(artifact, policies);
    const identity = { ...browserVariantRuntimeIdentity(verified), ...policies };
    assert.equal(verified.sourceSha256, artifact.sourceHash);
    artifact.modelRequestIntervalMs ??= identity.modelRequestIntervalMs;
    assert.equal(artifact.modelRequestIntervalMs, identity.modelRequestIntervalMs, 'Provider pacing changed during the trial');
    if (isExtra) for (const [key, expected] of Object.entries(hashes).filter(([key]) => key !== 'runtimeScope')) assert.equal(verified.runtime.extraVariantsFixture?.[key], expected, 'Current runtime did not opt in to the frozen extra fixture');
    artifact.buildIntegrity ??= identity; assert.deepEqual(identity, artifact.buildIntegrity, 'Runtime changed during the trial');
    return verified.runtime;
  }
  async function preflightSite(selectedDeployment = deployment, selectedHashes = hashes, extra = isExtra) {
    const deployment = selectedDeployment, hashes = selectedHashes;
    const linux = await json('.data/autonomy-isolation/linux/fixture.json');
    assert.match(linux.name, /^SynaAutonomy-[a-f0-9]{12}$/); assert.equal(resolve(linux.path), resolve('.data/autonomy-isolation/linux', linux.name));
    const read = async values => (await promisify(execFile)('wsl.exe', ['-d', linux.name, '-u', 'root', '--exec', ...values], { encoding: 'utf8', timeout: 15000, windowsHide: true })).stdout.trim();
    const response = await read(['curl', '--silent', '--show-error', '--head', '--max-time', '10', ...(extra ? ['-H', 'Host: qa-regression.test'] : []), `http://${deployment.address}${extra ? '/regression/b' : '/help'}`]);
    assert.match(response, /^HTTP\/1.1 200/m); assert.ok(response.toLowerCase().includes(`x-fixture-sha256: ${hashes.serverSha256}`));
    const image = await read(['docker', 'inspect', '-f', '{{.Image}}', 'qa-browser']); assert.equal(image, deployment.browserImage);
    const site = JSON.parse(await read(['docker', 'inspect', deployment.container]));
    assert.equal(site.length, 1); assert.equal(site[0].Id, deployment.containerId); assert.equal(site[0].Image, deployment.containerImage);
    assert.equal(site[0].Config.Labels['syna.isolation'], linux.name); assert.equal(site[0].Config.Labels['syna.fixture.sha256'], hashes.serverSha256);
    assert.equal(site[0].NetworkSettings.Networks['qa-fixture-net'].IPAddress, deployment.address);
    assert.equal(site[0].State.Running, true); assert.equal(site[0].HostConfig.Runtime, 'runsc');
    assert.equal(site[0].HostConfig.ReadonlyRootfs, true); assert.deepEqual(site[0].Config.Cmd, ['node', '/fixture/launcher.mjs']);
    assert.deepEqual(site[0].Mounts.map(row => [row.Source, row.Destination, row.RW]), [[deployment.directory, '/fixture', false]], 'Unexpected fixture filesystem exposure');
    const hosts = await read(['docker', 'exec', 'qa-browser', 'cat', '/etc/hosts']);
    assert.ok(hosts.split('\n').some(line => (extra ? /^192\.0\.2\.12\s+qa-regression\.test\s+qa-auth\.test\s*$/ : /^192\.0\.2\.11\s+qa-benchmark\.test\s*$/).test(line)), 'Browser fixture host is not explicitly isolated');
    const deployedFiles = await read(['sha256sum', `${deployment.directory}/server.mjs`, `${deployment.directory}/launcher.mjs`]);
    const [serverLine, launcherLine] = deployedFiles.split('\n');
    assert.equal(serverLine.split(/\s+/)[0], hashes.serverSha256); assert.equal(launcherLine.split(/\s+/)[0], deployment.launcherSha256);
    return { observedAt: new Date().toISOString(), siteSha256: hashes.serverSha256, browserImage: image, containerImage: site[0].Image, containerId: site[0].Id };
  }
  async function login(account) {
    secrets.add(account.password);
    const cookies = new Map();
    const auth = createServerClient(fixture.auth.url, fixture.auth.anonKey, { cookieOptions: { name: 'pat_supabase_auth', path: '/', sameSite: 'lax' },
      cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(row => cookies.set(row.name, row.value)) } });
    const signed = await auth.auth.signInWithPassword({ email: account.email, password: account.password });
    assert.equal(signed.error, null, 'Local ordinary login failed'); assert.equal(signed.data.user.id, account.userId); assert.equal(signed.data.user.role, 'authenticated');
    secrets.add(signed.data.session.access_token); secrets.add(signed.data.session.refresh_token);
    const value = [...cookies].map(([name, entry]) => `${name}=${entry}`).join('; '); secrets.add(value); return value;
  }
  async function post(path, body, expectedStatus = 200, access = cookie, method = 'POST') {
    const response = await fetch(origin + path, { method, redirect: 'error', headers: { cookie: access, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    assert.ok([expectedStatus].flat().includes(response.status), `Owner API returned unexpected status (${path}): ${response.status}`);
    return response.status >= 200 && response.status < 300 ? response.json() : (await response.body?.cancel(), { status: response.status });
  }
  const get = (path, access = cookie) => fetch(origin + path, { redirect: 'manual', headers: access ? { cookie: access } : {}, signal: AbortSignal.timeout(20000) });
  async function privateDenials(path) {
    const statuses = [];
    for (const access of [null, foreignCookie]) { const denied = await get(path, access); await denied.body?.cancel(); assert.ok([401, 403, 404].includes(denied.status), 'Private evidence was disclosed'); statuses.push(denied.status); }
    return statuses;
  }
  async function observe(workspaceId) {
    // Read one MVCC snapshot so multi-table comparisons cannot invent races.
    return sql.begin('isolation level repeatable read read only', async db => {
      const [missions, tasks, attempts, jobs, runs, reviews, reports, claims, waits, captures, versions, browsers, reportItems, events, reportBindings] = await Promise.all([
        db`select id,user_id,workspace_id,thread_id,runtime,lifecycle,phase,closure_reason,admission,config,mandate,mandate_revision,plan_revision,deadline_at,report_deadline_at,lease_until,closed_at from pat_missions where workspace_id=${workspaceId} and runtime=${fixture.runtimeScope} order by created_at,id`,
        db`select t.id,t.mission_id,t.state,t.spec,t.plan_revision,t.supplement_round,t.operation_id,t.depends_on,t.created_at from pat_mission_tasks t join pat_missions m on m.id=t.mission_id where m.workspace_id=${workspaceId} order by t.created_at,t.id`,
        db`select a.id,a.runtime,a.mission_id,a.task_id,a.kind,a.status,a.dispatch_id,a.operation_id,a.attempt_no,a.mandate_revision,a.plan_revision,a.executor_resource_id,a.usage,a.tool_calls,a.created_at,a.finished_at,a.lease_until,a.deadline_at,a.supplement_round,a.cancel_requested_at,
          coalesce((select jsonb_agg(v.value order by v.value) from jsonb_array_elements_text(a.tool_call_ids) v(value) where v.value like 'server:iris-model:start:%'),'[]'::jsonb) as model_starts
          from pat_mission_attempts a join pat_missions m on m.id=a.mission_id where m.workspace_id=${workspaceId} order by a.created_at,a.id`,
        db`select b.id,b.runtime,b.thread_id,b.status,b.session_id,b.dispatch_lease_until from pat_browser_jobs b join pat_threads t on t.id=b.thread_id where t.workspace_id=${workspaceId} order by b.created_at,b.id`,
        db`select id,thread_id,item_id,case_id,plan_version,snapshot,target,runtime,result,started_at,finished_at,mission_attempt_id,browser_entry_receipt from pat_test_runs where workspace_id=${workspaceId} order by started_at,id`,
        db`select id,run_id,status,assessment,input,reviewer_version,source_hash,input_hash,created_at,finished_at from pat_result_assessments where workspace_id=${workspaceId} and runtime=${fixture.runtimeScope} order by created_at,id`,
        db`select r.id,r.mission_id,r.status,r.item_id,r.document,r.usage,r.lease_until,r.read_receipts,r.finished_at from pat_mission_reports r join pat_missions m on m.id=r.mission_id where m.workspace_id=${workspaceId} order by r.created_at,r.id`,
        db`select id,state,owner,attempt_id,executor_resource_id from pat_mission_resource_claims where workspace_id=${workspaceId} order by id`,
        db`select w.id,w.mission_id,w.state,w.definition,w.created_at,w.deadline_at,w.answered_at from pat_mission_waits w join pat_missions m on m.id=w.mission_id where m.workspace_id=${workspaceId} order by w.created_at,w.id`,
        db`select c.id,c.run_id,c.item_id,c.url,c.action,i.provenance,i.content,i.deleted_at from pat_test_captures c join pat_test_runs r on r.id=c.run_id left join pat_workspace_items i on i.id=c.item_id where r.workspace_id=${workspaceId} order by c.id`,
        db`select v.item_id,v.version,v.content,v.created_at from pat_workspace_item_versions v join pat_workspace_items i on i.id=v.item_id where i.workspace_id=${workspaceId} and i.content->>'kind'='test_plan' order by v.item_id,v.version`,
        db`select id,session_id,agent_id,control from pat_browser_assignments where workspace_id=${workspaceId} order by id`,
        db`select i.id,i.version,i.deleted_at from pat_workspace_items i join pat_mission_reports r on r.item_id=i.id where i.workspace_id=${workspaceId} order by i.id`,
        db`select e.mission_id,e.kind,e.event_key,e.created_at,e.payload,e.payload->>'actionHash' as action_hash from pat_mission_events e join pat_missions m on m.id=e.mission_id where m.workspace_id=${workspaceId} and m.runtime=${fixture.runtimeScope} and (e.kind like 'control_%' or e.kind in ('browser_remainder_planned','complement_planned','report_requested','interim_report_requested','interim_report_abandoned')) order by e.revision`,
        db`select r.id,r.mission_id,s.id as snapshot_id,s.hash as snapshot_hash,
          s.input->>'missionId' as snapshot_mission_id,s.input->>'workspaceId' as snapshot_workspace_id,
          s.input->'config' as snapshot_config,s.input->'delivery' as snapshot_delivery,s.input->'tasks' as snapshot_tasks,
          coalesce(s.input->>'reportPurpose','final') as purpose,s.input->>'capturedAt' as captured_at,
          coalesce((select jsonb_agg(jsonb_build_object('taskId',t->>'id','evidenceCount',
            (select coalesce(sum(jsonb_array_length(src->'evidence')),0) from jsonb_array_elements(t->'sources') src
              where src->>'status' in ('completed','failed'))))
            from jsonb_array_elements(s.input->'tasks') t where t->>'state'='completed'),'[]'::jsonb) as completed_sources
          from pat_mission_reports r join pat_mission_snapshots s on s.id=r.snapshot_id join pat_missions m on m.id=r.mission_id
          where m.workspace_id=${workspaceId} and m.runtime=${fixture.runtimeScope} order by r.created_at,r.id`,
      ]);
      return { missions, tasks, attempts, jobs, runs, reviews, reports, claims, waits, captures, versions, browsers, reportItems, events, reportBindings };
    });
  }
  async function evidence(state, workspaceId, access = cookie) {
    const captures = state.captures.filter(row => row.item_id && !row.deleted_at && ['browser-action', 'test-capture'].includes(row.provenance?.producer));
    assert.ok(captures.length <= 240, 'Evidence inspection budget exceeded');
    const traces = [], effects = [], receipts = [], byteEvidence = new Set(); let total = 0;
    for (const capture of captures) {
      assert.ok(Number.isSafeInteger(capture.content.size) && capture.content.size > 0 && capture.content.size <= 4 * 1024 * 1024 && total + capture.content.size <= 64 * 1024 * 1024);
      const path = `/api/workspaces/${workspaceId}/items/${capture.item_id}/file`, response = await get(path, access); assert.equal(response.status, 200);
      const chunks = [], reader = response.body.getReader(); let size = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; assert.ok(size <= capture.content.size); chunks.push(next.value); } }
      finally { await reader.cancel().catch(() => {}); }
      const bytes = Buffer.concat(chunks); total += size; assert.equal(size, capture.content.size); assert.equal(hash(bytes), capture.provenance.sha256);
      assert.equal(capture.provenance.origin, 'tool'); assert.equal(capture.provenance.sourceType, 'test'); assert.equal(capture.provenance.sourceId, capture.run_id);
      const finished = state.runs.some(row => row.id === capture.run_id && row.finished_at && row.result);
      if (capture.provenance.producer === 'browser-action') {
        effects.push(readBrowserEffectTrace(capture, bytes, state, fixture.runtimeScope, new Date().toISOString()));
        if (finished) traces.push(auditTrace(capture, bytes, state));
      }
      else if (capture.provenance.producer === 'test-capture') assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      byteEvidence.add(capture.item_id); receipts.push({ itemId: capture.item_id, sha256: hash(bytes), bytes: size, fromFinishedRun: finished, denials: await privateDenials(path) });
    }
    return { traces, effects, byteEvidence, receipts, totalBytes: total };
  }
  async function userInteraction(trial, state, deadline) {
    const timely = action => observeWebBeforeDeadline(deadline, action);
    const save = () => timely(persist);
    const send = (...args) => timely(() => post(...args));
    if (!protocol.takeover) return;
    if (!trial.fault) {
      assert.ok(Date.now() - Date.parse(trial.acceptedAt) <= protocol.takeover.latestSeconds * 1000, 'Takeover trigger was not reached in its frozen window');
      const selected = taskId === 'AUTH-09' ? authenticationCandidate(state) : takeoverCandidate(state); if (!selected) return;
      trial.fault = { ...selected, requestedAt: new Date().toISOString() }; await save();
      const triggerDeadline = Math.min(deadline, Date.parse(trial.acceptedAt) + protocol.takeover.latestSeconds * 1000);
      requireWebDeadline(triggerDeadline);
      const response = await send(`/api/threads/${trial.threadId}/browser`, { control: 'human', sessionId: selected.sessionId });
      requireWebDeadline(triggerDeadline);
      assert.equal(response.browser.sessionId, selected.sessionId); assert.equal(response.browser.control, 'human');
      trial.fault.confirmedAt = new Date().toISOString(); await save();
      if (taskId === 'AUTH-09' && variant === 'return-in-time') {
        const baseline = await timely(() => readFixtureAuthAudit(fixture)); assert.equal(baseline.revision, hashes.serverSha256);
        trial.fault.loginInput = await timely(() => submitFixtureLogin({ liveUrl: response.browser.liveUrl, sessionId: selected.sessionId, origin: fixture.browser.url })); await save();
        const loginDeadline = Math.min(deadline, Date.now() + 15000); let proof;
        while (Date.now() < loginDeadline) {
          const receipt = await observeWebBeforeDeadline(loginDeadline, () => readFixtureAuthAudit(fixture));
          try { proof = validateHumanLogin(receipt, trial.fault.loginInput, hashes.serverSha256); break; } catch { /* Bounded wait only for this physical form submission, never retry it. */ }
          await new Promise(done => setTimeout(done, 100));
        }
        assert.ok(proof, 'Actual human login/cookie verification did not complete; no answer was sent'); trial.fault.loginProof = proof; await save();
      }
      return;
    }
    const wait = originalWait(state, trial.fault); if (!wait) return;
    trial.fault.waitId ??= wait.id; trial.fault.waitDeadlineAt ??= wait.deadline_at;
    assert.equal(String(wait.deadline_at), String(trial.fault.waitDeadlineAt), 'Active wait deadline was rewritten');
    if (variant !== 'return-in-time' || trial.fault.answeredAt || wait.state !== 'waiting'
      || Date.now() < Date.parse(wait.created_at) + protocol.takeover.holdSeconds * 1000) return;
    assert.ok(Date.now() < Date.parse(wait.deadline_at), 'Return missed the actual wait deadline');
    const mission = state.missions[0];
    trial.fault.attemptStatusAtReturn = state.attempts.find(row => row.id === trial.fault.attemptId).status;
    trial.fault.answer = { action: 'answer', missionId: mission.id, requestId: randomUUID(), expectedMandateRevision: mission.mandate_revision,
      waitId: wait.id, answer: { kind: 'browser_returned', sessionId: trial.fault.sessionId } };
    await save(); // Same saved identity is required after an uncertain request; no automatic retry.
    requireWebDeadline(Math.min(deadline, Date.parse(wait.deadline_at)));
    const response = await send(`/api/threads/${trial.threadId}/browser`, { control: 'agent', sessionId: trial.fault.sessionId });
    requireWebDeadline(Math.min(deadline, Date.parse(wait.deadline_at)));
    assert.equal(response.browser.sessionId, trial.fault.sessionId); assert.equal(response.browser.control, 'agent');
    await send(`/api/workspaces/${trial.workspaceId}/autonomy`, { threadId: trial.threadId, input: trial.fault.answer });
    trial.fault.answeredAt = new Date().toISOString(); await save();
  }
  async function createWorkspace(account, access, name) {
    const workspace = (await post('/api/workspaces', { name }, 200, access)).workspace;
    const thread = (await post('/api/threads', { workspaceId: workspace.id, title: 'Testa webbplatsen' }, 201, access)).thread;
    assertIsolatedRoundTrip({ workspaceId: workspace.id, threadId: thread.id, userId: account.userId }, {
      workspaces: [...await sql`select id,user_id from pat_workspaces where id=${workspace.id}`], threads: [...await sql`select id,workspace_id,user_id from pat_threads where id=${thread.id}`],
    });
    assert.ok(Object.values(await observe(workspace.id)).every(rows => rows.length === 0), 'Fresh workspace contains undeclared input');
    return { workspaceId: workspace.id, threadId: thread.id, userId: account.userId };
  }
  async function submit(work, access, selectedProtocol) {
    const client = new Client({ host: origin, redirect: 'error', headers: { cookie: access, 'x-pat-browser-thread': work.threadId, 'x-pat-message-id': randomUUID(), 'x-pat-chat-model': selectedProtocol.model, 'x-pat-reasoning': selectedProtocol.reasoning } });
    const submitted = await client.sessions.create({ message: selectedProtocol.prompt });
    return { sessionId: submitted.session.state.sessionId, acceptedAt: new Date().toISOString() };
  }
  async function regressionInteraction(trial, state, independent, deadline) {
    const timely = action => observeWebBeforeDeadline(deadline, action);
    const save = () => timely(persist);
    const send = (...args) => timely(() => post(...args));
    if (protocol.edit && !trial.fault) {
      assert.ok(Date.now() - Date.parse(trial.acceptedAt) <= protocol.edit.latestSeconds * 1000, 'Frozen plan-edit window was not reached');
      const selected = regressionEditCandidate(state, trial.preparation); if (!selected) return;
      const content = structuredClone(trial.preparation.afterContent); content.cases[0].expected += ' Returlänken ska också vara märkt med Tillbaka.';
      trial.fault = { ...selected, requestedAt: new Date().toISOString(), expectedVersion: 2, content, savedContentSha256: regressionFingerprint(content) }; await save();
      requireWebDeadline(Math.min(deadline, Date.parse(trial.acceptedAt) + protocol.edit.latestSeconds * 1000));
      const { item } = await send(`/api/workspaces/${trial.workspaceId}/items/${trial.preparation.planId}`, { title: regressionPlanTitle, expectedVersion: 2, content }, 200, cookie, 'PATCH');
      requireWebDeadline(Math.min(deadline, Date.parse(trial.acceptedAt) + protocol.edit.latestSeconds * 1000));
      assert.equal(item.version, 3); assert.deepEqual(item.content, content);
      trial.fault.planEditedAt = new Date().toISOString(); trial.fault.savedVersion = item.version; await save();
      // A race that admitted execution before the edit invalidates this trial.
      assert.equal(projectRegressionMission(await timely(() => observe(trial.workspaceId)), trial.preparation, trial.threadId).attempts.filter(row => row.kind === 'browser_tests').length, 0, 'Missed the pre-execution plan-edit boundary');
    }
    if (protocol.stop && !trial.fault) {
      assert.ok(Date.now() - Date.parse(trial.acceptedAt) <= protocol.stop.latestSeconds * 1000, 'Cancellation window was not reached');
      const mission = state.missions.length === 1 && state.missions[0];
      if (!mission || mission.lifecycle === 'closed' || mission.workspace_id !== trial.workspaceId
        || mission.thread_id !== trial.threadId || mission.user_id !== trial.userId || mission.runtime !== fixture.runtimeScope) return;
      // The browser attempt stays dispatching while its exact Iris job runs.
      // A queued dispatch without a saved physical assignment is not this fault.
      let selected;
      for (const attempt of state.attempts) {
        if (attempt.kind !== 'browser_tests' || !['dispatching', 'running'].includes(attempt.status) || attempt.finished_at || attempt.cancel_requested_at
          || attempt.mission_id !== mission.id || attempt.runtime !== mission.runtime || attempt.plan_revision !== mission.plan_revision
          || attempt.mandate_revision !== mission.mandate_revision || !(Date.parse(attempt.deadline_at) > Date.now())) continue;
        const job = state.jobs.find(row => row.id === attempt.dispatch_id && row.runtime === mission.runtime
          && row.thread_id === mission.thread_id && row.status === 'running' && row.session_id);
        const browser = job && state.browsers.find(row => row.agent_id === job.session_id && row.control === 'agent' && row.session_id);
        const claim = browser && state.claims.find(row => row.attempt_id === attempt.id && row.state === 'claimed'
          && row.owner === 'agent' && row.executor_resource_id === browser.session_id);
        if (claim) { selected = { attempt, job, browser, claim }; break; }
      }
      if (!selected) return;
      const { attempt, job, browser, claim } = selected;
      const other = await timely(() => observe(independent.workspaceId));
      assert.ok(independent.userId !== trial.userId && independent.workspaceId !== trial.workspaceId && independent.threadId !== trial.threadId
        && other.missions.length === 1 && other.missions[0].lifecycle !== 'closed' && other.missions[0].user_id === independent.userId
        && other.missions[0].workspace_id === independent.workspaceId && other.missions[0].thread_id === independent.threadId
        && other.missions[0].runtime === fixture.runtimeScope, 'Independent owner is not active in its exact original workspace/thread');
      trial.fault = { requestedAt: new Date().toISOString(), attemptId: attempt.id, jobId: job.id, sessionId: browser.session_id, claimId: claim.id, independentBefore: other,
        command: { action: 'cancel', missionId: mission.id, requestId: randomUUID(), expectedMandateRevision: mission.mandate_revision } }; await save();
      requireWebDeadline(Math.min(deadline, Date.parse(trial.acceptedAt) + protocol.stop.latestSeconds * 1000));
      await send(`/api/workspaces/${trial.workspaceId}/autonomy`, { threadId: trial.threadId, input: trial.fault.command });
      requireWebDeadline(Math.min(deadline, Date.parse(trial.acceptedAt) + protocol.stop.latestSeconds * 1000));
      trial.fault.cancelledAt = new Date().toISOString(); await save();
      // Exact committed command and persisted revocation, not an invented
      // timestamp for every physical action in the original attempt.
      trial.fault.postCancelObservation = cancelledExecutionBaseline(projectRegressionMission(await timely(() => observe(trial.workspaceId)), trial.preparation, trial.threadId), trial.fault, new Date().toISOString()); await save();
    }
  }
  try {
    artifact.runtime = await freeze(); artifact.deployment = await preflightSite(); await persist();
    // Construct DB/auth clients ONLY after compiled artifacts and processes pass.
    sql = postgres(fixture.databaseUrl, { prepare: false, max: 1, types: utcObservationTypes, connection: { TimeZone: 'UTC', default_transaction_read_only: 'on' } });
    assert.equal((await sql`show transaction_read_only`)[0].transaction_read_only, 'on');
    const admin = createClient(fixture.auth.url, fixture.auth.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    createAccount = async label => {
      const value = { email: `browser-variants-${label}-${randomUUID()}@example.test`, password: randomUUID() + randomUUID() }; secrets.add(value.password);
      const created = await admin.auth.admin.createUser({ ...value, email_confirm: true }); assert.equal(created.error, null, 'Isolated account preparation failed');
      return { ...value, userId: created.data.user.id };
    };
    foreignCookie = await login(await createAccount('foreign'));
    for (const trial of artifact.trials) {
      trial.status = 'running'; trial.startedAt = new Date().toISOString(); trial.snapshots = []; await persist();
      try {
        await freeze(); trial.siteBefore = await preflightSite(); const owner = await createAccount('owner'); trial.ownerUserId = owner.userId; cookie = await login(owner);
        Object.assign(trial, await createWorkspace(owner, cookie, `${taskId} ${variant} ${runId.slice(0, 8)}-${trial.repetition}`));
        const workspace = { id: trial.workspaceId }, thread = { id: trial.threadId };
        trial.databaseRoundTripAt = new Date().toISOString(); await persist();
        if (taskId === 'WEB-04') {
          const beforeContent = actualRegressionPlan(undefined, 'a');
          trial.preparationProgress = { phase: 'plan_A_requested', startedAt: new Date().toISOString(), beforeContent }; await persist();
          const original = (await post(`/api/workspaces/${workspace.id}/items`, { title: regressionPlanTitle, content: beforeContent, threadId: thread.id })).item;
          assert.equal(original.version, 1); assert.deepEqual(original.content, beforeContent);
          trial.preparationProgress.planId = original.id; trial.preparationProgress.phase = 'natural_A_requested'; await persist();
          const first = { ...await submit(trial, cookie, actualHistoryExecutionProtocol(protocol)), snapshots: [] };
          const until = Date.parse(first.acceptedAt) + 1500_000; let previous;
          trial.preparationProgress.execution = first; await persist(); requireWebDeadline(until);
          while (Date.now() < until) {
            const observed = await observeWebBeforeDeadline(until, () => observe(workspace.id));
            if (JSON.stringify(previous) !== JSON.stringify(observed)) { previous = observed; first.snapshots.push({ at: new Date().toISOString(), ...observed }); await persist(); requireWebDeadline(until); }
            if (observed.missions.length && observed.missions.every(row => row.lifecycle === 'closed')) { first.closedAt = new Date().toISOString(); break; }
            await new Promise(done => setTimeout(done, 1000));
          }
          requireWebDeadline(until);
          assert.ok(first.closedAt, 'Actual A preparation did not close inside its own frozen observation window');
          await freeze(); await preflightSite();
          const firstState = first.snapshots.at(-1), firstReads = await evidence(firstState, workspace.id);
          const identity = { workspaceId: workspace.id, userId: owner.userId, threadId: thread.id, sessionId: first.sessionId, planId: original.id,
            runtime: fixture.runtimeScope, sourceHash: artifact.sourceHash, fixtureSourceHash: hashes.serverSha256,
            harnessSha256: artifact.harnessSha256, helperSha256: artifact.helperHashes['browser-variants-history.mjs'] };
          const scheduler = (await readFile(resolve(root, 'scheduled-http.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
            .filter(row => row.timestamp >= first.acceptedAt && row.timestamp <= first.closedAt);
          const firstReport = auditBrowserReports(firstState).final, firstReportPath = `/api/workspaces/${workspace.id}/reports/${firstReport.id}`;
          const firstResponse = await get(firstReportPath); assert.equal(firstResponse.status, 200); const firstBody = await firstResponse.json();
          assert.equal(firstBody.stale, false); assert.equal(firstBody.itemId, firstReport.item_id); assert.deepEqual(firstBody.document, firstReport.document);
          const ownerReport = { reportId: firstReport.id, itemId: firstBody.itemId, stale: firstBody.stale, documentSha256: regressionFingerprint(firstBody.document), denials: await privateDenials(firstReportPath) };
          const preparation = sealActualRegressionHistory({ state: firstState, context: { protocol, reviewerPolicy: artifact.reviewerPolicy, runChecksPolicy: artifact.runChecksPolicy, history: first.snapshots, ...firstReads },
            identity, plan: beforeContent, receipts: firstReads.receipts, scheduler, ownerReport, acceptedAt: first.acceptedAt, closedAt: first.closedAt });
          const preparationPath = resolve('.data/autonomy-isolation', `browser-actual-history-${randomUUID()}.json`), preparationBytes = Buffer.from(redact(JSON.stringify(preparation, null, 2)));
          requireWebDeadline(until);
          await writeFile(preparationPath, preparationBytes, { flag: 'wx' });
          trial.preparationArtifact = { path: preparationPath, artifactSha256: hash(preparationBytes), identity };
          trial.preparation = importActualRegressionHistory(preparationBytes, trial.preparationArtifact, firstState, firstReads, protocol);
          trial.preparationProgress.phase = 'actual_A_verified_before_B_edit'; await persist(); requireWebDeadline(until);
          const plan = (await post(`/api/workspaces/${workspace.id}/items/${original.id}`, { title: regressionPlanTitle, expectedVersion: 1, content: preparation.afterContent }, 200, cookie, 'PATCH')).item;
          assert.equal(plan.id, original.id); assert.equal(plan.version, 2); assert.deepEqual(plan.content, preparation.afterContent);
          trial.preparationProgress.phase = 'B_plan_saved_new_chat_requested'; await persist();
          const next = (await post('/api/threads', { workspaceId: workspace.id, title: 'Regression efter ändringen' }, 201)).thread;
          assertIsolatedRoundTrip({ workspaceId: workspace.id, threadId: next.id, userId: owner.userId }, {
            workspaces: [...await sql`select id,user_id from pat_workspaces where id=${workspace.id}`], threads: [...await sql`select id,workspace_id,user_id from pat_threads where id=${next.id}`],
          });
          thread.id = next.id; trial.threadId = next.id; trial.preparationProgress.phase = 'actual_history_ready_for_B'; await persist();
        }
        let independent, independentCookie;
        if (protocol.stop) {
          // Separate ordinary owner and natural prompt; never an internal job.
          const other = await createAccount('independent'); independentCookie = await login(other);
          independent = await createWorkspace(other, independentCookie, `S1 independent ${runId.slice(0, 8)}`);
          independent.protocol = browserVariantProtocol('WEB-03', 'normal', 1); independent.snapshots = [];
          const bytes = await readFile('tests/fixtures/autonomy-benchmark-sites/oracle.json'); independent.oracle = JSON.parse(bytes);
          const otherHashes = { serverSha256: hash(await readFile('tests/fixtures/autonomy-benchmark-sites/server.mjs')), oracleSha256: hash(bytes), resolverSha256: hash(await readFile('tests/helpers/browser-variants-resolver.mjs')), runtimeScope: fixture.runtimeScope };
          independent.hashes = otherHashes; independent.deployment = assertDeployment(await json('.data/autonomy-isolation/linux/browser-variants-deployment.json'), otherHashes);
          independent.siteBefore = await preflightSite(independent.deployment, otherHashes, false);
          trial.independent = independent; await persist();
        }
        trial.measuredFrom = new Date().toISOString(); await persist();
        Object.assign(trial, await submit(trial, cookie, protocol));
        const deadline = Date.parse(trial.acceptedAt) + protocol.observationSeconds * 1000;
        const timely = action => observeWebBeforeDeadline(deadline, action);
        await timely(persist);
        if (independent) { Object.assign(independent, await timely(() => submit(independent, independentCookie, independent.protocol))); await timely(persist); }
        // No status/subscription/result or additional prompt: the chat is disconnected.
        let prior;
        while (Date.now() < deadline) {
          const fullState = await timely(() => observe(workspace.id));
          const state = trial.preparation ? projectRegressionMission(fullState, trial.preparation, trial.threadId) : fullState;
          if (JSON.stringify(prior) !== JSON.stringify(state)) { prior = state; trial.snapshots.push({ at: new Date().toISOString(), ...state }); await timely(persist); }
          if (independent) {
            const other = await timely(() => observe(independent.workspaceId));
            if (JSON.stringify(independent.snapshots.at(-1)?.state) !== JSON.stringify(other)) { independent.snapshots.push({ at: new Date().toISOString(), state: other }); await timely(persist); }
            if (other.missions.length && other.missions.every(row => row.lifecycle === 'closed')) independent.closedAt ??= new Date().toISOString();
          }
          if (state.missions.length && state.missions.every(row => row.lifecycle === 'closed')) {
            trial.closedAt ??= new Date().toISOString(); if (!independent || independent.closedAt) break;
          } else { await userInteraction(trial, state, deadline); await regressionInteraction(trial, state, independent, deadline); }
          await new Promise(done => setTimeout(done, protocol.takeover || protocol.edit || protocol.stop ? 250 : 1000));
        }
        requireWebDeadline(deadline);
        assert.ok(trial.closedAt, 'Mission did not close in frozen observation window'); const final = trial.snapshots.at(-1);
        assert.equal(final.missions[0]?.user_id, owner.userId); assert.equal(final.missions[0]?.workspace_id, workspace.id); assert.equal(final.missions[0]?.runtime, fixture.runtimeScope);
        await timely(freeze); trial.siteAfter = await timely(() => preflightSite());
        const whole = trial.preparation ? await timely(() => observe(workspace.id)) : final, allReads = await timely(() => evidence(whole, workspace.id));
        if (trial.preparation) {
          trial.preparation = importActualRegressionHistory(await readFile(trial.preparationArtifact.path), trial.preparationArtifact, whole, allReads, protocol);
          trial.historicalEvidenceReads = allReads.receipts.filter(row => trial.preparation.receipts.some(old => old.itemId === row.itemId));
        }
        const ids = new Set(final.captures.map(row => row.item_id)), runs = new Set(final.runs.map(row => row.id));
        const reads = { ...allReads, traces: allReads.traces.filter(row => runs.has(row.capture.run_id)), effects: allReads.effects.filter(row => runs.has(row.capture.run_id)),
          byteEvidence: new Set([...allReads.byteEvidence].filter(id => ids.has(id))), receipts: allReads.receipts.filter(row => ids.has(row.itemId)) };
        reads.totalBytes = reads.receipts.reduce((sum, row) => sum + row.bytes, 0); trial.evidenceReads = reads.receipts; trial.evidenceBytes = reads.totalBytes;
        if (independent) {
          assert.ok(independent.closedAt, 'Independent owner did not finish');
          independent.siteAfter = await timely(() => preflightSite(independent.deployment, independent.hashes, false));
          const otherFinal = independent.snapshots.at(-1).state, otherReads = await evidence(otherFinal, independent.workspaceId, independentCookie);
          assert.equal(otherFinal.missions[0]?.user_id, independent.userId); assert.equal(otherFinal.missions[0]?.workspace_id, independent.workspaceId); assert.equal(otherFinal.missions[0]?.runtime, fixture.runtimeScope);
          const otherAudit = auditBrowserVariant(otherFinal, { protocol: independent.protocol, oracle: independent.oracle, runtime: fixture.runtimeScope, reviewerPolicy: artifact.reviewerPolicy, runChecksPolicy: artifact.runChecksPolicy, history: independent.snapshots.map(row => ({ at: row.at, ...row.state })), ...otherReads });
          const response = await get(`/api/workspaces/${independent.workspaceId}/reports/${otherAudit.report.id}`, independentCookie); assert.equal(response.status, 200);
          const document = await response.json(); assert.equal(document.stale, false); assert.deepEqual(document.document, otherAudit.report.document);
          independent.evidenceReads = otherReads.receipts; independent.oracleMatches = otherAudit.matches; independent.verified = true;
          const crossed = await get(`/api/workspaces/${independent.workspaceId}/reports/${otherAudit.report.id}`, cookie); assert.ok([403, 404].includes(crossed.status)); await crossed.body?.cancel();
        }
        const reportBinding = taskId === 'WEB-04' ? auditBrowserReports(final, { fault: trial.fault }) : null;
        if (taskId === 'WEB-04') {
          if (variant === 'normal') trial.regression = auditActualRegressionB(final, trial.preparation, reportBinding.final);
          else {
            assert.equal(final.claims.length, 0); assert.equal(final.missions[0].lifecycle, 'closed');
            assert.equal(final.missions[0].lease_until, null); assert.ok(final.browsers.every(row => !row.session_id));
            assert.ok(final.attempts.every(row => ['completed', 'failed', 'cancelled'].includes(row.status) && row.finished_at && !row.lease_until));
            assert.ok(final.jobs.every(row => ['completed', 'failed', 'cancelled'].includes(row.status) && !row.dispatch_lease_until));
            assert.equal(final.missions[0].admission.intent, 'regression'); assert.equal(final.missions[0].admission.target.url, protocol.targetUrl);
            assert.deepEqual([...final.missions[0].admission.caseKeys].sort(), [...trial.preparation.caseKeys].sort());
            assert.deepEqual(final.versions.find(row => row.item_id === trial.preparation.planId && row.version === 2)?.content, trial.preparation.afterContent);
            if (variant === 'plan-changed') {
              assert.ok(trial.fault?.planEditedAt && trial.fault.expectedVersion === 2 && trial.fault.savedVersion === 3); assert.equal(final.runs.length, 0);
              const saved = final.versions.find(row => row.item_id === trial.preparation.planId && row.version === 3);
              assert.equal(regressionFingerprint(saved?.content), trial.fault.savedContentSha256); assert.equal(reportBinding.final.document.partial, true);
              assert.ok(['blocked', 'deadline', 'budget_exhausted'].includes(final.missions[0].closure_reason));
            } else {
              assert.equal(final.missions[0].closure_reason, 'cancelled'); assert.ok(independent?.verified && independent.userId !== owner.userId && Date.parse(independent.closedAt) > Date.parse(trial.fault.cancelledAt));
            }
            trial.regression = { historicalBaseline: 'actual-natural-QA-A', historicalRunIds: trial.preparation.runIds, actualHistoryVerified: true, fullRealHistoricalRegression: false, semanticComparison: 'independent_review_pending' };
          }
        }
        if (protocol.stop) trial.effectAudit = auditCancelledBrowserEffects(final, { fault: trial.fault, effects: reads.effects, observedAt: new Date().toISOString() });
        const current = final; // A graph is excluded by the exact B-thread projection, never by a guessed latest run.
        const audited = taskId === 'WEB-04' && variant !== 'normal' ? { report: reportBinding.final, reportScope: reportBinding.receipt, matches: [], outcome: variant === 'plan-changed' ? 'correct_changed_plan_partial' : 'correct_owner_cancel_and_independent_completion' }
          : auditBrowserVariant(current, { protocol, oracle, runtime: fixture.runtimeScope, fault: trial.fault, history: trial.snapshots, historicalComparison: trial.regression, reviewerPolicy: artifact.reviewerPolicy, runChecksPolicy: artifact.runChecksPolicy, ...reads });
        if (audited.effectAudit) trial.effectAudit = audited.effectAudit;
        trial.reportScope = audited.reportScope ?? null; trial.complements = audited.complements ?? []; trial.remainders = audited.remainders ?? []; trial.humanResumptions = audited.humanResumptions ?? []; trial.humanAttemptContinuations = audited.humanAttemptContinuations ?? []; trial.reviewScope = audited.reviewScope ?? null;
        trial.oracleMatches = audited.matches; trial.outcome = audited.outcome; trial.retainedHumanClaims = audited.retainedHumanClaims ?? [];
        if (taskId === 'AUTH-09' && variant === 'return-in-time') trial.authentication = auditAuthenticatedContinuation(final, trial.fault, audited.matches, await timely(() => readFixtureAuthAudit(fixture)), hashes.serverSha256, reads.traces);
        const path = `/api/workspaces/${workspace.id}/reports/${audited.report.id}`, report = await timely(() => get(path)); assert.equal(report.status, 200);
        const body = await timely(() => report.json()); assert.equal(body.stale, false); assert.equal(body.itemId, audited.report.item_id); assert.deepEqual(body.document, audited.report.document);
        trial.reportDenials = await timely(() => privateDenials(path));
        const completionDeadline = deadline + (variant === 'late-answer' ? protocol.takeover.lateAnswerObservationSeconds * 1000 : 0);
        if (variant === 'late-answer') {
          requireWebDeadline(deadline);
          const before = closedExecutionIdentity(final), mission = final.missions[0];
          trial.fault.lateAnswer = { action: 'answer', missionId: mission.id, requestId: randomUUID(), expectedMandateRevision: mission.mandate_revision,
            waitId: trial.fault.waitId, answer: { kind: 'browser_returned', sessionId: trial.fault.sessionId } };
          await timely(persist); trial.fault.lateDenial = await post(`/api/workspaces/${workspace.id}/autonomy`, { threadId: thread.id, input: trial.fault.lateAnswer }, 409);
          trial.fault.otherSessionAnswer = { ...trial.fault.lateAnswer, requestId: randomUUID(), answer: { kind: 'browser_returned', sessionId: randomUUID() } };
          requireWebDeadline(deadline);
          trial.fault.otherOwnerAnswer = { ...trial.fault.lateAnswer, requestId: randomUUID() }; await timely(persist);
          trial.fault.otherSessionDenial = await post(`/api/workspaces/${workspace.id}/autonomy`, { threadId: thread.id, input: trial.fault.otherSessionAnswer }, 409);
          requireWebDeadline(deadline);
          trial.fault.otherOwnerDenial = await post(`/api/workspaces/${workspace.id}/autonomy`, { threadId: thread.id, input: trial.fault.otherOwnerAnswer }, [403, 404], foreignCookie);
          requireWebDeadline(deadline);
          const until = Date.now() + protocol.takeover.lateAnswerObservationSeconds * 1000;
          while (Date.now() < until) { assert.deepEqual(closedExecutionIdentity(await observeWebBeforeDeadline(completionDeadline, () => observe(workspace.id))), before, 'Late answer revived work'); await new Promise(done => setTimeout(done, 1000)); }
          requireWebDeadline(completionDeadline);
          trial.fault.lateObservationFinishedAt = new Date().toISOString();
        }
        const paths = ['/api/internal/autonomy/drain', '/api/internal/result-reviews/drain', '/api/internal/mission-reports/drain'];
        trial.scheduler = (await readFile(resolve(root, 'scheduled-http.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
          .filter(row => row.timestamp >= trial.acceptedAt && row.timestamp <= trial.closedAt && paths.includes(row.path));
        for (const path of paths) assert.ok(trial.scheduler.some(row => row.path === path && row.method === 'POST' && row.status === 200), `Missing actual scheduler receipt: ${path}`);
        requireWebDeadline(completionDeadline);
        trial.status = 'automated_subset_passed';
        try {
          await persist();
          requireWebDeadline(completionDeadline);
        } catch (error) { trial.status = 'failed'; throw error; }
      } catch (error) { trial.status = 'failed'; trial.error = redact(error?.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : `${error.name}: ${error.code || 'Private acceptance failure'}`).slice(0, 600); }
      trial.finishedAt = new Date().toISOString(); await persist();
      console.log(JSON.stringify({ taskId, variant, repetition: trial.repetition, status: trial.status, artifact: output }));
      if (trial.status === 'failed') break; // Preserve failed histories; no rescue or implicit cleanup.
    }
    artifact.finishedAt = new Date().toISOString(); artifact.automatedSubsetPassed = artifact.trials.every(row => row.status === 'automated_subset_passed');
    artifact.result = artifact.automatedSubsetPassed ? 'external_review_required' : 'failed'; await persist();
    process.exitCode = artifact.automatedSubsetPassed ? 0 : 1;
  } finally { await sql?.end(); }
}
