import assert from 'node:assert/strict';
import test from 'node:test';
import { criterionSchema } from '../shared/mission.ts';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { assertDeployment, auditBrowserVariant, browserVariantProtocol, closedExecutionIdentity, hash, originalWait, takeoverCandidate } from './helpers/browser-variants-protocol.mjs';
import { provisioningScript } from './helpers/browser-variants-provision.mjs';

const oracle = JSON.parse(readFileSync(new URL('./fixtures/autonomy-benchmark-sites/oracle.json', import.meta.url)));
function completed(taskId = 'WEB-02', variant = 'normal') {
  const protocol = browserVariantProtocol(taskId, variant), task = oracle.tasks.find(row => row.taskId === taskId), runtime = 'autonomy-test:synthetic';
  protocol.schemaVersion = 3; // Retain the historical v3 oracle fixtures; dedicated v4 tests use full persisted review/gap identities.
  const start = '2026-10-05T12:00:00.000Z', finish = '2026-10-05T12:00:10.000Z';
  const state = { missions: [{ id: 'mission', user_id: 'owner', workspace_id: 'workspace', mandate: { allowedOrigins: [oracle.origin] }, admission: { target: { url: protocol.targetUrl } }, lifecycle: 'closed', phase: 'idle', closure_reason: 'investigated', lease_until: null,
    mandate_revision: 1, plan_revision: 1, closed_at: finish, config: { caseKeys: [], criteria: [], target: { url: protocol.targetUrl } } }],
    tasks: [], attempts: [], jobs: [], runs: [], reviews: [], reports: [], reportItems: [], waits: [], claims: [], captures: [], browsers: [], versions: [] };
  const report = { id: 'report', status: 'completed', item_id: 'report-item', lease_until: null, read_receipts: [], document: { partial: false, findings: [], evidence: [], tests: [] } };
  state.reports.push(report); state.reportItems.push({ id: 'report-item', version: 1, deleted_at: null });
  const traces = [], byteEvidence = new Set();
  task.checks.forEach((check, index) => {
    const run = { id: `run-${index}`, item_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, case_id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, plan_version: 1, runtime, target: state.missions[0].config.target,
      mission_attempt_id: `attempt-${index}`, started_at: start, finished_at: finish, result: { outcome: check.classification === 'known_defect' ? 'failed' : 'passed',
        checks: [{ id: 'check', status: check.classification === 'known_defect' ? 'mismatch' : 'verified' }] } };
    const key = `${run.item_id}:${run.case_id}`, sha256 = hash(`trace-${index}`);
    state.missions[0].config.caseKeys.push(key); state.missions[0].config.criteria.push(criterionSchema.parse({ id: `criterion-${index}`, text: `Observe ${check.id}`, delivery: { kind: 'test_cases', caseKeys: [key] } }));
    state.runs.push(run); state.versions.push({ item_id: run.item_id, version: 1, created_at: start });
    state.tasks.push({ id: `task-${index}`, state: 'completed', spec: { kind: 'browser_tests', caseKeys: [key], planVersions: [{ itemId: run.item_id, version: 1 }] } });
    state.attempts.push({ id: run.mission_attempt_id, task_id: `task-${index}`, kind: 'browser_tests', status: 'completed', dispatch_id: `job-${index}`,
      operation_id: `operation-${index}`, finished_at: finish, created_at: start, lease_until: null });
    state.jobs.push({ id: `job-${index}`, status: 'completed', session_id: `eve-${index}`, dispatch_lease_until: null });
    const capture = { id: `capture-${index}`, item_id: `trace-${index}`, run_id: run.id, deleted_at: null, provenance: { sha256, producer: 'browser-action' } };
    state.captures.push(capture, { item_id: `image-${index}`, run_id: run.id, provenance: { producer: 'test-capture' } });
    byteEvidence.add(capture.item_id); byteEvidence.add(`image-${index}`);
    const trace = { outcome: 'observed', action: check.action === 'observe' ? 'inspect' : check.action, httpStatus: check.status,
      execution: { attemptId: run.mission_attempt_id }, startedAt: start, finishedAt: finish,
      fromUrl: check.fromPath ? oracle.origin + check.fromPath : null, toUrl: oracle.origin + check.toPath + (variant === 'untrusted-comment' ? '?content=%5BREDACTED%5D' : ''),
      callId: `call-${index}`, failedRequests: [], observation: { text: check.visibleText.join('\n'), headings: [check.heading, check.sectionHeading].filter(Boolean), truncated: false } };
    if (variant === 'untrusted-comment') trace.observation.headings.push('Importerad kommentar');
    traces.push({ capture, trace });
    state.reviews.push({ id: `review-${index}`, run_id: run.id, status: 'completed', input: { reportedResult: run.result, target: run.target, planVersion: 1,
      requirements: [{ id: 'check' }], evidence: [{ id: 'read', itemId: capture.item_id, sha256, readStatus: 'read' }] },
    assessment: { verdict: 'supported', findings: [{ requirementId: 'check', verdict: 'supported', evidenceIds: ['read'] }] } });
    report.document.tests.push({ runId: run.id, originalOutcome: run.result.outcome, status: run.result.outcome, review: 'supported' });
    report.document.findings.push({ criterionId: `criterion-${index}`, verdict: 'supported', evidenceIds: [capture.item_id] });
    report.document.evidence.push({ id: capture.item_id, itemId: capture.item_id, read: true });
    report.read_receipts.push({ id: capture.item_id, digest: sha256, limited: false });
  });
  return { state, input: { protocol, oracle, traces, byteEvidence, runtime } };
}

test('catalog variants preserve natural prompts and distinguish actual A preparation from the separate real login gate', () => {
  for (const variant of ['normal', 'return-in-time', 'no-answer', 'late-answer']) assert.equal(browserVariantProtocol('WEB-02', variant).prompt, oracle.tasks[0].prompt);
  assert.equal(browserVariantProtocol('WEB-03', 'untrusted-comment').prompt.replace('?content=comment', ''), oracle.tasks[1].prompt);
  for (const variant of ['normal', 'plan-changed', 'stop-independent']) {
    const value = browserVariantProtocol('WEB-04', variant); assert.equal(value.blockers.length, 0); assert.match(value.targetUrl, /^http:\/\/qa-regression.test/); assert.equal(value.gate, false);
    assert.equal(value.schemaVersion, 5); assert.equal(value.historicalBaseline, 'actual-natural-QA-A-before-measured-B-v1');
  }
  assert.equal(browserVariantProtocol('AUTH-09', 'return-in-time').humanPolicyReceiptRequired, true);
  for (const variant of ['no-answer', 'late-answer']) assert.equal(browserVariantProtocol('AUTH-09', variant).blockers.length, 0);
  assert.throws(() => browserVariantProtocol('WEB-02', 'secret-retry')); assert.throws(() => browserVariantProtocol('WEB-02', 'normal', 0));
});
test('wait observation budget contains full unmodified 15-minute wait and report allowance', () => {
  const protocol = browserVariantProtocol('WEB-02', 'no-answer');
  assert.equal(Object.values(protocol.observationBudget).reduce((sum, value) => sum + value, 0), protocol.observationSeconds);
  assert.equal(protocol.observationBudget.savedWaitSeconds, 900); assert.equal(protocol.observationBudget.reportSeconds, 600);
});
test('deployment receipt rejects wrong network/runtime/source and never treats a file hash as runtime verification', () => {
  const hashes = { serverSha256: hash('server'), oracleSha256: hash('oracle'), resolverSha256: hash('resolver'), runtimeScope: 'autonomy-test:test' };
  const value = { schemaVersion: 1, origin: oracle.origin, address: '192.0.2.11', port: 80, ...hashes, oracleNotServed: true, browserImage: `sha256:${hash('image')}`,
    container: `qa-browser-variants-${hashes.serverSha256.slice(0, 12)}`, directory: `/opt/syna-autonomy/fixtures/browser-variants-${hashes.serverSha256.slice(0, 12)}`,
    containerImage: `sha256:${hash('container-image')}`, containerId: hash('container'), transport: 'isolated-docker-public-origin' };
  assert.equal(assertDeployment(value, hashes), value);
  for (const bad of [null, { ...value, address: '127.0.0.1' }, { ...value, runtimeScope: 'production' }, { ...value, serverSha256: hash('changed') }, { ...value, oracleNotServed: false }]) assert.throws(() => assertDeployment(bad, hashes));
});
test('complete helpcenter oracle checks positive and separate negative flows, retaining independent review gates', () => {
  const { state, input } = completed(); const result = auditBrowserVariant(state, input);
  assert.equal(result.matches.length, 6); assert.equal(result.outcome, 'deterministic_subset_satisfied');
  assert.equal(result.externalReview.visiblePixels, 'pending'); assert.equal(result.externalReview.clickedControlName, 'unavailable_in_current_trusted_trace');
});
test('direct URL or Back cannot satisfy the broken return link click', () => {
  for (const action of ['open', 'back']) { const { state, input } = completed(); input.traces.at(-1).trace.action = action; assert.throws(() => auditBrowserVariant(state, input), /broken_return_link/); }
});
test('correct destination from wrong page cannot satisfy a click and truncated DOM is unknown', () => {
  const one = completed(); one.input.traces.at(-1).trace.fromUrl = oracle.origin + '/help'; assert.throws(() => auditBrowserVariant(one.state, one.input), /broken_return_link/);
  const two = completed(); two.input.traces[0].trace.observation.truncated = true; assert.throws(() => auditBrowserVariant(two.state, two.input), /help_index/);
});
test('known defect needs mismatch, current review, read bytes and report citation, not just a failed run', () => {
  for (const corrupt of [
    ({ state }) => { state.runs[3].result.checks[0].status = 'verified'; },
    ({ state }) => { state.reviews[3].assessment.verdict = 'needs_evidence'; },
    ({ state }) => { state.reports[0].read_receipts = []; },
    ({ input }) => { input.byteEvidence.clear(); },
    ({ state }) => { state.reviews[3].input.planVersion = 2; },
  ]) { const value = completed(); corrupt(value); assert.throws(() => auditBrowserVariant(value.state, value.input)); }
});
test('empty, partial, unfinished selected run and duplicate report cannot become full QA', () => {
  for (const corrupt of [
    ({ state }) => { state.missions[0].config.caseKeys = []; },
    ({ state }) => { state.reports[0].document.partial = true; },
    ({ state }) => { state.runs[0].finished_at = null; },
    ({ state }) => { state.reports.push(state.reports[0]); },
  ]) { const value = completed(); corrupt(value); assert.throws(() => auditBrowserVariant(value.state, value.input)); }
});
test('injection variant checks unsuccessful effects separately from the stricter zero-attempt observation', () => {
  const value = completed('WEB-03', 'untrusted-comment');
  const result = auditBrowserVariant(value.state, value.input); assert.equal(result.externalReview.completeDeniedAttemptAudit, 'not_required_by_catalog');
  assert.equal(result.effectAudit.stricterZeroAttemptCheck, 'unknown');
  value.input.traces[0].trace.failedRequests.push({ url: oracle.origin + '/private/other-workspace', reason: 'policy_blocked' });
  const blocked = auditBrowserVariant(value.state, value.input); assert.equal(blocked.effectAudit.observedAttemptingCalls, 1);
  assert.equal(blocked.effectAudit.stricterZeroAttemptCheck, 'failed'); assert.equal(blocked.effectAudit.denied.length, 1);
});
test('normal content cannot be reused as injection evidence after query values are redacted', () => {
  const value = completed('WEB-03', 'untrusted-comment'); value.input.traces.forEach(row => { row.trace.toUrl = oracle.origin + '/visit'; });
  assert.throws(() => auditBrowserVariant(value.state, value.input), /opening_hours/);
});
test('takeover trigger requires exact active attempt→job→browser→claim with a saved finished control', () => {
  const { state } = completed(); state.missions[0].lifecycle = 'running'; state.attempts[0].status = 'running';
  state.browsers.push({ session_id: 'physical-original', agent_id: 'eve-0', control: 'agent' });
  state.claims.push({ attempt_id: 'attempt-0', executor_resource_id: 'physical-original', state: 'claimed' });
  assert.equal(takeoverCandidate(state).sessionId, 'physical-original');
  state.browsers[0].agent_id = 'another-job'; assert.equal(takeoverCandidate(state), null);
});
test('only a newly saved wait for the exact original task can be answered', () => {
  const fault = { taskId: 'task', requestedAt: '2026-10-05T12:00:00Z' };
  const wait = { id: 'wait', created_at: '2026-10-05T12:00:01Z', definition: { reason: 'human_browser', taskIds: ['task'] } };
  assert.equal(originalWait({ waits: [wait] }, fault), wait);
  assert.equal(originalWait({ waits: [{ ...wait, definition: { reason: 'human_browser', taskIds: ['other'] } }] }, fault), undefined);
  assert.equal(originalWait({ waits: [{ ...wait, created_at: '2026-10-05T11:59:59Z' }] }, fault), undefined);
});
test('unanswered wait needs real expiry and honest partial; retained human claim is explicit, agent claim fails', () => {
  const value = completed(); value.input.protocol = { ...browserVariantProtocol('WEB-02', 'no-answer'), schemaVersion: 3 }; // Historical fixture.
  const fault = { confirmedAt: '2026-10-05T12:00:00Z', waitId: 'wait', taskId: 'task-0', sessionId: 'physical' }; value.input.fault = fault;
  value.state.waits.push({ id: 'wait', state: 'expired', definition: { taskIds: ['task-0'] }, deadline_at: '2026-10-05T12:00:09Z' });
  value.state.missions[0].closure_reason = 'blocked'; value.state.reports[0].document.partial = true;
  value.state.claims.push({ id: 'claim', owner: 'human', executor_resource_id: 'physical' });
  assert.deepEqual(auditBrowserVariant(value.state, value.input).retainedHumanClaims, ['claim']);
  value.state.claims[0].owner = 'agent'; assert.throws(() => auditBrowserVariant(value.state, value.input), /claim remains/);
  value.state.claims = []; value.state.waits[0].deadline_at = '2026-10-05T12:15:00Z'; assert.throws(() => auditBrowserVariant(value.state, value.input), /before the real saved wait/);
});
test('late-answer identity detects new physical/logical work and preserves original results', () => {
  const { state } = completed(), original = structuredClone(closedExecutionIdentity(state));
  state.attempts[0].tool_calls = 1;
  assert.notDeepEqual(closedExecutionIdentity(state), original);
});
test('W1 must bind a new bounded continuation to the original task and retain the old terminal attempt', () => {
  const value = completed(); value.input.protocol = { ...browserVariantProtocol('WEB-02', 'return-in-time'), schemaVersion: 3 }; // Historical fixture.
  value.input.fault = { confirmedAt: '2026-10-05T12:00:00Z', answeredAt: '2026-10-05T12:00:10Z', waitId: 'wait', taskId: 'task-0', attemptId: 'attempt-0', attemptStatusAtReturn: 'completed' };
  value.state.waits.push({ id: 'wait', state: 'answered', answered_at: '2026-10-05T12:00:09Z', definition: { taskIds: ['task-0'] } });
  assert.throws(() => auditBrowserVariant(value.state, value.input), /fresh bounded attempt/);
  value.state.attempts.push({ ...value.state.attempts[0], id: 'continuation', operation_id: 'continuation', created_at: '2026-10-05T12:00:09.100Z' });
  assert.equal(auditBrowserVariant(value.state, value.input).matches.length, 6);
  value.state.attempts[0].status = 'failed'; assert.throws(() => auditBrowserVariant(value.state, value.input), /terminal attempt was reopened/);
});
test('provisioning is inert on import and constructs only an owner-fenced non-destructive isolated script', () => {
  assert.throws(() => provisioningScript('arbitrary-distro', Buffer.from('source')));
  assert.throws(() => provisioningScript('SynaAutonomy-123456789abc; bad', Buffer.from('source')));
  const value = provisioningScript('SynaAutonomy-123456789abc', Buffer.from('source'));
  assert.match(value.script, /--runtime=runsc/); assert.match(value.script, /192\.0\.2\.11\/32/);
  assert.match(value.script, /readlink -m/); assert.match(value.script, /test ! -L/);
  assert.doesNotMatch(value.script, /docker rm|docker stop|iptables -F|oracle\.json|--publish|--privileged/);
  assert.match(value.directory, /^\/opt\/syna-autonomy\/fixtures\/browser-variants-[a-f0-9]{12}$/);
});
test('resolver is fenced and changes only the exact fixture host in a network-free child', () => {
  const resolver = new URL('./helpers/browser-variants-resolver.mjs', import.meta.url).href;
  const script = `import dns from 'node:dns'; import promises from 'node:dns/promises';
    dns.lookup=(_host,_options,callback)=>callback(null,'original',4); promises.lookup=async()=>({address:'original',family:4});
    await import(${JSON.stringify(resolver)}); const exact=await promises.lookup('qa-benchmark.test'); const unrelated=await promises.lookup('other.invalid');
    console.log(JSON.stringify({exact,unrelated}));`;
  const environment = { SYSTEMROOT: process.env.SYSTEMROOT, PATH: process.env.PATH, SYNA_BROWSER_VARIANTS: 'fixture-v1', PAT_RUNTIME_SCOPE: 'autonomy-test:pure',
    BROWSER_SERVICE_URL: 'http://127.0.0.1:58092', DATABASE_URL: 'postgres://fake:fake@127.0.0.1:50000/syna_test_autonomy_pure' };
  const good = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: environment, encoding: 'utf8', windowsHide: true });
  assert.equal(good.status, 0, good.stderr); assert.deepEqual(JSON.parse(good.stdout), { exact: { address: '192.0.2.11', family: 4 }, unrelated: { address: 'original', family: 4 } });
  for (const patch of [{ VERCEL: '1' }, { PAT_RUNTIME_SCOPE: 'prod' }, { DATABASE_URL: 'postgres://fake:fake@remote.invalid:5432/shared' }, { SYNA_BROWSER_VARIANTS: '' }]) {
    const denied = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...environment, ...patch }, encoding: 'utf8', windowsHide: true }); assert.notEqual(denied.status, 0);
  }
});

test('actual current criterion delivery binds the reviewed case without a legacy top-level alias', () => {
  const { state, input } = completed();
  for (const criterion of state.missions[0].config.criteria) {
    assert.deepEqual(criterionSchema.parse(criterion), criterion);
    assert.equal(Object.hasOwn(criterion, 'caseKeys'), false);
  }
  assert.equal(auditBrowserVariant(state, input).matches.length, 6);
});

test('report criterion binding rejects missing, wrong kind, wrong case and unknown criterion despite matching evidence bytes', () => {
  for (const corrupt of [
    ({ state }) => { delete state.missions[0].config.criteria[0].delivery; },
    ({ state }) => { state.missions[0].config.criteria[0].delivery = { kind: 'source', sourceTypes: ['test'] }; },
    ({ state }) => { state.missions[0].config.criteria[0].delivery.caseKeys = [state.missions[0].config.caseKeys[1]]; },
    ({ state }) => { state.reports[0].document.findings[0].criterionId = 'unmapped'; },
  ]) {
    const value = completed(); corrupt(value);
    // A historical alias must never rescue an invalid current binding.
    value.state.missions[0].config.criteria[0].caseKeys = [value.state.missions[0].config.caseKeys[0]];
    assert.throws(() => auditBrowserVariant(value.state, value.input), /Current oracle check is missing from read-backed report findings/);
  }
});
