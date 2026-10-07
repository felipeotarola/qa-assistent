// Opt-in evidence benchmark. Never starts services, patches DB, calls drains,
// replays workflow turns or imports .env. --validate is pure; --audit is SQL
// read-only; --execute alone may submit real natural model requests.
import assert from 'node:assert/strict';
import { requireWebDeadline, observeWebBeforeDeadline } from './helpers/autonomy-web-restart.mjs';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import postgres from 'postgres';
import { Client } from 'eve/client';
import { createServerClient } from '@supabase/ssr';
import { assertIsolatedRoundTrip, isolatedProcessEnvironment, readIsolationFixture } from './helpers/autonomy-isolation.mjs';
import { verifyIsolatedAppArtifacts } from './helpers/start-isolated-app.mjs';
import { utcObservationTypes } from './helpers/utc-postgres-observation.mjs';
import { observeEvidence } from './helpers/evidence-observer.mjs';
import { validateGoldenArtifact, GOLDEN_LABEL } from './helpers/evidence-golden.mjs';
import { REVIEWER_VERSION } from '../shared/result-assessment.ts';
import { validateEvidenceManifest, evidencePrompt, evidenceSeed, validateEvidenceSeed, fingerprint, sha256, auditEvidenceCompletion, auditEvidenceHistory, evidenceMetrics } from './helpers/evidence-acceptance.mjs';
import { PRESERVED_IRIS_PROTOCOL, auditPreservedIris, auditPreservedTraceBytes, requirePreservedTraceCoverage } from './helpers/evidence-preserved-iris.mjs';
import { REPORT_FAULT_PROTOCOLS, validateReportFaultManifest } from './helpers/report-fault-contract.mjs';
import { reportFaultAcceptance } from './helpers/report-fault-acceptance.mjs';

const modes = ['--validate', '--audit', '--execute'].filter(flag => process.argv.includes(flag));
assert.equal(modes.length, 1, 'Choose exactly one of --validate, --audit, --execute');
const mode = modes[0], manifestPath = process.argv.find(value => value.startsWith('--manifest='))?.slice(11);
assert.ok(manifestPath, 'An explicit prelocked --manifest=path is required');
const manifestBytes = await readFile(manifestPath), rawManifest = JSON.parse(manifestBytes);
const isReportFault = REPORT_FAULT_PROTOCOLS.includes(rawManifest.protocol);
const manifest = (isReportFault ? validateReportFaultManifest : validateEvidenceManifest)(rawManifest, { execute: mode === '--execute' });
const faultAdapter = isReportFault && mode !== '--validate' ? await reportFaultAcceptance(manifest, mode) : null;
const preservedIris = manifest.protocol === PRESERVED_IRIS_PROTOCOL;
const root = resolve('.data/autonomy-isolation');
async function privateFile(path) {
  const candidate = resolve(path), actual = await realpath(candidate), sub = relative(root, actual);
  assert.ok(sub && sub !== '..' && !sub.startsWith(`..${sep}`) && !isAbsolute(sub) && candidate === actual, 'Only regular files under the owned isolation directory may be read');
  assert.ok((await stat(actual)).size <= 128 * 1024 * 1024, 'Input artifact exceeds bounded read size');
  return readFile(actual);
}
const jsonPrivate = async path => JSON.parse(await privateFile(path));
const protocol = { protocol: manifest.protocol, catalogVersion: manifest.catalogVersion, taskId: manifest.taskId, variant: manifest.variant,
  sourceHash: manifest.sourceHash, runtime: manifest.runtime, manifestSha256: sha256(manifestBytes), mode,
  model: manifest.model, reasoning: manifest.reasoning, observationSeconds: manifest.observationSeconds,
  schedulerIntervalSeconds: 60, controllerLeaseSeconds: 90, reportLeaseSeconds: 240,
  timestampObservation: 'utc-oid1114-v1', repetitions: manifest.trials.length, startedAt: new Date().toISOString(),
  inputPreparation: manifest.taskId === 'GAP-13' && manifest.variant !== 'report-only' ? 'natural-first-run' : manifest.preparation === 'synthetic-golden'
    ? 'synthetic-golden; actual persisted files/runs and deterministic preparation review; zero previous browser/provider execution'
    : 'preserved-version-locked-evidence; not a natural first QA execution',
  reportProseReview: { status: 'pending', limitation: 'Semantic prose, version-B adequacy, login-vs-homepage and search meaning are independent review obligations.' },
  automatedGate: false, gate: false, attempts: manifest.trials.map((trial, i) => ({ repetition: i + 1, workspaceId: trial.workspaceId, result: 'not_started',
    prompt: evidencePrompt(manifest, trial), promptSha256: evidencePrompt(manifest, trial) ? sha256(evidencePrompt(manifest, trial)) : null })) };
for (const [key, path] of Object.entries({ harnessSha256: 'tests/autonomy-evidence.acceptance.mjs', oracleSha256: 'tests/helpers/evidence-acceptance.mjs', goldenValidatorSha256: 'tests/helpers/evidence-golden.mjs',
  observerSha256: 'tests/helpers/evidence-observer.mjs', observationDeadlineSha256: 'tests/helpers/autonomy-web-restart.mjs', timestampParserSha256: 'tests/helpers/utc-postgres-observation.mjs' })) protocol[key] = sha256(await readFile(path));
if (preservedIris) {
  protocol.preservedIrisHelperSha256 = sha256(await readFile('tests/helpers/evidence-preserved-iris.mjs'));
  protocol.irisLedgerParserSha256 = sha256(await readFile('shared/browser-job.ts'));
  protocol.providerMeterParserSha256 = sha256(await readFile('shared/provider-usage.ts'));
  protocol.historicalReviewerVersion = REVIEWER_VERSION;
  protocol.historicalReviewerPolicySha256 = sha256(await readFile('shared/result-assessment.ts'));
}
if (mode === '--validate') {
  console.log(JSON.stringify({ ...protocol, result: 'manifest_validated', modelCalls: 0, networkRequests: 0 }, null, 2));
} else {
  const fixture = await readIsolationFixture(); isolatedProcessEnvironment(fixture);
  assert.equal(fixture.runtimeScope, manifest.runtime); assert.equal(fixture.app?.sourceSha256, manifest.sourceHash);
  const origin = fixture.app.origin; assert.equal(origin, 'http://127.0.0.1:58000');
  const appRoot = resolve(root, `application-${fixture.runtimeScope.split(':')[1]}`); assert.equal(resolve(fixture.app.root), appRoot);
  const secrets = new Set([fixture.internalApiSecret, fixture.auth.anonKey, fixture.auth.serviceRoleKey, fixture.browser.key, fixture.databaseUrl].filter(Boolean));
  const redact = value => {
    let text = String(value); for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED JWT]');
  };
  const output = resolve(root, `evidence-acceptance-${randomUUID()}.json`);
  const persist = () => writeFile(output, redact(JSON.stringify(protocol, null, 2)));
  const sql = postgres(fixture.databaseUrl, { prepare: false, max: 2, types: utcObservationTypes, connection: { TimeZone: 'UTC', default_transaction_read_only: 'on' } });
  async function freeze() {
    assert.equal(sha256(await readFile('tests/helpers/autonomy-web-restart.mjs')), protocol.observationDeadlineSha256, 'Observation deadline helper changed');
    const result = await verifyIsolatedAppArtifacts(fixture, { requireRuntime: true }); assert.equal(result.sourceSha256, manifest.sourceHash);
    const identity = { sourceSha256: result.sourceSha256, dependencySha256: result.dependencySha256, services: result.services, workflowStore: result.workflowStore,
      modelRequestIntervalMs: result.runtime.modelRequestIntervalMs ?? 0, observationDeadlineSha256: protocol.observationDeadlineSha256, evidenceGapFixture: result.runtime.evidenceGapFixture ?? null };
    if (faultAdapter) identity.reportFault = await faultAdapter.freeze(result.runtime);
    if (manifest.taskId === 'GAP-13' && ['resolvable', 'persistent'].includes(manifest.variant)) assert.ok(identity.evidenceGapFixture, 'GAP requires the frozen deployed fixture identity');
    if (preservedIris) {
      assert.equal(sha256(await readFile('tests/helpers/evidence-preserved-iris.mjs')), protocol.preservedIrisHelperSha256);
      assert.equal(sha256(await readFile('shared/browser-job.ts')), protocol.irisLedgerParserSha256);
      for (const service of ['web', 'eve']) assert.equal(sha256(await readFile(resolve(appRoot, service, 'shared/browser-job.ts'))), protocol.irisLedgerParserSha256, 'Historical ledger parser differs from frozen app');
      assert.equal(sha256(await readFile('shared/provider-usage.ts')), protocol.providerMeterParserSha256);
      for (const service of ['web', 'eve']) assert.equal(sha256(await readFile(resolve(appRoot, service, 'shared/provider-usage.ts'))), protocol.providerMeterParserSha256, 'Historical meter parser differs from frozen app');
      identity.irisLedgerParserSha256 = protocol.irisLedgerParserSha256;
      identity.providerMeterParserSha256 = protocol.providerMeterParserSha256;
      assert.equal(sha256(await readFile('shared/result-assessment.ts')), protocol.historicalReviewerPolicySha256);
      for (const service of ['web', 'eve']) assert.equal(sha256(await readFile(resolve(appRoot, service, 'shared/result-assessment.ts'))), protocol.historicalReviewerPolicySha256, 'Historical reviewer comparison differs from frozen app');
      identity.historicalReviewerPolicySha256 = protocol.historicalReviewerPolicySha256;
    }
    protocol.buildIntegrity ??= identity; assert.deepEqual(identity, protocol.buildIntegrity); return result.runtime;
  }
  async function login(account) {
    secrets.add(account.password); const cookies = new Map();
    const auth = createServerClient(fixture.auth.url, fixture.auth.anonKey, { cookieOptions: { name: 'pat_supabase_auth', path: '/', sameSite: 'lax' },
      cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(c => cookies.set(c.name, c.value)) } });
    const result = await auth.auth.signInWithPassword({ email: account.email, password: account.password });
    assert.equal(result.error, null, 'Ordinary account sign-in failed');
    assert.equal(result.data.user.id, account.userId, 'Signed-in owner differs from locked account');
    assert.equal(result.data.user.role, 'authenticated', 'Signed-in account is not an ordinary authenticated role');
    secrets.add(result.data.session.access_token); secrets.add(result.data.session.refresh_token);
    const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; '); secrets.add(cookie); return cookie;
  }
  async function request(path, cookie, body) {
    assert.ok(path.startsWith('/api/workspaces/') || path === '/api/threads');
    return fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30000) });
  }
  async function evidenceBytes(state, seed, cookie, workspaceId, historicalProof) {
    const receipts = [], traces = []; let total = 0;
    for (const capture of seed.captures.filter(c => c.item_id && !c.deleted_at && c.provenance?.sha256)) {
      const size = capture.content?.size; assert.ok(Number.isSafeInteger(size) && size >= 1 && size <= 4 * 1024 * 1024 && total + size <= 64 * 1024 * 1024);
      const response = await request(`/api/workspaces/${workspaceId}/items/${capture.item_id}/file`, cookie);
      assert.equal(response.status, 200, `Original evidence file ${capture.item_id} returned HTTP ${response.status}; expected 200`);
      const reader = response.body.getReader(), chunks = []; let count = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; count += part.value.length; assert.ok(count <= size); chunks.push(part.value); } }
      finally { await reader.cancel().catch(() => {}); }
      const bytes = Buffer.concat(chunks); assert.equal(bytes.length, size, 'Original evidence byte size changed');
      assert.equal(sha256(bytes), capture.provenance.sha256, 'Original evidence SHA-256 changed'); total += size;
      if (manifest.preparation === 'synthetic-golden') assert.ok(bytes.toString('utf8').includes(GOLDEN_LABEL), 'Golden bytes must be visibly synthetic, not silent fabricated browser evidence');
      else if (preservedIris) {
        if (capture.provenance.producer === 'browser-action') traces.push(auditPreservedTraceBytes(bytes, capture, seed, historicalProof));
      } else {
        const run = state.runs.find(r => r.id === capture.run_id), attempt = state.attempts.find(a => a.id === run.mission_attempt_id);
        assert.ok(attempt?.kind === 'browser_tests' && state.jobs.some(job => job.id === attempt.executor_resource_id && job.session_id), 'Original physical browser session receipt missing');
        assert.ok(attempt.usage?.provider?.providerCalls > 0, 'Original browser work lacks physical model-call receipts');
      }
      receipts.push({ itemId: capture.item_id, sha256: sha256(bytes), bytes: size, preparation: manifest.preparation ?? 'preserved-actual' });
    }
    if (preservedIris) requirePreservedTraceCoverage(seed, traces);
    return receipts;
  }
  try {
    assert.equal((await sql`show transaction_read_only`)[0].transaction_read_only, 'on');
    for (const [index, trial] of manifest.trials.entries()) {
      const attempt = protocol.attempts[index]; attempt.startedAt = new Date().toISOString();
      let deadline = null;
      try {
        attempt.stage = 'input_metadata';
        const account = await jsonPrivate(trial.accountFile); secrets.add(account.password);
        assert.equal((await sql`select user_id from pat_workspaces where id=${trial.workspaceId}`)[0]?.user_id, account.userId, 'Input workspace owner mismatch');
        const before = await observeEvidence(sql, trial.workspaceId, fixture.runtimeScope, { preservedIris }); attempt.baseline = before;
        assert.ok(before.missions.every(m => m.lifecycle === 'closed') && before.claims.length === 0, 'Initial saved-evidence workspace has ongoing work');
        const seed = evidenceSeed(before, trial.selection), seedHash = fingerprint(seed); attempt.observedSeedHash = seedHash;
        if (trial.seedHash) assert.equal(seedHash, trial.seedHash, 'Frozen input changed before request');
        if (faultAdapter) faultAdapter.validateSeed(seed, trial);
        else if (manifest.taskId !== 'SEC-08') validateEvidenceSeed(manifest.taskId, manifest.variant, seed, fixture.runtimeScope, manifest.preparation);
        if (manifest.variant === 'historical-review-gap') assert.ok(before.reviews.some(r => seed.runs.some(run => run.id === r.run_id)
          && r.status === 'completed' && r.reviewer_version !== REVIEWER_VERSION && r.assessment?.verdict === 'needs_evidence'), 'Declared historical-gap variant requires an actual old incomplete review');
        if (preservedIris) {
          attempt.originalExecution = auditPreservedIris(before, seed, { workspaceId: trial.workspaceId, runtime: fixture.runtimeScope, userId: account.userId, reviewerVersion: REVIEWER_VERSION });
          attempt.observedOriginalExecutionHash = fingerprint(attempt.originalExecution);
          if (trial.originalExecutionHash) assert.equal(attempt.observedOriginalExecutionHash, trial.originalExecutionHash, 'Frozen original execution or historical review changed before request');
        }
        attempt.originArtifacts = []; const originatingRuns = new Set();
        for (const artifact of trial.originArtifacts) {
          const bytes = await privateFile(artifact.path); assert.equal(sha256(bytes), artifact.sha256);
          const saved = JSON.parse(bytes);
          if (manifest.preparation === 'synthetic-golden') {
            assert.equal(manifest.reviewerVersion, REVIEWER_VERSION, 'Golden reviews are old: prepare a new declared fixture, never silently upgrade history');
            attempt.goldenPreparation = (faultAdapter?.validatePreparation ?? validateGoldenArtifact)(saved, { taskId: manifest.taskId, runtime: fixture.runtimeScope, workspaceId: trial.workspaceId, seed, reviews: before.reviews, reviewerVersion: REVIEWER_VERSION });
            for (const run of seed.runs) originatingRuns.add(run.id);
          } else {
            assert.ok(!saved.isolationFailure && saved.runtime === fixture.runtimeScope && saved.attempts?.some(a => a.workspaceId === trial.workspaceId), 'Origin does not document this isolated workspace');
            for (const run of seed.runs) if (saved.attempts.some(a => a.workspaceId === trial.workspaceId && a.snapshots?.some(s => s.runs?.some(r => r.id === run.id && fingerprint(r.result) === fingerprint(run.result))))) originatingRuns.add(run.id);
          }
          attempt.originArtifacts.push({ sha256: artifact.sha256, sourceHash: saved.sourceHash ?? null, protocol: saved.protocol ?? saved.version });
        }
        if (seed.runs.length) assert.ok(seed.runs.every(run => originatingRuns.has(run.id)), 'Real original receipts require preserved originating acceptance history');
        if (mode === '--audit') { attempt.result = 'audited'; attempt.limitation = 'Read-only metadata audit; input bytes, auth, models and runtime were not exercised'; continue; }
        if (manifest.taskId === 'GAP-13' && manifest.variant !== 'report-only') {
          assert.equal(before.missions.length + before.runs.length + before.items.length, 0, 'Natural GAP trial needs an empty workspace');
          if (!manifest.fault) { attempt.result = 'not_started'; attempt.pending = 'External physical observation-fault driver and frozen fixture must be prepared before natural GAP acceptance'; continue; }
        }
        attempt.stage = 'runtime_integrity'; protocol.processes = await freeze();
        attempt.stage = 'ordinary_auth'; const cookie = await login(account);
        attempt.stage = 'original_evidence_http_read';
        attempt.evidenceReads = await evidenceBytes(before, seed, cookie, trial.workspaceId, attempt.originalExecution);
        if (manifest.taskId === 'SEC-08') {
          const other = await jsonPrivate(trial.otherAccountFile); assert.notEqual(other.userId, account.userId); const otherCookie = await login(other);
          const path = `/api/workspaces/${trial.workspaceId}/reports/${trial.security.reportId}`;
          const own = await request(path, cookie); assert.equal(own.status, 200); assert.ok((await own.text()).includes(trial.security.marker), 'Owner control marker absent');
          attempt.denials = [];
          for (const access of [undefined, otherCookie]) {
            const denied = await request(path, access), body = await denied.text(); assert.ok([401, 403, 404].includes(denied.status)); assert.ok(!body.includes(trial.security.marker));
            attempt.denials.push(denied.status);
          }
          const after = await observeEvidence(sql, trial.workspaceId, fixture.runtimeScope, { preservedIris }); assert.equal(fingerprint(after), fingerprint(before), 'Private read changed source owner state');
          attempt.result = 'passed'; attempt.proofLevel = 'actual-authenticated-owner-contract; no natural model prompt'; continue;
        }
        attempt.stage = 'create_thread';
        const response = await request('/api/threads', cookie, { workspaceId: trial.workspaceId, title: `Evidence ${manifest.taskId} ${index + 1}` }); assert.ok(response.ok, `Thread creation returned HTTP ${response.status}`);
        const { thread } = await response.json(); attempt.threadId = thread.id;
        assertIsolatedRoundTrip({ workspaceId: trial.workspaceId, threadId: thread.id, userId: account.userId }, {
          workspaces: [...await sql`select id,user_id from pat_workspaces where id=${trial.workspaceId}`], threads: [...await sql`select id,workspace_id,user_id from pat_threads where id=${thread.id}`],
        });
        if (faultAdapter) attempt.faultArm = await faultAdapter.arm(trial, thread.id, attempt.promptSha256);
        await persist(); // Save exact prompt/hash, seed and protocol before first paid request.
        const client = new Client({ host: origin, redirect: 'error', headers: { cookie, 'x-pat-browser-thread': thread.id, 'x-pat-message-id': randomUUID(), 'x-pat-chat-model': manifest.model, 'x-pat-reasoning': manifest.reasoning } });
        attempt.stage = 'natural_intake_submission';
        const submitted = await client.sessions.create({ message: attempt.prompt }); attempt.sessionId = submitted.session.state.sessionId;
        attempt.stage = 'scheduler_observation';
        attempt.acceptedAt = new Date().toISOString(); attempt.snapshots = [];
        deadline = Date.parse(attempt.acceptedAt) + manifest.observationSeconds * 1000;
        requireWebDeadline(deadline); await persist(); requireWebDeadline(deadline);
        let previous;
        while (Date.now() < deadline) {
          const state = await observeWebBeforeDeadline(deadline, () => observeEvidence(sql, trial.workspaceId, fixture.runtimeScope, { preservedIris })), hash = fingerprint(state);
          if (hash !== previous) { previous = hash; attempt.snapshots.push({ at: new Date().toISOString(), ...state }); await persist(); requireWebDeadline(deadline); }
          const missions = state.missions.filter(m => m.thread_id === thread.id);
          if (missions.length && missions.every(m => m.lifecycle === 'closed')) { attempt.closedAt = new Date().toISOString(); break; }
          await new Promise(done => setTimeout(done, 1000));
        }
        requireWebDeadline(deadline);
        assert.ok(attempt.closedAt, 'Ordinary scheduler did not close the mission before locked deadline'); await observeWebBeforeDeadline(deadline, freeze);
        const after = attempt.snapshots.at(-1); attempt.metrics = evidenceMetrics(before, after, thread.id); auditEvidenceHistory([before, ...attempt.snapshots]);
        if (faultAdapter) { const audited = await observeWebBeforeDeadline(deadline, () => faultAdapter.audit(trial, before, after, thread.id, sql)); attempt.oracle = audited.result; attempt.fault = audited.receipt; }
        else attempt.oracle = auditEvidenceCompletion(manifest, trial, before, after, thread.id);
        const report = after.reports.find(r => r.id === attempt.oracle.reportId);
        attempt.stage = 'saved_report_read';
        if (report) {
          const opened = await observeWebBeforeDeadline(deadline, () => request(`/api/workspaces/${trial.workspaceId}/reports/${report.id}`, cookie)); assert.equal(opened.status, 200, `Saved report returned HTTP ${opened.status}`);
          const body = await observeWebBeforeDeadline(deadline, () => opened.json()); if (!faultAdapter) assert.equal(body.stale, false); assert.deepEqual(body.document, report.document);
          if (faultAdapter) attempt.reportStaleAtRead = body.stale;
        } else assert.ok(faultAdapter && manifest.taskId === 'REP-06', 'A saved report is required outside the source-invalidation fault');
        const logs = (await observeWebBeforeDeadline(deadline, () => readFile(resolve(appRoot, 'scheduled-http.jsonl'), 'utf8'))).split('\n').filter(Boolean).map(JSON.parse);
        attempt.scheduler = logs.filter(log => log.timestamp >= attempt.acceptedAt && log.timestamp <= attempt.closedAt && ['/api/internal/autonomy/drain', '/api/internal/result-reviews/drain', '/api/internal/mission-reports/drain'].includes(log.path));
        for (const path of ['/api/internal/autonomy/drain', '/api/internal/mission-reports/drain']) assert.ok(attempt.scheduler.some(log => log.path === path && log.status === 200 && log.method === 'POST'), 'Ordinary scheduled continuation missing');
        if (manifest.taskId === 'GAP-13' && manifest.variant !== 'report-only') {
          // Receipt is supplied by a separately audited physical fault driver.
          // This harness never patches observations, reviews or queue state.
          const fault = await observeWebBeforeDeadline(deadline, () => jsonPrivate(manifest.fault.receiptFile)), receipt = fault.receipts?.find(r => r.workspaceId === trial.workspaceId && r.threadId === thread.id);
          assert.equal(fault.sourceHash, manifest.sourceHash); assert.equal(fault.driverSha256, manifest.fault.driverSha256); assert.equal(fault.fixtureSha256, manifest.fault.fixtureSha256);
          assert.ok(receipt?.physicalBoundary === true && receipt.noDatabaseMutation === true && receipt.restoredAt && receipt.actionId);
          assert.ok(attempt.oracle.lineage.some(row => row.originalRunId === receipt.runId)); attempt.fault = receipt;
          attempt.faultProof = 'external-receipt; independent driver review pending';
        }
        requireWebDeadline(deadline);
        attempt.result = 'passed'; attempt.proofLevel = 'natural intake and real scheduled models; original evidence separately declared';
      } catch (error) {
        if (faultAdapter && mode === '--execute') { try { attempt.fault = await faultAdapter.receipt(trial); } catch { attempt.faultReceiptUnavailable = true; } }
        attempt.result = 'failed'; attempt.error = redact(error.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : `${error.name}: ${error.code ?? 'operation failed; inspect private logs'}`).slice(0, 600);
        attempt.errorContext = { stage: attempt.stage, code: error.code ?? null,
          source: error.stack?.split('\n').find(line => /(?:evidence\.acceptance|evidence-golden|evidence-acceptance)\.mjs:\d+:\d+/.test(line))?.trim().replace(/^.*[\\/](?=[^\\/]+\.mjs:\d+:\d+)/, '') ?? null };
      } finally {
        attempt.finishedAt = new Date().toISOString();
        attempt.elapsedMs = Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt);
        attempt.acceptedToClosureMs = attempt.acceptedAt && attempt.closedAt ? Date.parse(attempt.closedAt) - Date.parse(attempt.acceptedAt) : null;
        await persist();
        if (deadline !== null && attempt.result === 'passed') {
          try { requireWebDeadline(deadline); }
          catch {
            attempt.result = 'failed'; attempt.error = 'Original acceptance observation deadline expired or unavailable';
            attempt.finishedAt = new Date().toISOString();
            attempt.elapsedMs = Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt);
            await persist();
          }
        }
      }
      // Preserve all histories. Do not cancel, amend or retry a failed mission.
      if (attempt.result === 'failed' && !process.argv.includes('--continue-on-failure')) break;
    }
    protocol.finishedAt = new Date().toISOString(); protocol.result = protocol.attempts.every(a => a.result === 'passed') ? 'passed' : mode === '--audit' && protocol.attempts.every(a => a.result === 'audited') ? 'audited' : protocol.attempts.some(a => a.result === 'failed') ? 'failed' : 'pending';
    protocol.automatedGate = protocol.result === 'passed' && manifest.trials.length >= 3 && manifest.taskId !== 'SEC-08' && !manifest.fault;
    // Semantic prose and external fault proofs can never auto-graduate here.
    await persist(); console.log(JSON.stringify({ result: protocol.result, taskId: manifest.taskId, artifact: output, automaticGate: protocol.automatedGate, gate: false }));
    process.exitCode = protocol.result === 'failed' ? 1 : 0;
  } finally { await sql.end(); }
}
