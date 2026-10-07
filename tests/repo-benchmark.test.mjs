import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { validateRepoManifest, repoPrompt, repoHash, assertSavedConsent, freezeRepoModelPacing } from './helpers/repo-benchmark-contract.mjs';
import { auditRepoCompletion } from './helpers/repo-benchmark-audit.mjs';
import { cartTotal } from './fixtures/repo-benchmark/library/cart.mjs';
import { createServer as keylessServer } from './fixtures/repo-benchmark/keyless/server.mjs';
import { createServer as configuredServer } from './fixtures/repo-benchmark/configured/server.mjs';

const oracleBytes = await readFile(new URL('./fixtures/repo-benchmark/oracle.json', import.meta.url));
const oracle = JSON.parse(oracleBytes).scenarios;
const clone = value => structuredClone(value), hash = 'a'.repeat(64), sha = 'a'.repeat(40);
test('repository protocol freezes provider pacing separately from source and rejects env drift', () => {
  const old = {}, paced = {};
  assert.equal(freezeRepoModelPacing(old, {}), 0);
  assert.equal(freezeRepoModelPacing(paced, { modelRequestIntervalMs: 6000 }), 6000);
  assert.equal(paced.modelRequestIntervalMs, 6000);
  assert.throws(() => freezeRepoModelPacing(paced, { modelRequestIntervalMs: 0 }), /changed/);
  assert.throws(() => freezeRepoModelPacing(old, { modelRequestIntervalMs: 6000 }), /changed/);
  for (const value of [-1, 30001, '6000', Infinity]) assert.throws(() => freezeRepoModelPacing({}, { modelRequestIntervalMs: value }));
});
function manifest() {
  return { version: 1, kind: 'syna-repository-benchmark', oracleSha256: repoHash(oracleBytes), oracleNotServed: true, oracleNotInPrompt: true,
    transport: { kind: 'unbound' }, repositories: ['REPO-10', 'REPO-11', 'REPO-12'].map(scenario => ({ scenario, url: 'https://github.com/syna-autonomy-fixture/' + oracle[scenario].fixture,
      commit: sha, tree: sha, filesSha256: hash, lockfileSha256: hash, packageManager: 'npm', runtime: 'node24', directory: '.', codeChangesAllowed: false })) };
}
function library() {
  const repo = manifest().repositories[0], attemptId = randomUUID(), dispatchId = randomUUID(), runtime = 'autonomy-test:repo-unit';
  const makeRun = (id, mode) => ({ id, runtime, config: { url: repo.url, mode, expectedCommit: sha, script: 'test', directory: '.' }, job: { commit: sha, finishedAt: '2026-10-05T12:00:00Z', cleanup: { confirmed: true }, status: mode === 'inspect' ? 'review' : 'failed', testExitCode: mode === 'inspect' ? null : 1,
    execution: { attemptId, dispatchId }, plan: { command: oracle['REPO-10'].command }, logs: 'not ok the cart total includes every quantity: 1250 !== 3750' } });
  const check = makeRun(randomUUID(), 'test');
  const report = { id: randomUUID(), status: 'completed', lease_until: null, item_id: randomUUID(), finished_at: '2026-10-05T12:01:00Z', document: { partial: false, findings: [{ verdict: 'supported', evidenceIds: [`repo:${check.id}`] }], evidence: [{ id: `repo:${check.id}`, read: true }] }, read_receipts: [{ id: `repo:${check.id}`, digest: hash, limited: false }] };
  const state = { missions: [{ runtime, lifecycle: 'closed', closure_reason: 'investigated', lease_until: null }], tasks: [{ state: 'completed' }], claims: [], attempts: [{ id: attemptId, dispatch_id: dispatchId, status: 'completed', finished_at: '2026-10-05T12:00:00Z', lease_until: null }],
    reports: [report], repositories: [makeRun(randomUUID(), 'inspect'), check], jobs: [], runs: [], setups: [] };
  return { state, context: { runtime, repo, oracle: oracle['REPO-10'] } };
}
function application() {
  const { state, context } = library(); state.repositories = state.repositories.slice(0, 1);
  context.repo = { ...manifest().repositories[1], executionImage: 'sha256:' + hash }; context.oracle = oracle['REPO-11'];
  state.repositories[0].config.url = context.repo.url;
  const environment = { repoUrl: context.repo.url, commit: sha, observedAt: '2026-10-05T12:00:00Z', executionProfile: { imageDigest: context.repo.executionImage, lockfileSha256: hash, ignoreScripts: true } };
  const prepare = { id: randomUUID(), autonomy: { environmentExecution: { phase: 'prepare' } }, result: { environment: { ...environment, probeKind: 'identity' }, executorStopped: true, cleanup: 'confirmed' } };
  const apply = { id: randomUUID(), autonomy: { environmentExecution: { phase: 'apply', sourceSetupJobId: prepare.id, plan: { commit: sha }, consent: null } }, result: { environment: { ...environment, probeKind: 'http', httpStatus: 200 }, executorStopped: true, cleanup: 'confirmed' } };
  state.setups = [prepare, apply]; state.events = [{ kind: 'environment.ready', payload: { setupJobId: apply.id } }];
  state.attempts[0].kind = 'preview_discovery'; state.jobs = [{ status: 'completed', dispatch_lease_until: null }]; state.browsers = [];
  state.reviews = []; state.captures = [];
  const report = state.reports[0]; report.document.tests = []; report.document.evidence = []; report.read_receipts = [];
  context.traces = []; context.byteEvidence = new Set();
  for (const [index, expected] of context.oracle.observations.entries()) {
    const id = randomUUID(), item = randomUUID(), plan = randomUUID(), caseId = randomUUID();
    const run = { id, item_id: plan, case_id: caseId, plan_version: 1, target: { url: 'http://172.30.0.5:3000', revision: sha }, finished_at: '2026-10-05T12:00:00Z', result: { outcome: expected.outcome, checks: [{ id: 'check', status: expected.outcome === 'failed' ? 'mismatch' : 'verified' }] } };
    state.runs.push(run);
    state.reviews.push({ run_id: id, status: 'completed', assessment: { verdict: 'supported', findings: [{ requirementId: 'check', verdict: 'supported', evidenceIds: [item] }] }, input: { reportedResult: clone(run.result), target: clone(run.target), planVersion: 1, requirements: [{ id: 'check' }], evidence: [{ id: item, itemId: item, readStatus: 'read', sha256: hash }] } });
    const capture = { run_id: id, item_id: item, provenance: { sha256: hash, producer: 'browser-action' } };
    state.captures.push(capture, { run_id: id, item_id: 'png-' + id, provenance: { producer: 'test-capture', sha256: hash } });
    context.traces.push({ capture, trace: { action: expected.action, outcome: 'observed', fromUrl: 'http://172.30.0.5:3000/', toUrl: 'http://172.30.0.5:3000' + expected.toPath, httpStatus: expected.status, observation: { text: expected.text } } });
    context.byteEvidence.add(item); context.byteEvidence.add('png-' + id);
    report.document.tests.push({ runId: id, originalOutcome: expected.outcome, status: expected.outcome, review: 'supported' });
    report.document.evidence.push({ id: 'item:' + item, itemId: item, read: true }); report.read_receipts.push({ id: 'item:' + item, digest: hash, limited: false });
    report.document.findings[index] = { criterionId: 'qa', verdict: 'supported', evidenceIds: ['item:' + item] };
  }
  state.missions[0].config = { caseKeys: state.runs.map(r => `${r.item_id}:${r.case_id}`), criteria: [{ id: 'qa', delivery: { kind: 'test_cases', caseKeys: state.runs.map(r => `${r.item_id}:${r.case_id}`) } }] };
  return { state, context };
}
// Handler probes deliberately do not listen on a socket or start a runtime.
function request(server, url, method = 'GET') {
  let body; const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); }, end(value = '') { body = value; } };
  server.emit('request', { url, method }, response);
  return { status: response.statusCode, headers: response.headers, body };
}

test('local commit manifest is valid but cannot authorize a model request without transport', () => {
  assert.equal(validateRepoManifest(manifest()).transport.kind, 'unbound');
  assert.throws(() => validateRepoManifest(manifest(), { runnable: true }), /fetchable Git transport/);
});
test('manifest rejects abbreviated commit, duplicate scenario and absent oracle boundary', () => {
  for (const change of [m => m.repositories[0].commit = 'main', m => m.repositories[0].scenario = 'REPO-11', m => m.oracleNotServed = false]) {
    const value = manifest(); change(value); assert.throws(() => validateRepoManifest(value));
  }
});
test('natural prompt contains only goal, public URL and selected version', () => {
  const value = manifest();
  for (const repo of value.repositories) {
    const text = repoPrompt(repo.scenario, repo); assert.ok(text.includes(repo.url) && text.includes(sha));
    assert.doesNotMatch(text, /Iris|Otto|Klara|mission|taskId|1250|3750|kontakt-old|SERVICE_ACCESS_TOKEN/);
  }
});
test('library oracle preserves real deterministic regression and known positives', () => {
  assert.equal(cartTotal([]), 0); assert.equal(cartTotal([{ unitPrice: 1250, quantity: 1 }]), 1250);
  assert.equal(cartTotal([{ unitPrice: 1250, quantity: 3 }]), 1250);
  assert.notEqual(cartTotal([{ unitPrice: 1250, quantity: 3 }]), 3750);
});
test('keyless fixture has exact navigable positive and missing linked contact, with no served oracle', () => {
  const server = keylessServer(), home = request(server, '/');
  assert.equal(home.status, 200); assert.ok(home.body.includes('href="/kontakt-old"')); assert.ok(home.body.includes('href="/hjalp"'));
  assert.equal(request(server, '/hjalp').status, 200); assert.equal(request(server, '/kontakt').status, 200);
  assert.equal(request(server, '/kontakt-old').status, 404); assert.equal(request(server, '/oracle.json').status, 404);
  assert.equal(request(server, '/', 'POST').status, 405); assert.equal(home.headers['cache-control'], 'no-store');
});
test('configured fixture needs both synthetic values and never renders their contents', () => {
  assert.equal(request(configuredServer({}), '/').status, 503);
  assert.equal(request(configuredServer({ SERVICE_BASE_URL: 'https://unused.example.test' }), '/').status, 503);
  const server = configuredServer({ SERVICE_BASE_URL: 'https://unused.example.test', SERVICE_ACCESS_TOKEN: 'synthetic-never-render-this' });
  const home = request(server, '/'); assert.equal(home.status, 200); assert.ok(home.body.includes('Konfiguration kontrollerad'));
  assert.doesNotMatch(home.body, /synthetic-never|unused\.example/); assert.equal(request(server, '/hjalp').status, 200);
});
test('supported report of actual failed command is complete QA', () => {
  const { state, context } = library(); assert.equal(auditRepoCompletion(state, context).matched[0].exitCode, 1);
});
test('install success, substituted SHA, wrong command and absent read receipt cannot pass', () => {
  for (const change of [s => s.repositories[1].job.testExitCode = 0, s => s.repositories[1].job.commit = 'b'.repeat(40), s => s.repositories[1].job.plan.command = ['npm', 'ci'], s => s.reports[0].read_receipts = []]) {
    const { state, context } = library(); change(state); assert.throws(() => auditRepoCompletion(state, context));
  }
});
test('green retry, leaked resource and unbound attempt reject normal acceptance', () => {
  for (const change of [s => s.repositories.push(clone(s.repositories[1])), s => s.claims.push({ state: 'uncertain' }), s => s.repositories[1].job.execution.attemptId = randomUUID()]) {
    const { state, context } = library(); change(state); assert.throws(() => auditRepoCompletion(state, context));
  }
});
test('expired, revoked, wrong-owner or rotated saved consent cannot count as prepared', () => {
  const prepared = { setupJobId: randomUUID(), workspaceId: randomUUID(), consentId: randomUUID(), userId: randomUUID(), vaultRevision: 1, planHash: hash };
  const repo = manifest().repositories[2], runtime = 'autonomy-test:repo-unit';
  const base = { setups: [{ id: prepared.setupJobId, runtime, workspace_id: prepared.workspaceId, status: 'needs_configuration', result: { environment: { repoUrl: repo.url, commit: sha, probeKind: 'identity', executionProfile: {} }, cleanup: 'confirmed', executorStopped: true } }],
    consents: [{ id: prepared.consentId, user_id: prepared.userId, workspace_id: prepared.workspaceId, runtime, repo_url: repo.url, plan_hash: hash, grant_setup_job_id: prepared.setupJobId, vault_revision: 1, revision: 1, expires_at: '2026-10-06T00:00:00Z', revoked_at: null, allowed_names: oracle['REPO-12'].requiredNames }], vault: [{ repo_url: repo.url, revision: 1, environment: 'test' }] };
  const context = { runtime, repo, names: oracle['REPO-12'].requiredNames, now: Date.parse('2026-10-05T00:00:00Z') };
  assert.equal(assertSavedConsent(base, prepared, context).consentId, prepared.consentId);
  for (const change of [s => s.consents[0].expires_at = '2026-10-04T00:00:00Z', s => s.consents[0].revoked_at = '2026-10-04T00:00:00Z', s => s.consents[0].user_id = randomUUID(), s => s.vault[0].revision = 2]) {
    const state = clone(base); change(state); assert.throws(() => assertSavedConsent(state, prepared, context));
  }
});
test('keyless complete chain needs real-origin observations, current reviews and retained failed outcome', () => {
  const { state, context } = application(); assert.equal(auditRepoCompletion(state, context).matched.length, 3);
  context.traces[2].trace.fromUrl = 'http://172.30.0.5:3000/hjalp';
  assert.equal(auditRepoCompletion(state, context).matched.length, 3, 'An equally valid menu click from Help must not require an artificial return home');
});
test('soft 404, direct-URL substitute, wrong-origin or another run cannot impersonate failed navigation', () => {
  for (const change of [c => c.traces[2].trace.httpStatus = 200, c => c.traces[2].trace.action = 'open', c => c.traces[2].trace.toUrl = 'https://elsewhere.example.test/kontakt-old', c => c.traces[2].capture.run_id = randomUUID()]) {
    const { state, context } = application(); change(context); assert.throws(() => auditRepoCompletion(state, context));
  }
});
test('missing PNG, unread evidence, wrong result or swapped start-image cannot pass the app oracle', () => {
  for (const change of [(s, c) => c.byteEvidence.clear(), s => s.reviews[2].input.evidence[0].readStatus = 'unavailable', s => s.reports[0].document.tests[2].originalOutcome = 'passed', s => s.setups[1].result.environment.executionProfile.imageDigest = 'sha256:' + 'b'.repeat(64)]) {
    const { state, context } = application(); change(state, context); assert.throws(() => auditRepoCompletion(state, context));
  }
});
