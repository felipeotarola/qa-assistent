// Synthetic oracle controls only: no services, credentials or model calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { auditReviewInputHash, sha256 } from './helpers/autonomy-web-audit.mjs';
import { PUBLIC_URL, PUBLIC_PROMPT, PUBLIC_URL_PROTOCOL, PUBLIC_CODE_FILES, publicIrisLedgerPolicy, publicIrisReceipt, publicUrlOptions, publicBrowserSourceIdentity, auditPublicCompletion, auditPublicBytes, observePublicUrl } from './helpers/public-url-acceptance.mjs';

test('browser source identity matches the declared Linux CRLF transform while retaining raw bytes', () => {
  const lf = Buffer.from('const value = 1;\nexport { value };\n'), mixed = Buffer.from('const value = 1;\r\nexport { value };\n');
  const expected = sha256(lf), canonical = publicBrowserSourceIdentity(lf, expected), windows = publicBrowserSourceIdentity(mixed, expected);
  assert.equal(canonical.rawSha256, expected); assert.equal(canonical.normalizedSha256, expected);
  assert.equal(windows.normalization, 'utf8-crlf-to-lf-v1'); assert.equal(windows.normalizedSha256, expected);
  assert.equal(windows.rawSha256, sha256(mixed)); assert.notEqual(windows.rawSha256, expected);
});

test('browser source identity never normalizes semantic changes, lone CR, BOM, whitespace or invalid UTF-8', () => {
  const expected = sha256('export const readOnly = true;\n');
  for (const source of ['export const readOnly = false;\r\n', 'export const readOnly = true;\r',
    '\uFEFFexport const readOnly = true;\n', 'export const readOnly = true; \n', 'export const readOnly = true;']) {
    assert.throws(() => publicBrowserSourceIdentity(Buffer.from(source), expected), /differs from reviewed source/);
  }
  assert.throws(() => publicBrowserSourceIdentity(Buffer.from([0xff]), expected), /valid UTF-8/);
});

const callId = '11111111-1111-4111-8111-111111111111';
const irisLedger = (overrides = {}) => [`server:iris-model:start:${callId}`, 'server:iris-model:usage:' + JSON.stringify({ callId, inputTokens: 10, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: null, durationMs: 20, ...overrides })];
const start = '2026-10-06T00:00:00.000Z', finish = '2026-10-06T00:01:00.000Z';
function example() {
  const runtime = 'autonomy-test:public-unit', target = { environment: 'Public page', url: PUBLIC_URL, revision: '', scope: { kind: 'observation', id: 'scope-one', capturedAt: start } };
  const provider = { providerCalls: 1, unknownCalls: 0, inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: null, cacheWriteTokens: null, durationMs: 20 };
  const task = { id: 'browser-task', state: 'completed', plan_revision: 1, supplement_round: 0, created_at: start,
    spec: { kind: 'browser_tests', caseKeys: ['plan:home'], planVersions: [{ itemId: 'plan', version: 1 }] } };
  const attempt = { id: 'browser-attempt', task_id: task.id, kind: 'browser_tests', status: 'completed', dispatch_id: 'job', operation_id: 'browser',
    created_at: start, finished_at: finish, lease_until: null, plan_revision: 1, mandate_revision: 1, supplement_round: 0, usage: { tokens: 12 }, iris_model_ledger: irisLedger() };
  const run = { id: 'run', item_id: 'plan', case_id: 'home', plan_version: 1, snapshot: { id: 'home', type: 'browser', steps: ['Open homepage'], expected: 'Page readable' },
    mission_attempt_id: attempt.id, runtime, target, started_at: start, finished_at: finish,
    result: { schemaVersion: 2, outcome: 'passed', remaining: [], checks: [{ id: 'step-1', status: 'verified', actual: 'Page returned 200 and DOM content' }] } };
  const trace = { version: 1, browserJobId: 'job', callId: 'call', execution: { attemptId: attempt.id, dispatchId: 'job' }, action: 'open', fromUrl: 'about:blank',
    toUrl: PUBLIC_URL, startedAt: start, finishedAt: finish, outcome: 'observed', httpStatus: 200, observation: { text: 'Example Domain', headings: ['Example Domain'], truncated: false } };
  const traceBytes = Buffer.from(JSON.stringify(trace)), pngBytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const capture = (id, producer, bytes) => ({ id: `capture-${id}`, run_id: run.id, item_id: id, url: PUBLIC_URL, action: producer === 'browser-action' ? 'trace:open' : 'screenshot',
    version: 1, deleted_at: null, content: { kind: 'file', size: bytes.length }, provenance: { version: 1, origin: 'tool', producer, sourceType: 'test', sourceId: run.id, sha256: sha256(bytes) } });
  const traceCapture = capture('trace', 'browser-action', traceBytes), pngCapture = capture('png', 'test-capture', pngBytes);
  const review = { id: 'review', run_id: run.id, status: 'completed', reviewer_version: '9', source_hash: sha256('source'), finished_at: finish,
    assessment: { verdict: 'supported', findings: [{ requirementId: 'step-1', verdict: 'supported', evidenceIds: ['trace'], gap: null }] },
    input: { schemaVersion: 2, runId: run.id, reportedResult: run.result, target, planVersion: 1, requirements: [{ id: 'step-1' }], evidence: [{ id: 'trace', itemId: 'trace', sha256: sha256(traceBytes), readStatus: 'read' }] } };
  review.input_hash = auditReviewInputHash(review.input);
  const state = { missions: [{ id: 'mission', runtime, lifecycle: 'closed', closure_reason: 'investigated', lease_until: null, plan_revision: 1, mandate_revision: 1,
    mandate: { target: { kind: 'public_url', url: PUBLIC_URL }, allowedOrigins: ['https://example.com'], repositoryUrls: [], consentIds: [], limits: { maxSupplementRounds: 2 } },
    config: { target, caseKeys: ['plan:home'] } }],
  tasks: [task, { id: 'review-task', state: 'completed', spec: { kind: 'review', runIds: ['run'] } }, { id: 'report-task', state: 'completed' }, { id: 'plan-task', state: 'completed' }],
  attempts: [attempt, ...['review', 'report', 'planning'].map(kind => ({ id: `${kind}-attempt`, task_id: kind === 'planning' ? 'plan-task' : `${kind}-task`, kind,
    status: 'completed', finished_at: finish, lease_until: null, executor_resource_id: kind === 'report' ? 'report' : null, usage: { provider } }))],
  runs: [run], reviews: [review], jobs: [{ id: 'job', status: 'completed', dispatch_lease_until: null }],
  captures: [traceCapture, pngCapture], versions: [{ item_id: 'plan', version: 1, created_at: start }], browsers: [], claims: [], events: [], repositories: [], setups: [],
  reports: [{ id: 'report', status: 'completed', item_id: 'report-item', lease_until: null,
    document: { partial: false, findings: [{ verdict: 'supported', evidenceIds: ['item:trace'] }], tests: [{ runId: 'run', originalOutcome: 'passed', status: 'passed', review: 'supported' }],
      evidence: [{ id: 'item:trace', itemId: 'trace', read: true }] }, read_receipts: [{ id: 'item:trace', limited: false, digest: sha256(traceBytes) }] }],
  reportItems: [{ id: 'report-item', version: 1, deleted_at: null }] };
  const context = { runtime, byteEvidence: new Set(['trace', 'png']), traces: [{ capture: traceCapture, trace }],
    reviewerPolicy: { reviewerVersion: '9', hashVersion: 2, sourceSha256: sha256('frozen-reviewer') } };
  return { state, context, traceBytes, pngBytes };
}

test('command boundary is fixed public homepage and finite observation; no arbitrary URL/options', () => {
  assert.deepEqual(publicUrlOptions(['--audit']), { mode: '--audit', repetitions: 1, observationSeconds: 1500, url: PUBLIC_URL, prompt: PUBLIC_PROMPT });
  assert.equal(publicUrlOptions(['--execute', '--repetitions=3', '--observation-seconds=60']).repetitions, 3);
  for (const args of [[], ['--execute', '--audit'], ['--execute', '--url=http://127.0.0.1'], ['--execute', '--repetitions=4'], ['--execute', '--observation-seconds=1501'], ['--execute', '--repetitions=1', '--repetitions=2']]) assert.throws(() => publicUrlOptions(args));
});

test('actual chain requires physical receipts and complete versioned bytes, but never awards prose/full gate', () => {
  const { state, context, traceBytes, pngBytes } = example();
  assert.equal(auditPublicBytes(state.captures[0], traceBytes, state).trace.toUrl, PUBLIC_URL);
  assert.equal(auditPublicBytes(state.captures[1], pngBytes, state), null);
  const result = auditPublicCompletion(state, context);
  assert.deepEqual(result.currentRunIds, ['run']); assert.equal(result.irisReceipts.length, 1); assert.equal(result.irisReceipts[0].providerCalls, 1); assert.equal(result.irisReceipts[0].totalTokens, 12); assert.equal(result.fullGate, false); assert.equal(result.reportProse, 'independent_review_pending');
});

test('public oracle refuses navigation, forms, fabricated successful reads and changed origin', () => {
  for (const mutate of [v => { v.context.traces[0].trace.action = 'click'; }, v => { v.context.traces[0].trace.toUrl = 'https://example.com/other'; },
    v => { v.context.traces[0].trace.toUrl = 'https://qa-fixture.test/'; }, v => { v.context.traces[0].trace.httpStatus = 403; },
    v => { v.context.traces[0].trace.observation.truncated = true; }, v => { v.context.traces[0].trace.observation.text = ''; },
    v => { v.state.missions[0].mandate.allowedOrigins.push('https://other.test'); }, v => { v.context.traces.push({ trace: { action: 'fill' } }); }]) {
    const value = example(); mutate(value); assert.throws(() => auditPublicCompletion(value.state, value.context));
  }
});

test('provider absent/invalid/zero cannot become a physical planner, reviewer or report pass', () => {
  for (const kind of ['planning', 'review', 'report']) for (const usage of [{}, { provider: { providerCalls: 1 } }, { provider: { providerCalls: 0, unknownCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: null, cacheWriteTokens: null, durationMs: 0 } }]) {
    const { state, context } = example(); state.attempts.find(a => a.kind === kind).usage = usage; assert.throws(() => auditPublicCompletion(state, context));
  }
  const { state, context } = example(); state.attempts.find(a => a.kind === 'report').executor_resource_id = 'other-report'; assert.throws(() => auditPublicCompletion(state, context));
});

test('unknown measured tokens remain unknown but a validated physical call count is still observed', () => {
  const { state, context } = example(); for (const a of state.attempts) a.usage = { provider: { providerCalls: 1, unknownCalls: 1, inputTokens: 10, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, durationMs: 20 } };
  state.attempts[0].iris_model_ledger = irisLedger({ outputTokens: null });
  const result = auditPublicCompletion(state, context); assert.equal(result.fullGate, false); assert.equal(result.irisReceipts[0].totalTokens, null); assert.equal(result.irisReceipts[0].unknownCalls, 1);
});

test('stale review, missing screenshot, foreign run, unread report receipt and changed bytes never pass', () => {
  for (const mutate of [v => { v.state.reviews[0].reviewer_version = '8'; }, v => { v.context.byteEvidence.delete('png'); },
    v => { v.state.reviews[0].input.runId = 'other-run'; v.state.reviews[0].input_hash = auditReviewInputHash(v.state.reviews[0].input); },
    v => { v.state.reports[0].read_receipts[0].limited = true; }, v => { v.state.reports[0].read_receipts[0].digest = '0'.repeat(64); },
    v => { v.state.reports[0].document.tests.push({ runId: 'other' }); }, v => { v.state.reports[0].document.partial = true; }]) {
    const value = example(); mutate(value); assert.throws(() => auditPublicCompletion(value.state, value.context));
  }
  const { state, traceBytes, pngBytes } = example();
  assert.throws(() => auditPublicBytes(state.captures[0], Buffer.concat([traceBytes, Buffer.from('changed')]), state));
  state.captures[1].provenance.sourceId = 'other'; assert.throws(() => auditPublicBytes(state.captures[1], pngBytes, state));
});

test('closed alone is insufficient when execution/resources remain or mode expanded', () => {
  for (const mutate of [v => { v.state.claims.push({}); }, v => { v.state.jobs[0].status = 'cancelling'; }, v => { v.state.jobs = []; },
    v => { v.state.browsers.push({ session_id: 'active' }); }, v => { v.state.setups.push({}); }, v => { v.state.repositories.push({}); },
    v => { v.state.attempts[0].lease_until = finish; }, v => { v.state.tasks[0].state = 'running'; }]) {
    const value = example(); mutate(value); assert.throws(() => auditPublicCompletion(value.state, value.context));
  }
});

test('a correctly reported and reviewed product defect remains a conclusive QA outcome', () => {
  const { state, context } = example(); state.runs[0].result.outcome = 'failed'; state.runs[0].result.checks[0].status = 'mismatch';
  state.reviews[0].input_hash = auditReviewInputHash(state.reviews[0].input);
  Object.assign(state.reports[0].document.tests[0], { originalOutcome: 'failed', status: 'failed' });
  assert.equal(auditPublicCompletion(state, context).verifiedDefects.length, 1);
});

test('snapshot helper selects only inside an explicit read-only repeatable-read transaction', async () => {
  const queries = []; const tx = async (strings, ...values) => { const query = strings.join('?'); queries.push({ query, values }); assert.match(query, /^select /i); return []; };
  const sql = { begin: async (mode, callback) => { assert.equal(mode, 'isolation level repeatable read read only'); return callback(tx); } };
  const state = await observePublicUrl(sql, 'workspace', 'autonomy-test:public-unit');
  assert.equal(queries.length, 15); assert.ok(Object.values(state).every(rows => rows.length === 0));
  assert.ok(queries.every(q => q.values.includes('workspace')));
  const attemptQuery = queries.find(q => q.query.includes('from pat_mission_attempts'));
  assert.match(attemptQuery.query, /jsonb_array_elements_text\(a.tool_call_ids\)/);
  assert.match(attemptQuery.query, /where marker.value like 'server:iris-model:%'/);
  assert.match(attemptQuery.query, /as iris_model_ledger/);
  assert.match(attemptQuery.query, /m.runtime=\?/);
});


test('PUBLIC v2 freezes the actual Iris parser without changing the public request', () => {
  assert.equal(PUBLIC_URL_PROTOCOL, 'syna-public-url-acceptance-v2'); assert.ok(PUBLIC_CODE_FILES.includes('shared/browser-job.ts'));
  const b = Buffer.from('frozen parser'), changed = Buffer.from('other parser');
  assert.deepEqual(publicIrisLedgerPolicy(b, b, b), { version: 1, sourceSha256: sha256(b) });
  for (const input of [[b, changed, b], [changed, b, b], [b, b, changed]]) assert.throws(() => publicIrisLedgerPolicy(...input));
});

test('Iris requires exact durable starts and immutable receipts, never a plausible aggregate alone', () => {
  for (const ledger of [undefined, [], ['server:iris-model:start:' + callId], [irisLedger()[1]], ['arbitrary'],
    ['server:iris-model:start:invalid', irisLedger()[1]], [irisLedger()[0], 'server:iris-model:usage:{invalid'],
    [...irisLedger(), irisLedger({ outputTokens: 9 })[1]]]) {
    const { state, context } = example(); state.attempts[0].iris_model_ledger = ledger;
    state.attempts[0].usage.provider = { providerCalls: 12, unknownCalls: 0, inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: null, cacheWriteTokens: null, durationMs: 20 };
    assert.throws(() => auditPublicCompletion(state, context));
  }
  const { state, context } = example(); state.attempts[0].usage.tokens = 13; assert.throws(() => auditPublicCompletion(state, context), /disagrees/);
});

test('unknown receipt components stay null and duplicate immutable markers never multiply calls', () => {
  const { state } = example(), attempt = state.attempts[0]; attempt.iris_model_ledger.push(...irisLedger());
  const known = publicIrisReceipt(attempt); assert.equal(known.providerCalls, 1); assert.equal(known.totalTokens, 12); assert.equal(known.cacheReadTokens, null);
  attempt.iris_model_ledger = irisLedger({ inputTokens: null, outputTokens: null }); attempt.usage.tokens = null;
  const unknown = publicIrisReceipt(attempt); assert.equal(unknown.providerCalls, 1); assert.equal(unknown.totalTokens, null);
  assert.equal(unknown.inputTokens, null); assert.equal(unknown.outputTokens, null); assert.equal(unknown.unknownCalls, 1);
  attempt.iris_model_ledger.push('server:iris-model:start:22222222-2222-4222-8222-222222222222');
  assert.equal(publicIrisReceipt(attempt).unknownCalls, 2);
});


test('mixed known receipts and unfinished physical starts never expose measured subtotals as complete totals', () => {
  const { state } = example(), attempt = state.attempts[0];
  attempt.iris_model_ledger.push('server:iris-model:start:22222222-2222-4222-8222-222222222222');
  const value = publicIrisReceipt(attempt); assert.equal(value.providerCalls, 2); assert.equal(value.knownCalls, 1); assert.equal(value.unknownCalls, 1);
  for (const field of ['totalTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'durationMs']) assert.equal(value[field], null, field);
});
