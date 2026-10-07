import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// Only the explicit v7 alternate representation consumes this in-memory proof.
// It is issued after actual evidence bytes pass auditTrace, not from JSON metadata.
const traceByteProofs = new WeakMap();
const terminal = new Set(['completed', 'failed', 'cancelled']);
const key = run => `${run.item_id}:${run.case_id}`;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => [name, canonical(child)])) : value;
const canonicalHash = value => sha256(JSON.stringify(canonical(JSON.parse(JSON.stringify(value)))));
// Protocol v5 binds the persisted JSONB representation, not pre-insert key order.
// Historical protocol v5 keeps its original reviewer 6 contract. Protocol v6
// passes an explicit policy bound to both verified frozen service sources.
export const auditReviewerVersion = '6';
export function frozenWebReviewerPolicy(bytes) {
  const source = bytes.toString('utf8');
  const versions = [...source.matchAll(/^export const REVIEWER_VERSION = '([0-9]+)';\r?$/gm)];
  const hashes = [...source.matchAll(/^export const REVIEW_HASH_VERSION = ([0-9]+);\r?$/gm)];
  assert.equal(versions.length, 1, 'Frozen reviewer version must be explicit and unambiguous');
  assert.equal(hashes.length, 1, 'Frozen review hash format must be explicit and unambiguous');
  assert.equal(hashes[0][1], '2', 'Oracle does not support this review hash format');
  return { reviewerVersion: versions[0][1], hashVersion: 2, sourceSha256: sha256(bytes) };
}
export const auditReviewInputHash = value => sha256(`review-input-v2\n${JSON.stringify(canonical(JSON.parse(JSON.stringify(value))))}`);
const validTime = value => value != null && Number.isFinite(new Date(value).getTime());
const currentReview = (state, runId) => state.reviews.filter(row => row.run_id === runId && row.status === 'completed')
  .sort((a, b) => Date.parse(b.finished_at) - Date.parse(a.finished_at) || b.id.localeCompare(a.id))[0];
const runIdentity = run => ({ id: run.id, item_id: run.item_id, case_id: run.case_id, plan_version: run.plan_version,
  mission_attempt_id: run.mission_attempt_id, runtime: run.runtime, snapshot: run.snapshot, target: run.target,
  result: run.result, started_at: new Date(run.started_at).toISOString(), finished_at: new Date(run.finished_at).toISOString() });

function readProof(state, review, run, finding, byteEvidence) {
  return finding.evidenceIds.some(id => review.input.evidence.some(evidence => evidence.id === id && evidence.readStatus === 'read'
    && byteEvidence.has(evidence.itemId) && state.captures.some(capture => capture.item_id === evidence.itemId && capture.run_id === run.id
      && capture.provenance?.sha256 === evidence.sha256 && /^[a-f0-9]{64}$/.test(evidence.sha256 || ''))));
}

function checkReview(state, review, run, byteEvidence, supported, reviewerVersion) {
  assert.ok(review?.status === 'completed' && review.assessment, 'Result lacks a completed assessment');
  assert.equal(review.reviewer_version, reviewerVersion, 'Review differs from the frozen reviewer policy');
  assert.equal(review.input.schemaVersion, 2); assert.equal(review.input.runId, run.id);
  assert.equal(review.input_hash, auditReviewInputHash(review.input), 'Persisted review input does not match its canonical hash');
  assert.match(review.source_hash, /^[a-f0-9]{64}$/);
  assert.ok(validTime(review.finished_at) && Date.parse(review.finished_at) >= Date.parse(run.finished_at), 'Review predates the finished result');
  assert.deepEqual(review.input.reportedResult, run.result, 'Review refers to a different result');
  assert.deepEqual(review.input.target, run.target); assert.equal(review.input.planVersion, run.plan_version);
  assert.deepEqual(review.assessment.findings.map(row => row.requirementId).sort(), review.input.requirements.map(row => row.id).sort(), 'Review skipped a checkpoint');
  assert.equal(new Set(review.assessment.findings.map(row => row.requirementId)).size, review.assessment.findings.length, 'Ambiguous review checkpoint');
  assert.deepEqual(run.result.checks.map(row => row.id).sort(), review.input.requirements.map(row => row.id).sort(), 'Result omitted an original checkpoint');
  const findings = review.assessment.findings;
  const verdict = findings.some(row => row.verdict === 'contradicted') ? 'contradicted' : findings.some(row => row.verdict === 'needs_evidence') ? 'needs_evidence' : 'supported';
  assert.equal(review.assessment.verdict, verdict, 'Assessment summary contradicts its checkpoints');
  for (const finding of findings) {
    assert.ok(['supported', 'needs_evidence', 'contradicted'].includes(finding.verdict), 'Unknown checkpoint verdict');
    assert.ok(finding.evidenceIds.every(id => review.input.evidence.some(evidence => evidence.id === id && evidence.readStatus === 'read')), 'Checkpoint cites unread evidence');
    if (finding.verdict !== 'needs_evidence') {
      assert.equal(finding.gap, null, 'Conclusive finding cannot authorize further execution');
      assert.ok(readProof(state, review, run, finding, byteEvidence), 'Conclusive checkpoint lacks actual saved evidence bytes');
    }
  }
  if (supported) {
    assert.equal(review.assessment.verdict, 'supported', 'The current case result lacks a supporting assessment');
    assert.ok(review.assessment.findings.length && review.assessment.findings.every(row => row.verdict === 'supported' && readProof(state, review, run, row, byteEvidence)), 'Checkpoint lacks a read receipt for actual saved evidence');
    assert.ok(run.result.checks.every(row => ['verified', 'mismatch'].includes(row.status)), 'Current result has unresolved checkpoints');
    assert.ok(!(run.result.remaining?.length), 'Current result still has remaining work');
  }
}

/** A second run is authorized only by the separately persisted server-issued
 * gap/task/event chain. This function never authorizes product execution. */
export function auditBoundedWebRuns(state, { runtime, byteEvidence, history = [], reviewerPolicy }) {
  if (reviewerPolicy) {
    assert.match(reviewerPolicy.reviewerVersion, /^[0-9]+$/); assert.equal(reviewerPolicy.hashVersion, 2);
    assert.match(reviewerPolicy.sourceSha256, /^[a-f0-9]{64}$/);
  }
  const reviewerVersion = reviewerPolicy?.reviewerVersion ?? auditReviewerVersion;
  const mission = state.missions[0], chosen = mission.config.caseKeys;
  assert.ok(chosen.length > 0); assert.equal(new Set(chosen).size, chosen.length);
  assert.deepEqual([...new Set(state.runs.map(key))].sort(), [...chosen].sort(), 'Runs do not match the selected cases');
  for (const rows of [state.runs, state.tasks, state.attempts, state.reviews]) assert.equal(new Set(rows.map(row => row.id)).size, rows.length, 'Duplicate persisted identity');
  assert.ok(Number.isInteger(mission.plan_revision) && mission.plan_revision > 0 && Number.isInteger(mission.mandate_revision) && mission.mandate_revision > 0, 'Missing current plan/mandate epoch');
  const currentRuns = [], complements = [], verifiedDefects = [];
  for (const caseKey of chosen) {
    const runs = state.runs.filter(run => key(run) === caseKey).sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at) || a.id.localeCompare(b.id));
    assert.ok(runs.length >= 1 && runs.length <= 3, 'A case exceeded initial run plus two bounded complements');
    const taskIds = new Set(), chain = [];
    for (const [index, run] of runs.entries()) {
      assert.ok(validTime(run.started_at) && validTime(run.finished_at) && Date.parse(run.finished_at) >= Date.parse(run.started_at) && run.result, 'Unfinished test run is not a complementable result');
      assert.equal(run.result.schemaVersion, 2); assert.equal(run.runtime, runtime); assert.deepEqual(run.target, mission.config.target);
      const attempt = state.attempts.find(row => row.id === run.mission_attempt_id && row.kind === 'browser_tests');
      const task = attempt && state.tasks.find(row => row.id === attempt.task_id);
      assert.ok(task?.spec?.caseKeys.includes(caseKey), 'Test is outside its bound browser task');
      assert.ok(!taskIds.has(task.id), 'Same task executed the case twice without a separate complement'); taskIds.add(task.id);
      assert.equal(task.plan_revision, mission.plan_revision); assert.equal(attempt.plan_revision, mission.plan_revision);
      assert.equal(attempt.mandate_revision, mission.mandate_revision); assert.equal(task.supplement_round, index); assert.equal(attempt.supplement_round, index);
      assert.ok(task.spec.planVersions?.some(plan => plan.itemId === run.item_id && plan.version === run.plan_version), 'Test used an unfrozen plan version');
      const planVersion = state.versions.find(row => row.item_id === run.item_id && row.version === run.plan_version);
      assert.ok(planVersion && Date.parse(planVersion.created_at) <= Date.parse(run.started_at), 'Plan was not persisted before execution');
      assert.ok(validTime(attempt.created_at) && validTime(task.created_at) && Date.parse(task.created_at) <= Date.parse(attempt.created_at)
        && Date.parse(attempt.created_at) <= Date.parse(run.started_at), 'Execution predates its persisted authorization');
      const review = currentReview(state, run.id); checkReview(state, review, run, byteEvidence, index === runs.length - 1, reviewerVersion);
      if (index === 0) assert.ok(!task.spec.complement, 'Initial case cannot begin as an orphan complement');
      else {
        const previous = chain[index - 1], binding = task.spec.complement;
        assert.ok(binding && binding.version === 1, 'Duplicate run lacks a typed server complement binding');
        assert.ok(index <= 2 && index <= mission.mandate?.limits?.maxSupplementRounds, 'Complement exceeded the locked mandate');
        assert.equal(binding.sourceTaskId, previous.task.id); assert.equal(binding.sourceAttemptId, previous.attempt.id);
        assert.equal(binding.runId, previous.run.id); assert.equal(binding.caseKey, caseKey); assert.equal(binding.planRevision, mission.plan_revision);
        assert.equal(binding.assessmentId, previous.review.id); assert.equal(binding.inputHash, previous.review.input_hash);
        assert.equal(binding.sourceHash, previous.review.source_hash); assert.equal(binding.reviewerVersion, previous.review.reviewer_version);
        assert.equal(task.operation_id, `complement:${mission.plan_revision}:${caseKey}:${index}`);
        assert.equal(attempt.operation_id, task.operation_id);
        assert.deepEqual(task.spec.caseKeys, [caseKey]); assert.deepEqual(task.spec.target, previous.run.target);
        assert.deepEqual(task.spec.planVersions, [{ itemId: previous.run.item_id, version: previous.run.plan_version }]);
        assert.equal(run.plan_version, previous.run.plan_version); assert.deepEqual(run.snapshot, previous.run.snapshot, 'Complement changed the original requirement');
        assert.ok(['completed', 'failed'].includes(previous.attempt.status) && previous.attempt.finished_at && !previous.attempt.cancel_requested_at);
        assert.ok(!['blocked', 'cancelled'].includes(previous.run.result.outcome), 'Prerequisite/cancelled result cannot authorize retest');
        assert.equal(previous.review.assessment.verdict, 'needs_evidence', 'A supported or contradicted result cannot request this complement');
        assert.ok(!previous.run.result.observations?.some(row => row.kind === 'requirement_gap'), 'Unclear requirement cannot authorize browser execution');
        const gaps = previous.review.assessment.findings.filter(row => row.verdict === 'needs_evidence' && row.gap?.capability === 'browser');
        assert.ok(gaps.length && gaps.every(row => ['missing_observation', 'unverified_step'].includes(row.gap.kind)
          && typeof row.gap.wantedEvidence === 'string' && row.gap.wantedEvidence.trim()), 'Missing typed browser-resolvable gap');
        assert.ok(previous.review.assessment.findings.every(row => row.verdict !== 'contradicted' && (row.verdict === 'needs_evidence' ? row.gap : !row.gap)), 'Gap contradicts the saved assessment');
        const gapIds = gaps.map(row => canonicalHash({ planRevision: mission.plan_revision, caseKey, checkId: row.requirementId, kind: row.gap.kind })).sort();
        assert.deepEqual(binding.gapIds, gapIds, 'Gap identity differs from the original reviewed checkpoints');
        const reviewTask = state.tasks.find(row => row.spec?.kind === 'review' && row.spec.runIds.includes(previous.run.id) && row.state === 'completed' && row.plan_revision === mission.plan_revision && task.depends_on?.includes(row.id));
        assert.ok(reviewTask, 'Complement has no completed review dependency');
        const events = (state.events || []).filter(row => row.kind === 'complement_planned' && row.payload.taskId === task.id);
        assert.equal(events.length, 1, 'Complement lacks an unambiguous committed server event');
        const event = events[0]; assert.equal(event.event_key, `complement-considered:${previous.review.id}:${previous.review.input_hash}`);
        assert.equal(event.payload.runId, previous.run.id); assert.equal(event.payload.assessmentId, previous.review.id);
        assert.equal(event.payload.caseKey, caseKey); assert.equal(event.payload.round, index); assert.equal(event.payload.reason, null);
        assert.ok(gapIds.every(id => event.payload.gapIds.includes(id)), 'Committed event does not contain the same gap');
        assert.ok(validTime(previous.review.finished_at) && Date.parse(previous.review.finished_at) <= Date.parse(task.created_at)
          && Date.parse(previous.run.finished_at) <= Date.parse(previous.review.finished_at) && Date.parse(event.created_at) <= Date.parse(attempt.created_at), 'Complement started before its result/review/event');
        const observed = history.find(snapshot => validTime(snapshot.at) && Date.parse(snapshot.at) <= Date.parse(task.created_at)
          && snapshot.runs?.some(row => row.id === previous.run.id && row.result && row.finished_at));
        assert.ok(observed, 'No prior observation preserves the original finished result before complement');
        assert.deepEqual(runIdentity(observed.runs.find(row => row.id === previous.run.id)), runIdentity(previous.run), 'Original result history was overwritten');
        complements.push({ caseKey, round: index, taskId: task.id, attemptId: attempt.id, sourceRunId: previous.run.id, runId: run.id, assessmentId: previous.review.id, gapIds });
      }
      for (const check of run.result.checks.filter(row => row.status === 'mismatch')) {
        const finding = review.assessment.findings.find(row => row.requirementId === check.id && row.verdict === 'supported');
        if (finding && readProof(state, review, run, finding, byteEvidence)) {
          for (const next of runs.slice(index + 1)) assert.equal(next.result?.checks?.find(row => row.id === check.id)?.status, 'mismatch', 'A verified defect was retested until green');
          verifiedDefects.push({ runId: run.id, caseKey, checkId: check.id });
        }
      }
      chain.push({ run, task, attempt, review });
    }
    const current = runs.at(-1); assert.ok(['passed', 'failed'].includes(current.result.outcome), 'Current selected case needs a conclusive outcome');
    assert.ok(state.captures.some(row => row.run_id === current.id && row.provenance?.producer === 'test-capture' && byteEvidence.has(row.item_id)), 'Current case lacks actual screenshot bytes');
    currentRuns.push(current);
  }
  return { currentRuns, complements, verifiedDefects };
}

// Public catalogue in the SHA-pinned fixture. This is the external oracle's
// knowledge; it is never included in the natural prompt or model input.
const products = [
  { name: 'Bryggkaffe', description: 'Mellanrostat kaffe, 500 g', price: '79 kr' },
  { name: 'Havrete', description: 'Rostat örtte, 100 g', price: '49 kr' },
  { name: 'Frukostmugg', description: 'Vit stengodsmugg, 30 cl', price: '119 kr' },
];
const literal = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sameRedactedText = (observed, expected) => new RegExp(`^${observed.split('[REDACTED]').map(literal).join('.+')}$`).test(expected);

/** Query values are deliberately unavailable. Verify a nonempty submitted
 * search and identifiable catalogue results, without guessing the hidden query. */
export function auditSearchObservation(observation) {
  if (!observation || observation.truncated) return null;
  const count = observation.text.match(/\b([0-9]+) produkter för [”"']?\[REDACTED\]/)?.[1];
  if (!count || Number(count) < 1 || Number(count) > products.length) return null;
  const lines = observation.text.split('\n').map(value => value.trim()).filter(Boolean);
  const matched = products.filter(product => observation.headings.some(heading => sameRedactedText(heading, product.name))
    && lines.some(line => sameRedactedText(line, product.description)) && lines.includes(product.price));
  if (matched.length !== Number(count)) return null;
  return { count: matched.length, products: matched.map(product => product.name), queryValueVerified: false };
}

function reportCitesTrace(report, finding, selected) {
  return finding.evidenceIds.some(id => report.document.evidence.some(evidence => evidence.id === id && evidence.itemId === selected.capture.item_id && evidence.read)
    && report.read_receipts.some(read => read.id === id && !read.limited && read.digest === selected.capture.provenance.sha256));
}

/** Structured report outcomes and actual reads are checkable without a second
 * LLM. This does not certify that arbitrary free-text prose has the same meaning. */
function exactKnown404(selected, expected, origin) {
  if (expected?.classification !== 'known_defect' || expected.status !== 404 || typeof expected.path !== 'string') return false;
  try {
    const from = new URL(selected.trace.fromUrl), to = new URL(selected.trace.toUrl), target = new URL(expected.path, origin);
    return target.origin === origin && from.origin === origin && to.href === target.href && selected.capture.url === target.href
      && selected.trace.action === 'click' && selected.trace.outcome === 'observed' && selected.trace.httpStatus === 404;
  } catch { return false; }
}
function supportedTraceCheckpoint(state, selected) {
  const run = state.runs.find(value => value.id === selected.capture.run_id), review = currentReview(state, run?.id);
  return run?.result?.checks?.find(check => ['verified', 'mismatch'].includes(check.status) && review?.assessment?.findings.some(finding => finding.requirementId === check.id
    && finding.verdict === 'supported' && finding.evidenceIds.some(id => review.input.evidence.some(evidence => evidence.id === id
      && evidence.itemId === selected.capture.item_id && evidence.readStatus === 'read' && evidence.sha256 === selected.capture.provenance.sha256))));
}
/** A negative observation can be correctly reported even when a narrow original
 * checkpoint was met. This is not semantic certification of the defect prose. */
function reviewedKnownDefect(state, selected, { expected, origin, byteEvidence }) {
  assert.ok(exactKnown404(selected, expected, origin), 'Alternate defect requires the exact known click-to-404, not a generic failure');
  assert.equal(traceByteProofs.get(selected), canonicalHash(selected), 'Alternate defect lacks unchanged independently checked trace bytes');
  assert.ok(byteEvidence.has(selected.capture.item_id), 'Alternate defect trace bytes are absent');
  assert.deepEqual(state.captures.find(capture => capture.item_id === selected.capture.item_id && capture.run_id === selected.capture.run_id), selected.capture, 'Alternate defect capture differs from persisted identity');
  const run = state.runs.find(value => value.id === selected.capture.run_id), review = currentReview(state, run?.id);
  assert.equal(run?.result?.outcome, 'failed', 'Alternate defect needs the actual saved negative outcome');
  assert.ok(run.result.observations?.some(observation => observation.kind === 'defect'), 'Alternate defect needs an explicit typed defect observation');
  assert.deepEqual(review?.input?.reportedResult, run.result, 'Alternate defect review addresses another result');
  assert.equal(review.input_hash, auditReviewInputHash(review.input), 'Alternate defect review input hash changed');
  const checkpoint = supportedTraceCheckpoint(state, selected);
  assert.ok(checkpoint, 'Alternate defect lacks a current supported checkpoint citing its read trace');
  return { oracleId: expected.id, runId: run.id, checkId: checkpoint.id, evidenceItemId: selected.capture.item_id,
    sourceOutcome: run.result.outcome, checkpointStatus: checkpoint.status, representation: 'typed_defect_with_reviewed_trace',
    semanticReview: 'independent_review_pending', limitation: 'Trace/run/review/report binding is machine checked. Independently verify that the defect prose concerns this action and destination; a typed label is not semantic proof.' };
}
function preserveKnownDefects(state, { oracle, traces, byteEvidence }) {
  const observations = [];
  for (const expected of oracle.expected.filter(value => value.classification === 'known_defect')) {
    for (const selected of traces.filter(value => exactKnown404(value, expected, oracle.origin))) {
      const run = state.runs.find(value => value.id === selected.capture.run_id);
      if (run?.result?.outcome !== 'failed' || !run.result.observations?.some(value => value.kind === 'defect') || !supportedTraceCheckpoint(state, selected)) continue;
      const receipt = reviewedKnownDefect(state, selected, { expected, origin: oracle.origin, byteEvidence });
      for (const later of state.runs.filter(value => key(value) === key(run) && Date.parse(value.started_at) > Date.parse(run.started_at))) {
        assert.equal(later.result?.outcome, 'failed', 'A reviewed known defect became a non-failing outcome in a complement');
        assert.ok(later.result.observations?.some(value => value.kind === 'defect'), 'A complement dropped the reviewed typed defect observation');
      }
      observations.push(receipt);
    }
  }
  return observations;
}

function auditReportedDefect(state, report, selected, options) {
  const run = state.runs.find(value => value.id === selected.capture.run_id);
  const review = currentReview(state, run.id);
  const mismatch = run.result.checks?.some(check => check.status === 'mismatch' && review.assessment.findings.some(finding => finding.requirementId === check.id
    && finding.verdict === 'supported' && finding.evidenceIds.some(id => review.input.evidence.some(evidence => evidence.id === id && evidence.itemId === selected.capture.item_id && evidence.readStatus === 'read'))));
  let negativeObservation = null;
  if (!mismatch && options?.defectPolicy === 'reviewed-known-defect-v1') negativeObservation = reviewedKnownDefect(state, selected, options);
  else assert.ok(mismatch, 'Known defect lacks a reviewed mismatch tied to its actual navigation trace');
  const reported = report.document.tests.filter(test => test.runId === run.id);
  assert.equal(reported.length, 1, 'Known defect must appear exactly once in the report test outcomes');
  assert.equal(reported[0].originalOutcome, 'failed'); assert.equal(reported[0].status, 'failed'); assert.equal(reported[0].review, 'supported');
  const criteria = state.missions[0].config.criteria.filter(criterion => criterion.delivery?.kind === 'test_cases' && criterion.delivery.caseKeys.includes(key(run)));
  assert.ok(criteria.length && criteria.some(criterion => report.document.findings.some(finding => finding.criterionId === criterion.id && finding.verdict === 'supported' && reportCitesTrace(report, finding, selected))), 'Report defect finding must cover the actual case and cite its read navigation trace');
  return negativeObservation;
}

export function webFaultReady(scenario, state) {
  if (scenario === 'controller-restart') return state.attempts.some(a => a.kind === 'discovery' && a.status === 'completed' && a.finished_at)
    && !state.attempts.some(a => a.kind !== 'discovery');
  return scenario === 'report-restart' && state.reports.some(r => r.status === 'running' && r.lease_until && !r.item_id && !r.finished_at);
}

/** Observe the stopped database state too: polling alone does not establish
 * that the process died before the next dispatch or report commit. */
export function auditWebFault(scenario, before, stopped, afterRuntime, beforeRuntime) {
  assert.ok(webFaultReady(scenario, before), 'Fault was not requested at its frozen boundary');
  assert.ok(webFaultReady(scenario, stopped), 'Worker passed the required fault boundary before termination');
  assert.notEqual(afterRuntime.web.pid, beforeRuntime.web.pid, 'The actual worker PID must change');
  assert.equal(afterRuntime.eve.pid, beforeRuntime.eve.pid, 'The independent scheduler must stay running');
  assert.equal(afterRuntime.sourceSha256, beforeRuntime.sourceSha256, 'Restart changed authored source');
  if (scenario === 'report-restart') {
    const row = before.reports.find(r => r.status === 'running' && !r.item_id);
    const after = stopped.reports.find(r => r.id === row.id);
    assert.equal(after?.status, 'running'); assert.equal(after.item_id, null);
    assert.equal(String(after.lease_until), String(row.lease_until), 'Report lease changed before termination');
  }
}

/** Read-only acceptance oracle. Traces have already been fetched through the
 * ordinary authenticated file API; no observations are sent to the model. */
export function auditWebCompletion(state, { runtime, oracle, traces, byteEvidence, history = [], reviewerPolicy, defectPolicy }) {
  assert.ok(defectPolicy === undefined || defectPolicy === 'reviewed-known-defect-v1', 'Unsupported defect representation policy');
  assert.equal(state.missions.length, 1, 'One request must create exactly one mission');
  const mission = state.missions[0];
  assert.equal(mission.lifecycle, 'closed'); assert.ok(['investigated', 'criteria_satisfied'].includes(mission.closure_reason));
  assert.equal(mission.lease_until, null, 'Controller lease leaked');
  assert.equal(state.claims.length, 0, 'Executor claim leaked');
  assert.ok(state.tasks.length && state.tasks.every(task => task.state === 'completed'), 'Unsettled or unfulfilled task remains');
  assert.ok(state.attempts.length && state.attempts.every(attempt => terminal.has(attempt.status) && !attempt.lease_until && attempt.finished_at), 'Active executor or lease remains');
  assert.ok(state.jobs.length && state.jobs.every(job => ['completed', 'failed'].includes(job.status) && !job.dispatch_lease_until), 'Iris did not settle or dispatch lease remains');
  assert.ok(state.browsers.every(browser => !browser.session_id), 'Browser resource remains assigned');
  const browserAttempts = state.attempts.filter(attempt => attempt.kind === 'browser_tests');
  assert.equal(state.jobs.length, browserAttempts.length);
  assert.equal(new Set(state.jobs.map(job => job.id)).size, state.jobs.length);
  for (const job of state.jobs) assert.ok(browserAttempts.some(attempt => attempt.dispatch_id === job.id), 'Unbound Iris job');
  const completedOperations = state.attempts.filter(attempt => attempt.status === 'completed').map(attempt => attempt.operation_id);
  assert.equal(new Set(completedOperations).size, completedOperations.length, 'Logical operation completed twice');

  const { currentRuns, complements, verifiedDefects } = auditBoundedWebRuns(state, { runtime, byteEvidence, history, reviewerPolicy });
  for (const job of state.jobs.filter(row => row.status === 'failed')) {
    const attempt = browserAttempts.find(row => row.dispatch_id === job.id), runs = state.runs.filter(row => row.mission_attempt_id === attempt.id);
    assert.ok(runs.length && runs.every(run => complements.some(complement => complement.sourceRunId === run.id)), 'Failed Iris job was not fully recovered by authorized complements');
  }

  const reports = state.reports.filter(report => report.status === 'completed' && report.item_id);
  assert.equal(reports.length, 1, 'Missing or duplicate saved report');
  assert.equal(state.reports.length, 1, 'Duplicate report request/version');
  const report = reports[0];
  assert.equal(report.document.partial, false, 'A partial report is not full-flow acceptance');
  assert.equal(report.lease_until, null);
  assert.ok(report.read_receipts.length > 0, 'Report has no evidence read receipts');
  assert.ok(report.document.findings.length && report.document.findings.every(finding => finding.verdict === 'supported' && finding.evidenceIds.length && finding.evidenceIds.every(id => report.read_receipts.some(read => read.id === id && !read.limited && read.digest && /^[a-f0-9]{64}$/.test(read.hash)))), 'Report cites unread or insufficient evidence');
  const items = state.reportItems.filter(item => item.id === report.item_id && !item.deleted_at);
  assert.equal(items.length, 1); assert.equal(items[0].version, 1, 'Duplicate report material version');
  assert.equal(state.reportItems.length, 1, 'Duplicate report material');
  for (const run of currentRuns) {
    const reported = report.document.tests.filter(row => row.runId === run.id);
    assert.equal(reported.length, 1, 'Report does not identify the latest authorized case result');
    assert.equal(reported[0].originalOutcome, run.result.outcome); assert.equal(reported[0].status, run.result.outcome); assert.equal(reported[0].review, 'supported');
  }
  for (const run of state.runs.filter(row => row.result.outcome !== 'passed' && !currentRuns.some(current => current.id === row.id))) {
    assert.ok(report.document.limitations?.some(text => text.includes(run.id)), 'Report discarded an earlier non-passing result instead of preserving history');
  }

  const knownDefectObservations = defectPolicy === 'reviewed-known-defect-v1'
    ? preserveKnownDefects(state, { oracle, traces, byteEvidence }) : [];
  const matched = [];
  for (const expected of oracle.expected) {
    const path = expected.path || '/';
    const candidates = traces.filter(({ capture, trace }) => {
      if (trace.outcome !== 'observed' || trace.httpStatus !== expected.status) return false;
      const url = new URL(capture.url), targetUrl = new URL(path, oracle.origin);
      for (const name of [...targetUrl.searchParams.keys()]) targetUrl.searchParams.set(name, '[REDACTED]');
      if (url.origin !== oracle.origin || url.pathname !== targetUrl.pathname || url.search !== targetUrl.search) return false;
      if (expected.id.startsWith('navigation_') || expected.id === 'broken_returns') return trace.action === 'click';
      if (expected.id === 'search') return ['click', 'press'].includes(trace.action);
      return trace.action === 'open';
    });
    const selected = candidates.find(({ capture, trace }) => {
      const observation = trace.observation;
      if (!observation) return false;
      if (expected.heading && !observation.headings.includes(expected.heading)) return false;
      if (expected.id === 'search') {
        if (!auditSearchObservation(observation)) return false;
      } else if (expected.productCount && !new RegExp(`\\b${expected.productCount} produkter\\b`).test(observation.text)) return false;
      const run = currentRuns.find(value => value.id === capture.run_id);
      if (!run || expected.classification === 'known_defect' && run.result.outcome !== 'failed') return false;
      const review = currentReview(state, run.id);
      return review?.assessment.verdict === 'supported' && review.assessment.findings.some(finding => finding.verdict === 'supported'
        && finding.evidenceIds.some(id => review.input.evidence.some(evidence => evidence.id === id && evidence.itemId === capture.item_id && evidence.readStatus === 'read')));
    });
    assert.ok(selected, `Known fixture check is not actually executed and reviewed: ${expected.id}`);
    if (expected.classification === 'known_defect') auditReportedDefect(state, report, selected, { defectPolicy, expected, origin: oracle.origin, byteEvidence });
    matched.push({ oracleId: expected.id, runId: selected.capture.run_id, evidenceItemId: selected.capture.item_id, callId: selected.trace.callId,
      ...(expected.id === 'search' ? { search: auditSearchObservation(selected.trace.observation) } : {}) });
  }
  assert.ok(currentRuns.some(run => run.result.outcome === 'passed'), 'Known functioning flow has no passing current test');
  return { report, matched, complements, verifiedDefects, ...(defectPolicy ? { knownDefectObservations } : {}) };
}

export function auditTrace(capture, bytes, state) {
  assert.equal(sha256(bytes), capture.provenance.sha256, 'Saved evidence bytes differ from attested hash');
  assert.equal(capture.provenance.sourceId, capture.run_id); assert.equal(capture.provenance.sourceType, 'test');
  assert.equal(capture.provenance.origin, 'tool');
  assert.equal(capture.provenance.producer, 'browser-action');
  const trace = JSON.parse(bytes);
  assert.equal(trace.version, 1);
  assert.equal(trace.toUrl, capture.url, 'Capture location differs from actual action trace');
  const run = state.runs.find(value => value.id === capture.run_id);
  assert.ok(run?.finished_at != null && run.result, 'Trace belongs to an unfinished test run');
  const attempt = state.attempts.find(value => value.id === run?.mission_attempt_id);
  assert.ok(attempt); assert.equal(trace.execution.attemptId, attempt.id); assert.equal(trace.execution.dispatchId, attempt.dispatch_id);
  assert.equal(trace.browserJobId, attempt.dispatch_id);
  assert.equal(capture.action, `trace:${trace.action}`);
  const times = [run.started_at, run.finished_at, trace.startedAt, trace.finishedAt];
  assert.ok(times.every(value => value != null && Number.isFinite(new Date(value).getTime())), 'Trace or test interval has an invalid timestamp');
  assert.ok(new Date(trace.startedAt) <= new Date(trace.finishedAt)
    && new Date(trace.startedAt) >= new Date(run.started_at) && new Date(trace.finishedAt) <= new Date(run.finished_at), 'Trace falls outside the test interval');
  const observation = { capture, trace };
  traceByteProofs.set(observation, canonicalHash(observation));
  return observation;
}
