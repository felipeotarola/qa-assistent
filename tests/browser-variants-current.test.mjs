import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { auditBrowserCurrentRuns, freezeBrowserReviewPolicy } from './helpers/browser-variants-current.mjs';
import { auditReviewInputHash } from './helpers/autonomy-web-audit.mjs';
import { auditBrowserVariant } from './helpers/browser-variants-protocol.mjs';
import { example, complement, report, clone, time, hash } from './browser-variants-current-fixture.mjs';

const value = () => { const v = example(); for (const a of v.state.attempts) a.operation_id ??= a.id; v.context.runChecksPolicy = { version: 1, sourceSha256: hash }; v.context.protocol = { schemaVersion: 4, variant: 'normal' }; return v; };
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
const digest = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');

function oracleInput(v) {
  const mission = v.state.missions[0], origin = new URL(mission.config.target.url).origin;
  mission.id = '00000001-0000-4000-8000-000000000000'; mission.workspace_id = '00000002-0000-4000-8000-000000000000';
  for (const row of v.context.history) for (const saved of row.missions ?? []) saved.id = mission.id;
  if (v.context.fault?.answer) { v.context.fault.answer.missionId = mission.id; const event = v.state.events.find(e => e.kind === 'control_answer'); event.action_hash = digest(v.context.fault.answer); }
  v.state.tasks.push({ id: 'final-task', state: 'completed', plan_revision: 1, spec: { kind: 'report', purpose: 'final' } });
  v.state.attempts.push({ id: 'final-attempt', task_id: 'final-task', kind: 'report', status: 'completed', operation_id: 'report:final:1', executor_resource_id: 'report', mandate_revision: 1, plan_revision: 1, finished_at: time(20), lease_until: null });
  v.state.reportBindings = [{ id: 'report', mission_id: mission.id, snapshot_id: '00000003-0000-4000-8000-000000000000', snapshot_hash: hash,
    snapshot_mission_id: mission.id, snapshot_workspace_id: mission.workspace_id, purpose: 'final', captured_at: time(19) }];
  v.state.events.push({ kind: 'report_requested', created_at: time(18) });
  mission.admission = { target: { url: mission.config.target.url } }; v.state.reportItems = [{ id: 'report-item', version: 1, deleted_at: null }];
  v.context.protocol = { ...v.context.protocol, taskId: 'WEB-02', targetUrl: mission.config.target.url, externalReview: { reportProse: 'pending' } };
  const checks = v.context.oracle.observations.map((check, i) => ({ id: `oracle-${i}`, action: check.action, toPath: check.toPath, status: check.status,
    heading: check.text, visibleText: [check.text], classification: check.status === 404 ? 'known_defect' : 'known_working' }));
  v.context.oracle = { origin, tasks: [{ taskId: 'WEB-02', checks }] };
  for (const row of v.context.traces) { row.trace.observation.headings = [row.trace.observation.text]; row.trace.observation.truncated = false; }
  return v;
}
test('full v4 browser oracle accepts only exact latest runs after bounded P3 and reports its scope', () => {
  const v = value(); complement(v); oracleInput(v);
  const result = auditBrowserVariant(v.state, v.context);
  assert.equal(result.matches.length, 2); assert.equal(result.complements.length, 1); assert.equal(result.reviewScope.semanticCoverage, 'independent_review_pending');
  const replaced = clone(v.state); replaced.reports[0].document.tests[0].runId = 'run-home';
  assert.throws(() => auditBrowserVariant(replaced, v.context), /current exact selected runs/);
});

test('v4 uses exact current reviews and unchanged original case requirements', () => {
  const v = value(), result = auditBrowserCurrentRuns(v.state, v.context);
  assert.equal(result.currentRuns.length, 2); assert.equal(result.currentReviews.length, 2); assert.equal(result.complements.length, 0);
});
test('v4 preserves typed two-round complements as separate original history', () => {
  const v = value(); complement(v); complement(v); const before = clone(v.state);
  const result = auditBrowserCurrentRuns(v.state, v.context);
  assert.equal(result.complements.length, 2); assert.equal(result.currentRuns.length, 2); assert.deepEqual(v.state, before);
});
for (const [name, corrupt] of [
  ['stale reviewer', v => { v.state.reviews[0].reviewer_version = '9'; }],
  ['forged input hash', v => { v.state.reviews[0].input_hash = hash; }],
  ['foreign original plan case', v => { v.state.runs[0].snapshot.expected = 'different requirement'; }],
  ['unread checkpoint proof', v => { v.context.byteEvidence.delete('trace-home'); }],
  ['narrowed final selection', v => { v.state.missions[0].config.caseKeys.pop(); }],
  ['changed original criterion', v => { v.state.missions[0].config.criteria[0].text = 'later'; }],
  ['after deadline', v => { v.state.attempts[0].deadline_at = time(1); }],
  ['orphan duplicate', v => { const r = clone(v.state.runs[0]); r.id += '-duplicate'; v.state.runs.push(r); }],
  ['orphan P3 event', v => { complement(v); v.state.events = []; }],
  ['changed P3 source hash', v => { complement(v).task.spec.complement.sourceHash = 'b'.repeat(64); }],
  ['third supplement', v => { complement(v); complement(v); complement(v); }],
  ['supported negative retested', v => { const c = complement(v, 'broken'); c.oldReview.assessment.verdict = 'supported'; for (const f of c.oldReview.assessment.findings) { f.verdict = 'supported'; f.evidenceIds = [c.oldReview.input.evidence[0].id]; f.gap = null; } }],
]) test(`v4 rejects ${name}`, () => { const v = value(); corrupt(v); assert.throws(() => auditBrowserCurrentRuns(v.state, v.context)); });

test('a newer incomplete review cannot be replaced by the older supported assessment', () => {
  const v = value(), newer = clone(v.state.reviews[0]); newer.id = 'newer'; newer.finished_at = time(10); newer.assessment.verdict = 'needs_evidence';
  newer.assessment.findings[0].verdict = 'needs_evidence'; newer.assessment.findings[0].evidenceIds = [];
  newer.assessment.findings[0].gap = { kind: 'missing_observation', capability: 'browser', wantedEvidence: 'Original checkpoint' };
  v.state.reviews.push(newer); assert.throws(() => auditBrowserCurrentRuns(v.state, v.context), /supporting assessment/);
});

function returned() {
  const v = value(), original = v.state.runs[0], oldAttempt = v.state.attempts[0], oldReview = v.state.reviews[0];
  const next = clone(original), review = clone(oldReview), now = 'physical-original';
  next.id = 'returned-run'; next.mission_attempt_id = 'returned-attempt'; next.started_at = time(5); next.finished_at = time(6); next.browser_entry_receipt = { sessionId: now };
  original.result = { ...original.result, outcome: 'blocked', checks: original.result.checks.map(c => ({ ...c, status: 'unverified' })) };
  oldReview.input.reportedResult = clone(original.result); oldReview.input_hash = auditReviewInputHash(oldReview.input); oldReview.assessment.verdict = 'needs_evidence';
  for (const f of oldReview.assessment.findings) { f.verdict = 'needs_evidence'; f.gap = { kind: 'missing_observation', capability: 'browser', wantedEvidence: 'Original checkpoint' }; f.evidenceIds = []; }
  oldAttempt.attempt_no = 1; oldAttempt.finished_at = time(3); v.state.jobs[0].session_id = 'original-channel';
  const wait = { id: 'wait', state: 'answered', created_at: time(3), answered_at: time(4), deadline_at: time(15), definition: { reason: 'human_browser', taskIds: [oldAttempt.task_id], planRevision: 1, mandateRevision: 1 } };
  v.state.waits = [wait]; v.state.browsers = [{ session_id: now, agent_id: 'original-channel', control: 'human' }];
  v.state.claims = [{ attempt_id: oldAttempt.id, executor_resource_id: now, state: 'claimed', owner: 'human' }];
  v.context.history.push({ at: time(3), ...clone(v.state) });
  v.state.browsers = []; v.state.claims = [];
  const answer = { action: 'answer', missionId: 'mission', waitId: 'wait', requestId: 'answer-request', expectedMandateRevision: 1, answer: { kind: 'browser_returned', sessionId: now } };
  v.context.protocol.variant = 'return-in-time'; v.context.fault = { attemptId: oldAttempt.id, waitId: wait.id, sessionId: now, answer, answeredAt: time(4), attemptStatusAtReturn: 'completed' };
  v.state.events.push({ kind: 'control_answer', event_key: 'control:answer-request', action_hash: digest(answer), payload: { waitId: wait.id }, created_at: time(4) });
  v.state.attempts.push({ ...clone(oldAttempt), id: 'returned-attempt', dispatch_id: 'returned-job', attempt_no: 2, created_at: time(5), finished_at: time(6) });
  v.state.jobs.push({ id: 'returned-job', session_id: 'returned-channel', status: 'completed' }); v.state.runs.push(next);
  review.id = 'returned-review'; review.run_id = next.id; review.finished_at = time(7); review.input.runId = next.id; review.input.reportedResult = clone(next.result);
  review.input.evidence = [{ id: 'returned-proof', itemId: 'returned-proof', readStatus: 'read', sha256: hash }];
  for (const finding of review.assessment.findings) finding.evidenceIds = ['returned-proof']; review.input_hash = auditReviewInputHash(review.input); v.state.reviews.push(review);
  v.state.captures.push({ item_id: 'returned-proof', run_id: next.id, provenance: { producer: 'browser-action', sha256: hash } }, { item_id: 'returned-png', run_id: next.id, provenance: { producer: 'test-capture', sha256: hash } });
  v.context.byteEvidence.add('returned-proof'); v.context.byteEvidence.add('returned-png');
  v.context.traces.push({ capture: v.state.captures.at(-2), trace: clone(v.context.traces[0].trace) });
  report(v.state, v.context); return v;
}
test('W1 preserves real original history and uses exact owner-return binding, never a fabricated P3 round', () => {
  const v = returned(), before = clone(v.state), result = auditBrowserCurrentRuns(v.state, v.context);
  assert.equal(result.complements.length, 0); assert.equal(result.humanResumptions.length, 1); assert.equal(result.currentRuns.length, 2);
  assert.ok(result.currentRuns.some(r => r.id === 'returned-run')); assert.deepEqual(v.state, before);
});
test('W1 accepts an atomic return whose database transaction started20ms before its saved answer', () => {
  const v = returned(), answerAt = Date.parse(v.state.waits[0].answered_at);
  v.state.events.at(-1).created_at = new Date(answerAt - 20).toISOString();
  v.context.fault.answeredAt = new Date(answerAt + 4).toISOString();
  const before = clone(v.state), result = auditBrowserCurrentRuns(v.state, v.context);
  assert.equal(result.humanAttemptContinuations.length, 1); assert.equal(result.humanResumptions.length, 1);
  assert.deepEqual(v.state, before);
});

// Same ordering as WEB4936: answer -> +4.701s old run settlement ->
// old attempt terminal -> successor reservation -> +123ms first terminal
// run observation -> successor START. No wall-clock tolerance is granted.
function activeSettlement() {
  const v = returned(), original = v.state.runs[0], old = v.state.attempts[0], next = v.state.attempts.at(-1), current = v.state.runs.at(-1);
  const answer = Date.parse(v.state.waits[0].answered_at), created = Date.parse(next.created_at), at = ms => new Date(ms).toISOString();
  v.context.fault.attemptStatusAtReturn = 'dispatching';
  original.finished_at = at(answer + 4701); old.finished_at = at(created - 19);
  current.started_at = at(created + 23207);
  const prior = v.context.history.at(-1);
  prior.runs[0].result = null; prior.runs[0].finished_at = null;
  prior.attempts[0].status = 'dispatching'; prior.attempts[0].finished_at = null; prior.jobs[0].status = 'running';
  const jobSettled = clone(prior); jobSettled.at = at(answer + 4806); jobSettled.jobs[0] = clone(v.state.jobs[0]);
  v.context.history.push(jobSettled);
  v.context.history.push({ at: at(created + 123), jobs: [clone(v.state.jobs[0])], attempts: [clone(old)], runs: [clone(original)] });
  return v;
}
test('W1 active settlement preserves the observed4701ms original delay and123ms reservation polling order', () => {
  for (const status of ['reserved', 'running', 'dispatching', 'dispatch_unknown']) {
    const v = activeSettlement(); v.context.fault.attemptStatusAtReturn = status;
    const before = clone(v.state), result = auditBrowserCurrentRuns(v.state, v.context);
    assert.equal(result.humanResumptions.length, 1); assert.equal(result.complements.length, 0);
    assert.equal(result.humanResumptions[0].originalRunId, v.state.runs[0].id);
    assert.deepEqual(v.state, before);
  }
});
for (const [name, corrupt, expected] of [
  ['old run finishes after successor reservation', v => { v.state.runs[0].finished_at = new Date(Date.parse(v.state.attempts.at(-1).created_at) + 1).toISOString(); }, /settle before successor/],
  ['old attempt finishes after successor reservation', v => { v.state.attempts[0].finished_at = new Date(Date.parse(v.state.attempts.at(-1).created_at) + 1).toISOString(); }, /settle before successor/],
  ['no terminal job observation before successor reservation', v => { v.context.history.at(-2).jobs[0].status = 'running'; }, /job was not terminal/],
  ['foreign terminal job observation', v => { v.context.history.at(-2).jobs[0].session_id = 'foreign-channel'; }, /job was not terminal/],
  ['no terminal original observation before successor START', v => { v.context.history.pop(); }, /not preserved before continuation/],
  ['terminal original first observed after successor START', v => { v.context.history.at(-1).at = new Date(Date.parse(v.state.runs.at(-1).started_at) + 1).toISOString(); }, /not preserved before continuation/],
  ['terminal return cannot borrow active settlement', v => { v.context.fault.attemptStatusAtReturn = 'completed'; }, /Terminal return cannot settle/],
  ['unknown return state cannot borrow active settlement', v => { v.context.fault.attemptStatusAtReturn = 'unknown'; }, /Terminal return cannot settle/],
  ['original result changed after first terminal observation', v => { v.state.runs[0].result.actual = 'new claim'; }, /history changed/],
]) test(`W1 active settlement rejects ${name}`, () => {
  const v = activeSettlement(); corrupt(v); assert.throws(() => auditBrowserCurrentRuns(v.state, v.context), expected);
});
for (const [name, corrupt] of [
  ['event before wait creation', v => { v.state.events.at(-1).created_at = new Date(Date.parse(v.state.waits[0].created_at) - 1).toISOString(); }],
  ['event after owner acknowledgment', v => { v.state.events.at(-1).created_at = new Date(Date.parse(v.context.fault.answeredAt) + 1).toISOString(); }],
  ['answer after owner acknowledgment', v => { v.context.fault.answeredAt = new Date(Date.parse(v.state.waits[0].answered_at) - 1).toISOString(); }],
  ['continuation before answer', v => { v.state.events.at(-1).created_at = new Date(Date.parse(v.state.waits[0].answered_at) - 20).toISOString(); v.state.attempts.at(-1).created_at = new Date(Date.parse(v.state.waits[0].answered_at) - 1).toISOString(); }],
  ['continuation before event', v => { const later = new Date(Date.parse(v.state.attempts.at(-1).created_at) + 1).toISOString(); v.state.events.at(-1).created_at = later; v.context.fault.answeredAt = later; }],
  ['active original cannot hide an early next attempt', v => { v.context.fault.attemptStatusAtReturn = 'running'; v.state.attempts.at(-1).created_at = new Date(Date.parse(v.state.waits[0].answered_at) - 1).toISOString(); }],
  ['missing owner acknowledgment', v => { delete v.context.fault.answeredAt; }],
  ['another request', v => { v.context.fault.answer.requestId = 'another-request'; }],
  ['another answered wait', v => { v.state.events.at(-1).payload.waitId = 'another-wait'; }],
]) test(`W1 atomic return rejects ${name}`, () => { const v = returned(); corrupt(v); assert.throws(() => auditBrowserCurrentRuns(v.state, v.context)); });
test('full v4 W1 oracle permits only the explicit saved same-operation continuation and exposes its receipt', () => {
  const v = oracleInput(returned());
  v.context.fault.confirmedAt = time(3); v.context.fault.answeredAt = time(4); v.context.fault.taskId = v.state.attempts[0].task_id;
  const result = auditBrowserVariant(v.state, v.context);
  assert.equal(result.matches.length, 2); assert.equal(result.humanAttemptContinuations.length, 1); assert.equal(result.humanResumptions.length, 1);
  const unrelated = value(); unrelated.state.attempts[1].operation_id = unrelated.state.attempts[0].operation_id;
  assert.throws(() => auditBrowserCurrentRuns(unrelated.state, unrelated.context), /duplicated without exact human continuation/);
});
for (const [name, corrupt] of [
  ['wrong answer hash', v => { v.state.events.at(-1).action_hash = hash; }],
  ['wrong original physical session', v => { v.state.runs.at(-1).browser_entry_receipt.sessionId = 'other'; }],
  ['late answer', v => { v.state.waits[0].answered_at = time(16); }],
  ['old result rewritten', v => { v.state.runs[0].result.actual = 'new claim'; }],
  ['unbounded second continuation', v => { v.state.attempts.push({ ...v.state.attempts.at(-1), id: 'another' }); }],
  ['original mismatch erased', v => { const old = v.state.runs[0]; old.result.checks[0].status = 'mismatch'; v.context.history.at(-1).runs[0] = clone(old); }],
]) test(`W1 rejects ${name}`, () => { const v = returned(); corrupt(v); assert.throws(() => auditBrowserCurrentRuns(v.state, v.context)); });

test('frozen policy checks both service reviewer bytes and exact authored checkpoint projection', () => {
  const reviewer = Buffer.from("export const REVIEWER_VERSION = '10';\nexport const REVIEW_HASH_VERSION = 2;\n"), checks = Buffer.from('same projection');
  const input = { reviewer: { web: reviewer, eve: reviewer }, runChecks: { authored: checks, web: checks, eve: checks } };
  const policy = freezeBrowserReviewPolicy(input); assert.deepEqual(freezeBrowserReviewPolicy(input, policy), policy);
  assert.throws(() => freezeBrowserReviewPolicy({ ...input, reviewer: { ...input.reviewer, eve: Buffer.from('changed') } }));
  assert.throws(() => freezeBrowserReviewPolicy({ ...input, runChecks: { ...input.runChecks, authored: Buffer.from('changed') } }));
});
