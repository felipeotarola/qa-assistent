import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepoFaultGateway, matchesRepoFault } from './helpers/repo-fault-gateway.mjs';
import { validateRepoVariant, validateRepoFaultArm, auditRepoFaultCompletion } from './helpers/repo-fault-contract.mjs';
import { validateFaultGateway, faultWorkerProbe } from './helpers/repo-fault-control.mjs';
import { REPO_WORKER_PROBE } from './helpers/repo-worker-integrity.mjs';

const runtime = 'autonomy-test:repo-fault-unit', key = 'unit-runner-'.repeat(4), internal = 'unit-internal-'.repeat(4);
function arm(variant) { return { version: 1, id: randomUUID(), workspaceId: randomUUID(), runtime, variant,
  repoUrl: 'https://github.com/syna-autonomy-fixture/' + (variant === 'runner_ack_lost' ? 'library' : variant === 'app_stops_after_ready' ? 'keyless' : 'configured'),
  armedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }; }
function input(armed) { const jobId = randomUUID(); return { id: jobId, jobId, workspaceId: armed.workspaceId, url: armed.repoUrl, mode: 'test', execution: { runtime, attemptId: randomUUID(), dispatchId: jobId }, fingerprint: 'a'.repeat(64) }; }
async function fixture(t, variant, { stopApplication = async () => ({ processGroupEmpty: true, httpReachableAfter: false }), accept = x => x, beforeReply = async () => {}, status = 200, loseReply = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'syna-repo-fault-unit-')), armed = arm(variant); await writeFile(join(directory, 'arm.json'), JSON.stringify(armed));
  const accepted = [], backend = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const value = raw ? JSON.parse(raw) : null; accepted.push({ path: req.url, value });
    await beforeReply();
    if (loseReply) { res.destroy(); return; }
    res.writeHead(status, { 'content-type': 'application/json' }); res.write(JSON.stringify(accept(value))); res.end();
  });
  await new Promise(done => backend.listen(0, '127.0.0.1', done));
  const servers = createRepoFaultGateway({ directory, runnerKey: key, internalKey: internal, backendPort: backend.address().port, appPort: backend.address().port, stopApplication });
  for (const server of Object.values(servers)) await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { for (const server of [...Object.values(servers), backend]) { server.closeAllConnections(); await new Promise(done => server.close(done)); } await rm(directory, { recursive: true }); });
  const send = async (path, value, { callback = false, auth = true } = {}) => fetch(`http://127.0.0.1:${servers[callback ? 'callbacks' : 'runner'].address().port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer ' + (callback ? internal : key) } : {}) }, body: JSON.stringify(value), signal: AbortSignal.timeout(3000),
  });
  return { directory, armed, accepted, send, servers, receipt: async () => JSON.parse(await readFile(join(directory, `receipt-${armed.id}.json`), 'utf8')) };
}

test('fault arm is exact, bounded and never activates for another execution scope', () => {
  const a = arm('runner_ack_lost'), value = input(a); assert.equal(validateRepoFaultArm(a), a); assert.equal(matchesRepoFault(a, value), true);
  for (const changed of [{ ...value, workspaceId: randomUUID() }, { ...value, url: a.repoUrl + '-extra' }, { ...value, execution: { ...value.execution, runtime: runtime + '-other' } }]) assert.equal(matchesRepoFault(a, changed), false);
  assert.equal(matchesRepoFault({ ...a, expiresAt: new Date(0).toISOString() }, value), false);
  assert.throws(() => validateRepoFaultArm({ ...a, expiresAt: new Date(Date.now() + 76 * 60000).toISOString() }));
  assert.throws(() => validateRepoVariant('REPO-10', 'app_stops_after_ready'));
});

test('fault runtime has its own exact source, callback and listener identity; direct probe stays unchanged', () => {
  const config = { version: 1, directory: '/var/lib/syna-autonomy/repo-faults/' + randomUUID(), sha256: 'a'.repeat(64), frontPort: 58091, backendPort: 58093, callbackPort: 58094, appOrigin: 'http://127.0.0.1:58000' };
  const probe = faultWorkerProbe(config); assert.equal(validateFaultGateway(config), config);
  assert.ok(probe.includes("env.AUTONOMY_APP_URL,'http://127.0.0.1:58000'")); assert.ok(probe.includes("env.REPO_APP_URL,'http://127.0.0.1:58094'"));
  assert.ok(probe.includes("env.REPO_RUNNER_PORT,'58093'")); assert.ok(probe.includes('gatewayConfig.sha256')); assert.ok(probe.includes('gateway.startTicks'));
  assert.ok(REPO_WORKER_PROBE.includes("env.REPO_RUNNER_PORT,'58091'"));
  for (const value of [{ ...config, appOrigin: 'http://other:58000' }, { ...config, directory: '/tmp/shared' }, { ...config, backendPort: 58091 }]) assert.throws(() => validateFaultGateway(value));
});

test('lost acceptance response is injected only after exact accepted job; replay is forwarded unchanged', async t => {
  const f = await fixture(t, 'runner_ack_lost'), value = input(f.armed);
  await assert.rejects(f.send('/jobs', value)); assert.equal(f.accepted.length, 1); const receipt = await f.receipt();
  assert.equal(receipt.jobId, value.id); assert.equal(receipt.attemptId, value.execution.attemptId); assert.equal(receipt.upstreamAccepted, true); assert.equal(receipt.clientReceiptDropped, true);
  assert.deepEqual(await (await f.send('/jobs', value)).json(), value); assert.equal(f.accepted.length, 2);
  assert.equal((await f.receipt()).appliedAt, receipt.appliedAt);
  for (const file of await readdir(f.directory)) { const text = await readFile(join(f.directory, file), 'utf8'); assert.ok(!text.includes(key) && !text.includes(internal)); }
});

test('wrong identity, no auth and failed reply cannot claim injected acknowledgement loss', async t => {
  const f = await fixture(t, 'runner_ack_lost', { accept: value => ({ ...value, id: randomUUID() }) }), value = input(f.armed);
  assert.equal((await f.send('/jobs', { ...value, workspaceId: randomUUID() })).status, 200);
  assert.equal((await f.send('/jobs', value, { auth: false })).status, 200);
  assert.equal((await f.send('/jobs', value)).status, 502);
  assert.deepEqual(await readdir(f.directory), ['arm.json']);
});

test('readiness callback cannot reach app before the one exact physical stop receipt', async t => {
  let stops = 0; const f = await fixture(t, 'app_stops_after_ready', { stopApplication: async () => { stops++; assert.equal(f.accepted.length, 0); return { processGroupEmpty: true, httpReachableAfter: false }; } });
  const value = { ...input(f.armed), status: 'completed', cleanup: 'retained', environment: { repoUrl: f.armed.repoUrl, probeKind: 'http' } };
  assert.equal((await f.send('/api/internal/setup-result', value, { callback: true })).status, 200); assert.equal(stops, 1); assert.equal(f.accepted.length, 1);
  assert.equal((await f.send('/codex', value)).status, 200); assert.equal(stops, 1); assert.equal((await f.receipt()).processGroupEmpty, true);
});

test('revocation barrier precedes worker submission and requires exact ordinary API acknowledgement', async t => {
  const f = await fixture(t, 'consent_revoked_before_release'), value = { ...input(f.armed), action: 'start', environmentExecution: { phase: 'apply', repoUrl: f.armed.repoUrl, consent: { id: randomUUID(), revision: 2 } } };
  const sent = f.send('/codex', value); const pendingFile = join(f.directory, `pending-${f.armed.id}.json`);
  let pending; for (let n = 0; n < 100; n++) { try { pending = JSON.parse(await readFile(pendingFile, 'utf8')); break; } catch { await new Promise(done => setTimeout(done, 5)); } }
  assert.ok(pending); assert.equal(f.accepted.length, 0);
  await writeFile(join(f.directory, `continue-${f.armed.id}.json`), JSON.stringify({ id: f.armed.id, consentId: pending.consentId, revision: 3, apiStatus: 200, revokedAt: new Date().toISOString() }));
  assert.equal((await sent).status, 200); assert.equal(f.accepted.length, 1); const receipt = await f.receipt();
  assert.equal(receipt.forwardedAfterRevocation, true); assert.equal(receipt.consentId, pending.consentId);
  assert.equal(receipt.version, 2); assert.equal(receipt.downstream.accepted, true);
  assert.equal(receipt.downstream.jobId, value.jobId); assert.equal(receipt.downstream.fingerprint, value.fingerprint);
  assert.match(receipt.downstream.responseSha256, /^[a-f0-9]{64}$/);
  const first = await readFile(join(f.directory, `receipt-${f.armed.id}.json`), 'utf8');
  assert.equal((await f.send('/codex', value)).status, 200); assert.equal(f.accepted.length, 2);
  assert.equal(await readFile(join(f.directory, `receipt-${f.armed.id}.json`), 'utf8'), first);
  assert.equal((await f.send('/codex', { ...value, task: 'changed payload' })).status, 503); assert.equal(f.accepted.length, 2);
});

async function revoke(f, value) {
  const sent = f.send('/codex', value), file = join(f.directory, `pending-${f.armed.id}.json`);
  let pending;
  for (let n = 0; n < 100; n++) { try { pending = JSON.parse(await readFile(file, 'utf8')); break; } catch { await new Promise(done => setTimeout(done, 5)); } }
  assert.ok(pending);
  await writeFile(join(f.directory, `continue-${f.armed.id}.json`), JSON.stringify({ id: f.armed.id, consentId: pending.consentId, revision: pending.revision + 1, apiStatus: 200, revokedAt: new Date().toISOString() }));
  return { sent };
}
const applyInput = f => ({ ...input(f.armed), action: 'start', environmentExecution: { phase: 'apply', repoUrl: f.armed.repoUrl, consent: { id: randomUUID(), revision: 2 } } });

test('revocation intent and actual in-flight submission have no applied receipt until exact downstream acknowledgement', async t => {
  let release; const gate = new Promise(done => { release = done; });
  t.after(() => release());
  const f = await fixture(t, 'consent_revoked_before_release', { beforeReply: () => gate }), value = applyInput(f);
  const { sent } = await revoke(f, value);
  try {
    for (let n = 0; n < 100 && !f.accepted.length; n++) await new Promise(done => setTimeout(done, 5));
    assert.equal(f.accepted.length, 1); await assert.rejects(f.receipt(), { code: 'ENOENT' });
    const intent = JSON.parse(await readFile(join(f.directory, `submission-${f.armed.id}.json`), 'utf8'));
    assert.equal(intent.status, 'outcome_unknown'); assert.equal(intent.applied, undefined); assert.equal(intent.forwardedAfterRevocation, undefined);
    assert.equal((await f.send('/codex', value)).status, 503); assert.equal(f.accepted.length, 1, 'No replay while first outcome is unknown');
  } finally { release(); }
  assert.equal((await sent).status, 200); assert.equal((await f.receipt()).downstream.accepted, true);
});

test('lost downstream response preserves unknown intent and rejects blind retry', async t => {
  const f = await fixture(t, 'consent_revoked_before_release', { loseReply: true }), value = applyInput(f);
  const { sent } = await revoke(f, value); assert.equal((await sent).status, 502);
  assert.equal(f.accepted.length, 1); await assert.rejects(f.receipt(), { code: 'ENOENT' });
  assert.equal((await f.send('/codex', value)).status, 503); assert.equal(f.accepted.length, 1);
  assert.equal(JSON.parse(await readFile(join(f.directory, `submission-${f.armed.id}.json`), 'utf8')).status, 'outcome_unknown');
});

test('crash residue before forwarding cannot become an applied receipt or be replayed', async t => {
  const f = await fixture(t, 'consent_revoked_before_release'), value = applyInput(f);
  await writeFile(join(f.directory, `pending-${f.armed.id}.json`), JSON.stringify({ id: f.armed.id }));
  await writeFile(join(f.directory, `submission-${f.armed.id}.json`), JSON.stringify({ status: 'outcome_unknown' }));
  assert.equal((await f.send('/codex', value)).status, 503); assert.equal(f.accepted.length, 0);
  await assert.rejects(f.receipt(), { code: 'ENOENT' });
});

test('wrong worker identity and rejected responses cannot certify forwarding', async t => {
  for (const options of [{ accept: x => ({ ...x, execution: { ...x.execution, attemptId: randomUUID() } }) }, { status: 409 }]) {
    const f = await fixture(t, 'consent_revoked_before_release', options), value = applyInput(f);
    const { sent } = await revoke(f, value); assert.equal((await sent).status, 502);
    await assert.rejects(f.receipt(), { code: 'ENOENT' }); assert.equal(f.accepted.length, 1);
  }
});

test('chunked bodies and responses are buffered without conflicting transfer/content-length headers', async t => {
  const f = await fixture(t, 'runner_ack_lost'), value = { ...input(f.armed), mode: 'inspect' };
  const output = await new Promise((yes, no) => { const req = request({ hostname: '127.0.0.1', port: f.servers.runner.address().port, path: '/jobs', method: 'POST', headers: { 'content-type': 'application/json' } }, async res => { let text = ''; for await (const bytes of res) text += bytes; yes({ status: res.statusCode, body: JSON.parse(text) }); }); req.on('error', no); req.write(JSON.stringify(value)); req.end(); });
  assert.equal(output.status, 200); assert.deepEqual(output.body, value);
});

function partial() {
  const workspaceId = randomUUID(), at = '2026-10-06T12:00:00Z', repo = { url: 'https://github.com/syna-autonomy-fixture/configured', commit: 'a'.repeat(40) };
  const state = { missions: [{ runtime, lifecycle: 'closed', closure_reason: 'blocked', lease_until: null, closed_at: at }], claims: [], attempts: [], repositories: [], setups: [], runs: [], events: [],
    reports: [{ id: randomUUID(), status: 'completed', lease_until: null, item_id: randomUUID(), finished_at: at, document: { partial: true, tests: [] } }], waits: [{ state: 'expired', deadline_at: at }] };
  const context = { scenario: 'REPO-12', variant: 'missing_key_no_answer', runtime, workspaceId, repo,
    fault: { runtime, workspaceId, variant: 'missing_key_no_answer', applied: true, appliedAt: at, missingName: 'SERVICE_ACCESS_TOKEN', userAnswers: 0 } };
  return { state, context };
}

test('missing-key pass requires actual injection, expired unanswered wait and bounded clean partial report', () => {
  const { state, context } = partial(); assert.equal(auditRepoFaultCompletion(state, context).report.document.partial, true);
  for (const mutate of [(s, c) => c.fault.applied = false, s => s.waits[0].state = 'waiting', s => s.reports[0].document.partial = false, s => s.runs.push({ result: { outcome: 'passed' } }), s => s.events.push({ kind: 'environment.released' }), s => s.claims.push({ state: 'uncertain' }), s => s.waits.push({ state: 'expired' })]) {
    const value = partial(); mutate(value.state, value.context); assert.throws(() => auditRepoFaultCompletion(value.state, value.context));
  }
});

test('app-stop oracle requires the physical fault before browser admission and rejects swapped or late receipts', () => {
  function sample() {
    const { state, context } = partial(), id = randomUUID(), attemptId = randomUUID(); context.scenario = 'REPO-11'; context.variant = 'app_stops_after_ready'; context.repo.url = 'https://github.com/syna-autonomy-fixture/keyless';
    state.waits = []; state.attempts = [{ id: attemptId, kind: 'preview_discovery', status: 'failed', created_at: '2026-10-06T12:00:01Z', finished_at: '2026-10-06T12:01:00Z', lease_until: null }];
    state.setups = [{ id, autonomy: { resourceId: randomUUID(), environmentExecution: { phase: 'apply' } }, result: { cleanup: 'confirmed', executorStopped: true, environment: { processId: randomUUID() } } }];
    context.fault = { ...context.fault, variant: context.variant, jobId: id, resourceId: state.setups[0].autonomy.resourceId, processId: state.setups[0].result.environment.processId,
      commit: context.repo.commit, readyAt: '2026-10-06T11:59:59Z', processGroupEmpty: true, httpReachableAfter: false };
    return { state, context };
  }
  const good = sample(); assert.equal(auditRepoFaultCompletion(good.state, good.context).report.document.partial, true);
  for (const mutate of [(s, c) => c.fault.jobId = randomUUID(), (s, c) => c.fault.processGroupEmpty = false, (s, c) => c.fault.httpReachableAfter = true, s => s.attempts[0].created_at = '2026-10-06T11:59:00Z']) {
    const value = sample(); mutate(value.state, value.context); assert.throws(() => auditRepoFaultCompletion(value.state, value.context));
  }
});

test('consent oracle binds revoked revision to exact reserved apply and denies any released credentials', () => {
  function sample() {
    const { state, context } = partial(), id = randomUUID(), attemptId = randomUUID(); context.variant = 'consent_revoked_before_release'; context.savedConsent = { consentId: randomUUID(), revision: 1 };
    state.waits = []; state.attempts = [{ id: attemptId, kind: 'environment_setup', status: 'failed', created_at: '2026-10-06T11:59:59Z', finished_at: '2026-10-06T12:01:00Z', lease_until: null }];
    state.setups = [{ id, autonomy: { execution: { attemptId }, environmentExecution: { phase: 'apply' } }, result: { cleanup: 'confirmed', executorStopped: true } }];
    context.fault = { ...context.fault, variant: context.variant, jobId: id, attemptId, consentId: context.savedConsent.consentId, revision: 2, forwardedAfterRevocation: true }; return { state, context };
  }
  const good = sample(); auditRepoFaultCompletion(good.state, good.context);
  for (const mutate of [(s, c) => c.fault.revision = 1, (s, c) => c.fault.attemptId = randomUUID(), s => s.events.push({ kind: 'environment.released' }), s => s.setups[0].autonomy.release = { releasedAt: '2026-10-06T12:00:00Z' }]) {
    const value = sample(); mutate(value.state, value.context); assert.throws(() => auditRepoFaultCompletion(value.state, value.context));
  }
});
