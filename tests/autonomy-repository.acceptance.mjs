// No runtime lifecycle, internal dispatch/drain, rescue message or root .env.
// --validate is filesystem-only. --audit is guarded read-only SQL/process
// observation. Only --execute submits natural user messages to real models.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import postgres from 'postgres';
import { Client } from 'eve/client';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { readIsolationFixture, isolatedProcessEnvironment, assertIsolatedRoundTrip } from './helpers/autonomy-isolation.mjs';
import { verifyIsolatedAppArtifacts } from './helpers/start-isolated-app.mjs';
import { utcObservationTypes } from './helpers/utc-postgres-observation.mjs';
import { repoHash, repoPrompt, validateRepoManifest, assertSavedConsent, freezeRepoModelPacing } from './helpers/repo-benchmark-contract.mjs';
import { observeRepoWorker, observeRepoResources } from './helpers/repo-worker-integrity.mjs';
import { runTransportPlan } from './helpers/repo-transport.mjs';
import { observeRepoMission, observeRepoPreparation } from './helpers/repo-acceptance-observer.mjs';
import { auditRepoCompletion } from './helpers/repo-benchmark-audit.mjs';
import { auditTrace } from './helpers/autonomy-web-audit.mjs';

const option = (key, fallback) => process.argv.find(x => x.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const modes = ['validate', 'audit', 'execute'].filter(x => process.argv.includes('--' + x));
assert.equal(modes.length, 1, 'Choose exactly one of --validate, --audit, --execute');
const mode = modes[0], scenario = option('scenario', 'REPO-10'), variant = option('variant', 'normal');
const repetitions = Number(option('repetitions', '3')), continueOnFailure = process.argv.includes('--continue-on-failure');
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 3);
assert.equal(variant, 'normal', 'Fault variants remain unimplemented; no fault trial/model request was started');
const manifestPath = resolve(option('manifest', ''));
assert.ok(manifestPath.startsWith(resolve('.data/autonomy-isolation/repo-fixtures') + sep), 'Use an explicitly frozen manifest inside isolated repo-fixtures');
const manifestBytes = await readFile(manifestPath), manifest = validateRepoManifest(JSON.parse(manifestBytes), { runnable: mode === 'execute', scenario });
const oracleBytes = await readFile('tests/fixtures/repo-benchmark/oracle.json'); assert.equal(repoHash(oracleBytes), manifest.oracleSha256);
const oracle = JSON.parse(oracleBytes).scenarios[scenario], selectedRepo = manifest.repositories.find(r => r.scenario === scenario);
const prompt = repoPrompt(scenario, selectedRepo);
if (mode === 'validate') {
  console.log(JSON.stringify({ validation: 'passed', scenario, manifestSha256: repoHash(manifestBytes), commit: selectedRepo.commit, transport: manifest.transport.kind,
    transportDeclaredBound: manifest.transport.kind !== 'unbound', gate: false, modelCalls: 0, runtimeCalls: 0,
    limitation: 'Manifest shape and oracle hash only; does not attest actual transport, consent, process identity or application behavior.' }));
} else await main();

async function main() {
  const fixture = await readIsolationFixture(); isolatedProcessEnvironment(fixture, { sharedOtto: true });
  assert.equal(fixture.app.origin, 'http://127.0.0.1:58000'); assert.equal(fixture.runner.url, 'http://127.0.0.1:58091');
  const root = resolve('.data/autonomy-isolation', `application-${fixture.runtimeScope.split(':')[1]}`);
  assert.equal(resolve(fixture.app.root), root); assert.equal(resolve(fixture.app.runtimePath), resolve(root, 'runtime.json'));
  assert.equal(resolve(fixture.app.sourceManifestPath), resolve(root, 'source-manifest.json'));
  const sql = postgres(fixture.databaseUrl, { prepare: false, max: 2, types: utcObservationTypes, connection: { TimeZone: 'UTC', default_transaction_read_only: 'on' } });
  const json = async path => JSON.parse(await readFile(path, 'utf8'));
  const runId = randomUUID(), output = resolve('.data/autonomy-isolation', `repository-acceptance-${runId}.json`);
  const protocol = { version: 1, kind: 'repository-acceptance', scenario, variant, repetitions, continueOnFailure, runtime: fixture.runtimeScope, sourceHash: fixture.app.sourceSha256,
    model: 'glm-5.3-flash', reasoning: 'low', prompt, observationSeconds: 1800, schedulerIntervalSeconds: 60, controllerLeaseSeconds: 90, reportLeaseSeconds: 240,
    timestampObservation: 'utc-oid1114-v1', startedAt: new Date().toISOString(), attempts: [], automatedGate: false, gate: false, gateEligible: repetitions === 3,
    gateScope: 'One normal repo variant only; required fault variants and other missions are separate, not implied by more repetitions.',
    reportProseReview: { status: 'pending', limitation: 'Deterministic source/trace/outcome/citation checks do not certify arbitrary report prose.' },
    fixture: { kind: manifest.transport.kind, repository: { url: selectedRepo.url, commit: selectedRepo.commit, tree: selectedRepo.tree }, manifestSha256: repoHash(manifestBytes), oracleSha256: repoHash(oracleBytes), oracleNotInPrompt: true, oracleNotServed: true },
    usageScope: 'Measured mission attempts exclude initiating V conversation and separate consent preparation. End-to-end token/cost totals remain unknown.', limitations: [] };
  const secrets = new Set([fixture.databaseUrl, fixture.internalApiSecret, fixture.auth.anonKey, fixture.auth.serviceRoleKey, fixture.browser.key, fixture.runner.key].filter(Boolean));
  const syntheticValues = new Set();
  const assertNoSyntheticLeak = bytes => { for (const value of syntheticValues) assert.ok(!Buffer.from(bytes).includes(Buffer.from(value)), 'A synthetic Vault value leaked into saved model/report/browser material'); };
  const redact = value => { let text = String(value); for (const secret of secrets) text = text.split(secret).join('[REDACTED]'); return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED JWT]'); };
  const persist = () => writeFile(output, redact(JSON.stringify(protocol, null, 2)));
  let cookie, otherCookie, frozen;
  const origin = fixture.app.origin;
  const get = (path, access = cookie) => fetch(origin + path, { headers: access ? { cookie: access } : {}, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const post = async (path, body) => { const response = await fetch(origin + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000) }); assert.ok(response.ok, `Ordinary API status ${response.status}`); return response.json(); };
  async function login(account) {
    secrets.add(account.password); const cookies = new Map();
    const client = createServerClient(fixture.auth.url, fixture.auth.anonKey, { cookieOptions: { name: 'pat_supabase_auth', path: '/', sameSite: 'lax' }, cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: entries => entries.forEach(c => cookies.set(c.name, c.value)) } });
    const result = await client.auth.signInWithPassword({ email: account.email, password: account.password });
    assert.equal(result.error, null); assert.equal(result.data.user.id, account.userId); assert.equal(result.data.user.role, 'authenticated');
    secrets.add(result.data.session.access_token); secrets.add(result.data.session.refresh_token);
    const value = [...cookies].map(([name, entry]) => `${name}=${entry}`).join('; '); secrets.add(value); return value;
  }
  async function freeze() {
    const verified = await verifyIsolatedAppArtifacts(fixture, { requireRuntime: true });
    assert.equal(verified.sourceSha256, protocol.sourceHash);
    const modelRequestIntervalMs = freezeRepoModelPacing(protocol, verified.runtime);
    const worker = await observeRepoWorker(fixture);
    const state = { sourceSha256: verified.sourceSha256, dependencySha256: verified.dependencySha256, services: verified.services, workflowStore: verified.workflowStore, modelRequestIntervalMs, worker };
    if (mode === 'execute') {
      assert.equal(manifest.runtime, fixture.runtimeScope); assert.equal(repoHash(JSON.stringify(worker)), manifest.workerReceiptSha256);
      const transportBytes = await readFile(resolve(dirname(manifestPath), 'transport.json')); assert.equal(repoHash(transportBytes), manifest.transport.receiptSha256);
      const transport = JSON.parse(transportBytes); assert.equal(transport.runtime, fixture.runtimeScope); assert.equal(transport.kind, manifest.transport.kind);
      assert.equal(transport.workerReceiptSha256, manifest.workerReceiptSha256);
      assert.deepEqual(transport.repositories, manifest.repositories.map(({ url, commit, tree }) => ({ url, commit, tree })));
      assert.equal(transport.oracleServed, false); assert.equal(transport.verifiedFetch, true);
      if (transport.kind === 'simulated-github-transport') {
        assert.match(transport.planPath, /^transport-[a-f0-9-]{36}\/plan\.json$/);
        const planPath = resolve(dirname(manifestPath), transport.planPath);
        assert.equal(repoHash(await readFile(resolve(dirname(planPath), 'fetch-receipt.json'))), transport.fetchReceiptSha256);
        state.transport = await runTransportPlan('verify', planPath);
        assert.deepEqual(state.transport, transport.verifiedTransport);
        assert.equal(state.transport.executionImage, worker.executionImage);
      }
    }
    if (frozen) assert.deepEqual(state, frozen, 'Frozen app/worker/process/dependency/image/transport identity changed'); else frozen = state;
    protocol.buildIntegrity = state;
    return worker;
  }
  async function denial(path) {
    const statuses = [];
    for (const access of [null, otherCookie]) { const response = await get(path, access); await response.body?.cancel(); assert.ok([401, 403, 404].includes(response.status), 'Private artifact leaked'); statuses.push(response.status); }
    return statuses;
  }
  async function evidence(state, workspaceId) {
    const traces = [], byteEvidence = new Set(), receipts = []; let total = 0;
    for (const capture of state.captures.filter(c => c.item_id && !c.deleted_at && ['browser-action', 'test-capture'].includes(c.provenance?.producer))) {
      assert.ok(capture.content.size > 0 && capture.content.size <= 4 * 1024 * 1024 && total + capture.content.size <= 64 * 1024 * 1024);
      const path = `/api/workspaces/${workspaceId}/items/${capture.item_id}/file`, response = await get(path); assert.equal(response.status, 200);
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try { while (true) { const piece = await reader.read(); if (piece.done) break; size += piece.value.length; assert.ok(size <= capture.content.size); chunks.push(piece.value); } } finally { await reader.cancel().catch(() => {}); }
      const bytes = Buffer.concat(chunks); total += size; assert.equal(size, capture.content.size); assert.equal(repoHash(bytes), capture.provenance.sha256);
      if (capture.provenance.producer === 'browser-action') assertNoSyntheticLeak(bytes);
      assert.equal(capture.provenance.origin, 'tool'); assert.equal(capture.provenance.sourceType, 'test'); assert.equal(capture.provenance.sourceId, capture.run_id);
      if (capture.provenance.producer === 'browser-action') traces.push(auditTrace(capture, bytes, state)); else assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      byteEvidence.add(capture.item_id); receipts.push({ itemId: capture.item_id, sha256: repoHash(bytes), bytes: size, denialStatuses: await denial(path) });
    }
    return { traces, byteEvidence, receipts, bytes: total };
  }
  try {
    assert.equal((await sql`show transaction_read_only`)[0].transaction_read_only, 'on');
    const worker = await freeze();
    if (mode === 'audit') {
      await observeRepoMission(sql, `schema-audit-${runId}`, fixture.runtimeScope, new Date().toISOString());
      console.log(JSON.stringify({ audit: 'passed', modelCalls: 0, authenticatedRequests: 0, workerReceiptSha256: repoHash(JSON.stringify(worker)), gate: false })); return;
    }
    protocol.harnessSha256 = repoHash(await readFile('tests/autonomy-repository.acceptance.mjs'));
    protocol.oracleAuditSha256 = repoHash(await readFile('tests/helpers/repo-benchmark-audit.mjs'));
    protocol.timestampParserSha256 = repoHash(await readFile('tests/helpers/utc-postgres-observation.mjs'));
    protocol.helperHashes = Object.fromEntries(await Promise.all(['repo-benchmark-contract.mjs', 'repo-worker-integrity.mjs', 'repo-acceptance-observer.mjs', 'repo-transport.mjs', 'repo-transport-linux.mjs', 'autonomy-web-audit.mjs'].map(async name => [name, repoHash(await readFile('tests/helpers/' + name))])));
    const account = await json('.data/autonomy-isolation/ordinary-user.json'); cookie = await login(account);
    const comparison = { email: `repo-denial-${runId}@example.test`, password: randomUUID() + randomUUID() };
    const admin = createClient(fixture.auth.url, fixture.auth.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const created = await admin.auth.admin.createUser({ ...comparison, email_confirm: true }); assert.equal(created.error, null);
    otherCookie = await login({ ...comparison, userId: created.data.user.id });
    const healthResponse = await fetch(fixture.runner.url + '/health', { headers: { authorization: `Bearer ${fixture.runner.key}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    assert.equal(healthResponse.status, 200); const health = await healthResponse.json(); assert.equal(health.autonomousExecution?.admission, true); assert.equal(health.autonomousExecution?.frozenCommit, true);
    if (oracle.requiresBrowser) { assert.equal(health.autonomousExecution.codexTurnAdmission, true); assert.equal(health.autonomousExecution.environmentExecution, 1); }
    if (oracle.requiresConfiguration) assert.equal(health.autonomousExecution.vaultPull, true);
    protocol.workerHealth = health; await persist();
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      const trial = { repetition, startedAt: new Date().toISOString(), snapshots: [] }; protocol.attempts.push(trial); await persist();
      try {
        await freeze(); let workspace, savedConsent = null;
        trial.resourcesBefore = await observeRepoResources(fixture);
        if (scenario === 'REPO-12') {
          const prepared = manifest.prepared[repetition - 1]; assert.equal(prepared.userId, account.userId);
          const previous = await observeRepoPreparation(sql, prepared.workspaceId, fixture.runtimeScope);
          assert.equal(previous.activeMissions.length + previous.claims.length, 0, 'Preparation has not physically settled');
          savedConsent = assertSavedConsent(previous, prepared, { runtime: fixture.runtimeScope, repo: selectedRepo, names: oracle.requiredNames, now: Date.now() + protocol.observationSeconds * 1000 });
          const secretsFile = await json(resolve(dirname(manifestPath), 'values.private.json'));
          assert.deepEqual(Object.keys(secretsFile[prepared.workspaceId]).sort(), [...oracle.requiredNames].sort());
          for (const value of Object.values(secretsFile[prepared.workspaceId])) { assert.ok(typeof value === 'string' && value.length >= 16); secrets.add(value); syntheticValues.add(value); }
          trial.excludedPreparation = { setupJobId: prepared.setupJobId, consent: savedConsent, scope: 'Pre-existing ordinary API preparation, excluded from timed QA and tokens' };
          workspace = { id: prepared.workspaceId };
        } else workspace = (await post('/api/workspaces', { name: `Repository QA ${scenario} ${runId.slice(0, 8)}-${repetition}` })).workspace;
        const thread = (await post('/api/threads', { workspaceId: workspace.id, title: 'Testa ett projekt' })).thread;
        Object.assign(trial, { workspaceId: workspace.id, threadId: thread.id });
        assertIsolatedRoundTrip({ workspaceId: workspace.id, threadId: thread.id, userId: account.userId }, {
          workspaces: [...await sql`select id,user_id from pat_workspaces where id=${workspace.id}`], threads: [...await sql`select id,workspace_id,user_id from pat_threads where id=${thread.id}`],
        });
        trial.databaseRoundTripAt = new Date().toISOString(); trial.measuredFrom = new Date().toISOString();
        const client = new Client({ host: origin, redirect: 'error', headers: { cookie, 'x-pat-browser-thread': thread.id, 'x-pat-message-id': randomUUID(), 'x-pat-chat-model': protocol.model, 'x-pat-reasoning': protocol.reasoning } });
        const accepted = await client.sessions.create({ message: prompt }); trial.sessionId = accepted.session.state.sessionId; trial.acceptedAt = new Date().toISOString(); await persist();
        // Deliberately disconnected: no subscription, no user follow-up, no drain.
        const deadline = Date.now() + protocol.observationSeconds * 1000; let last;
        while (Date.now() < deadline) {
          const state = await observeRepoMission(sql, workspace.id, fixture.runtimeScope, trial.measuredFrom);
          if (JSON.stringify(state) !== JSON.stringify(last)) { last = state; trial.snapshots.push({ at: new Date().toISOString(), ...state }); await persist(); }
          assertNoSyntheticLeak(JSON.stringify(state));
          if (state.missions.length && state.missions.every(m => m.lifecycle === 'closed') && state.claims.length === 0) { trial.closedAt = new Date().toISOString(); break; }
          await new Promise(done => setTimeout(done, 1000));
        }
        assert.ok(trial.closedAt, 'No bounded closed/cleaned completion before the frozen observation deadline');
        const state = trial.snapshots.at(-1); await freeze();
        trial.resourcesAfter = await observeRepoResources(fixture);
        const ownedNames = new Set([...state.repositories.map(r => `qa-repo-${r.job.id}`), ...state.setups.flatMap(s => [`qa-sandbox-${s.autonomy.resourceId}`, `qa-preview-${s.autonomy.resourceId}`])]);
        assert.ok(trial.resourcesAfter.every(resource => !ownedNames.has(resource.name)), 'An owned executor/preview container still exists after claimed cleanup');
        const reads = await evidence(state, workspace.id); trial.evidenceReads = reads.receipts; trial.evidenceBytes = reads.bytes;
        const outcome = auditRepoCompletion(state, { runtime: fixture.runtimeScope, repo: { ...selectedRepo, executionImage: worker.executionImage }, oracle, savedConsent, ...reads });
        trial.oracleMatches = outcome.matched; trial.limitations = outcome.limitations;
        const path = `/api/workspaces/${workspace.id}/reports/${outcome.report.id}`, response = await get(path); assert.equal(response.status, 200);
        const reopened = await response.json(); assert.deepEqual(reopened.document, outcome.report.document); assert.equal(reopened.stale, false); assert.equal(reopened.itemId, outcome.report.item_id);
        assertNoSyntheticLeak(JSON.stringify(reopened));
        trial.reportDenialStatuses = await denial(path); trial.reopenedAt = new Date().toISOString();
        const logs = (await readFile(resolve(root, 'scheduled-http.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        trial.scheduler = logs.filter(e => e.timestamp >= trial.acceptedAt && e.timestamp <= trial.closedAt && ['/api/internal/autonomy/drain', '/api/internal/result-reviews/drain', '/api/internal/mission-reports/drain'].includes(e.path));
        const required = ['/api/internal/autonomy/drain', '/api/internal/mission-reports/drain', ...(oracle.requiresBrowser ? ['/api/internal/result-reviews/drain'] : [])];
        for (const path of required) assert.ok(trial.scheduler.some(e => e.path === path && e.method === 'POST' && e.status === 200), 'Scheduler receipt missing: ' + path);
        trial.result = 'passed';
      } catch (error) { trial.result = 'failed'; trial.error = redact(error?.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : `${error.name}: ${error.code ?? 'Acceptance operation failed; inspect private logs'}`).slice(0, 600); }
      trial.finishedAt = new Date().toISOString(); await persist();
      console.log(JSON.stringify({ runId, scenario, variant, repetition, result: trial.result, error: trial.error, artifact: output }));
      if (trial.result === 'failed' && !continueOnFailure) { protocol.notStarted = { repetitions: repetitions - repetition, reason: 'First failed trial is preserved; no rescue or later submission.' }; break; }
    }
    protocol.finishedAt = new Date().toISOString(); protocol.result = protocol.attempts.length === repetitions && protocol.attempts.every(t => t.result === 'passed') ? 'passed' : 'failed';
    protocol.automatedGate = protocol.gateEligible && protocol.result === 'passed'; await persist(); process.exitCode = protocol.result === 'passed' ? 0 : 1;
  } finally { await sql.end(); }
}
