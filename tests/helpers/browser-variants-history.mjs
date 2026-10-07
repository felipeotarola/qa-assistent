import assert from 'node:assert/strict';
import { auditBrowserVariant, hash } from './browser-variants-protocol.mjs';
import { regressionFingerprint, regressionOrigin, regressionPlan, regressionPlanTitle } from './browser-variants-regression.mjs';

export const actualRegressionHistoryProtocol = 'syna-browser-regression-actual-history-v1';
const time = value => { const n = value instanceof Date ? value.getTime() : value != null ? Date.parse(value) : NaN; assert.ok(Number.isFinite(n), 'Missing actual-history instant'); return n; };
const canonical = value => JSON.parse(JSON.stringify(value));
const key = run => `${run.item_id}:${run.case_id}`;
const rowHash = rows => regressionFingerprint([...rows].sort((a, b) => a.id.localeCompare(b.id)));

/** Source revision is computed before missions.bindResult adds task context.
 * A browser task and its review task may therefore cite identical source bytes
 * with different, legitimate contexts. Validate every test-source occurrence
 * against its immutable enclosing task and persisted mission/task scope before
 * comparing the entire remaining payload; no evidence field is ignored. */
export function boundRegressionSource(state, binding, runId) {
  assert.ok(typeof runId === 'string' && runId.length && binding, 'Missing regression source binding');
  const missions = state.missions.filter(row => row.id === binding.mission_id);
  assert.equal(missions.length, 1, 'Ambiguous regression snapshot mission');
  const mission = missions[0];
  assert.ok(typeof mission.id === 'string' && mission.id.length && typeof mission.runtime === 'string' && mission.runtime.length);
  assert.equal(binding.snapshot_mission_id, mission.id);
  assert.equal(binding.snapshot_workspace_id, mission.workspace_id);
  assert.ok(typeof mission.workspace_id === 'string' && mission.workspace_id.length);
  assert.ok(Array.isArray(binding.snapshot_tasks), 'Missing immutable source tasks');
  const tasks = binding.snapshot_tasks, ids = tasks.map(task => task.id);
  assert.ok(ids.every(id => typeof id === 'string' && id.length) && new Set(ids).size === ids.length, 'Ambiguous immutable source task');
  const candidates = [];
  for (const task of tasks) {
    const sources = (task.sources ?? []).filter(source => source.sourceType === 'test');
    if (!sources.length) continue;
    const persisted = state.tasks.filter(row => row.id === task.id);
    assert.equal(persisted.length, 1, 'Missing or ambiguous persisted source task');
    assert.equal(persisted[0].mission_id, mission.id, 'Source task belongs to another mission');
    assert.ok(typeof task.actor === 'string' && task.actor.length);
    assert.ok(task.parentId === null || (typeof task.parentId === 'string' && task.parentId.length));
    assert.ok(Array.isArray(task.criterionIds) && task.criterionIds.every(id => typeof id === 'string' && id.length));
    for (const source of sources) {
      assert.ok(typeof source.sourceId === 'string' && source.sourceId.length);
      assert.deepEqual(source.context, { resultId: `test:${source.sourceId}`, missionId: mission.id, taskId: task.id,
        workspaceId: mission.workspace_id, runtime: mission.runtime, actor: task.actor, parentId: task.parentId, criterionIds: task.criterionIds },
      'Source context does not match its immutable task parent');
      if (source.sourceId === runId) candidates.push(source);
    }
  }
  assert.ok(candidates.length, 'Missing regression source');
  const payload = source => Object.fromEntries(Object.entries(source).filter(([field]) => field !== 'context'));
  assert.ok(candidates.every(source => regressionFingerprint(payload(source)) === regressionFingerprint(payload(candidates[0]))), 'Conflicting regression source payload');
  assert.match(candidates[0].sourceRevision, /^[a-f0-9]{64}$/);
  return candidates[0];
}

/** Original requirements remain identical. Only the explicit target version is
 * different; there is no fabricated execution, review or historical outcome. */
export function actualRegressionPlan(caseIds, version) {
  const plan = regressionPlan(caseIds, version);
  plan.summary = `Två valda ursprungliga krav för webbversion ${version.toUpperCase()}. Resultat ska hämtas från de verkliga sparade körningarna för respektive version.`;
  return plan;
}

export function actualHistoryPrompt() {
  return `Testa webbplatsen ${regressionOrigin}/regression/a enligt planen ”${regressionPlanTitle}” i Material och rapportera resultatet.`;
}

// This oracle is private and hash-frozen with the helper; it is not served by
// the immutable fixture or included in either natural prompt.
export const actualHistoryOracle = Object.freeze({ origin: regressionOrigin, tasks: [{ taskId: 'WEB-04', checks: [
  { id: 'old_return_defect', action: 'click', fromPath: '/regression/a/article', toPath: '/regression/a/missing', heading: 'Sidan finns inte', status: 404,
    visibleText: ['Adressen saknas.', 'Webbversion A'], classification: 'known_defect' },
  { id: 'old_contact_unchanged', action: 'click', fromPath: '/regression/a', toPath: '/regression/a/contact', heading: 'Kontakt', status: 200,
    visibleText: ['besok@linden.example.test', 'Webbversion A'], classification: 'known_working' },
] }] });

export function actualHistoryExecutionProtocol(protocol) {
  assert.equal(protocol.taskId, 'WEB-04');
  const prompt = actualHistoryPrompt();
  return { ...protocol, variant: 'normal', prompt, promptSha256: hash(prompt), targetUrl: `${regressionOrigin}/regression/a`,
    observationSeconds: 1500, takeover: null, edit: null, stop: null, expectedDelivery: 'complete_investigation', historicalBaseline: null };
}

function checkIdentity(identity) {
  for (const key of ['workspaceId', 'userId', 'threadId', 'planId']) assert.match(identity[key] ?? '', /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  for (const key of ['sourceHash', 'fixtureSourceHash', 'harnessSha256', 'helperSha256']) assert.match(identity[key] ?? '', /^[a-f0-9]{64}$/);
  assert.match(identity.runtime, /^autonomy-test:[a-zA-Z0-9:_-]+$/); assert.ok(typeof identity.sessionId === 'string' && identity.sessionId.length > 0);
}

export function auditActualHistoryA(state, context, identity, plan) {
  checkIdentity(identity); const mission = state.missions[0];
  assert.equal(state.missions.length, 1); assert.equal(mission.workspace_id, identity.workspaceId); assert.equal(mission.user_id, identity.userId);
  assert.equal(mission.thread_id, identity.threadId); assert.equal(mission.runtime, identity.runtime); assert.ok(['explore', 'verify'].includes(mission.admission.intent), 'First A is QA against the selected plan, not an unsupported comparison');
  assert.deepEqual(plan, actualRegressionPlan(plan.cases.map(row => row.id), 'a'));
  const version = state.versions.find(row => row.item_id === identity.planId && row.version === 1);
  assert.ok(version); assert.deepEqual(version.content, plan);
  assert.deepEqual([...mission.admission.caseKeys].sort(), plan.cases.map(row => `${identity.planId}:${row.id}`).sort());
  assert.deepEqual([...mission.config.caseKeys].sort(), [...mission.admission.caseKeys].sort());
  assert.ok(state.runs.length && state.runs.every(run => run.item_id === identity.planId && run.plan_version === 1 && run.mission_attempt_id));
  const result = auditBrowserVariant(state, { ...context, runtime: identity.runtime, protocol: actualHistoryExecutionProtocol(context.protocol), oracle: actualHistoryOracle });
  assert.equal(result.matches.length, 2);
  assert.equal(new Set(result.matches.map(row => row.runId)).size, 2, 'Both original cases need their own actual A execution');
  assert.ok(result.matches.every(row => plan.cases.some(testCase => key(state.runs.find(run => run.id === row.runId)) === `${identity.planId}:${testCase.id}`)));
  return result;
}

/** Seal only after actual owner reads and the independently checked natural A
 * execution. A JSON flag such as "passed" is never accepted as proof later. */
export function sealActualRegressionHistory({ state, context, identity, plan, receipts, scheduler, acceptedAt, closedAt, ownerReport }) {
  const audited = auditActualHistoryA(state, context, identity, plan);
  assert.ok(time(acceptedAt) <= time(closedAt) && time(closedAt) - time(acceptedAt) <= 1500_000);
  for (const path of ['/api/internal/autonomy/drain', '/api/internal/result-reviews/drain', '/api/internal/mission-reports/drain']) {
    assert.ok(scheduler.some(row => row.path === path && row.method === 'POST' && row.status === 200 && time(row.timestamp) >= time(acceptedAt) && time(row.timestamp) <= time(closedAt)), 'Actual A scheduler receipt is missing');
  }
  const captures = state.captures.filter(row => state.runs.some(run => run.id === row.run_id));
  for (const capture of captures.filter(row => row.item_id && !row.deleted_at && ['browser-action', 'test-capture'].includes(row.provenance?.producer))) {
    const receipt = receipts.find(row => row.itemId === capture.item_id); assert.ok(receipt && receipt.sha256 === capture.provenance.sha256 && receipt.bytes > 0);
    assert.ok(receipt.denials?.length === 2 && receipt.denials.every(status => [401, 403, 404].includes(status)), 'A evidence privacy controls were not observed');
  }
  assert.equal(ownerReport?.reportId, audited.report.id); assert.equal(ownerReport.itemId, audited.report.item_id); assert.equal(ownerReport.stale, false);
  assert.equal(ownerReport.documentSha256, regressionFingerprint(audited.report.document));
  assert.ok(ownerReport.denials?.length === 2 && ownerReport.denials.every(status => [401, 403, 404].includes(status)), 'Actual A report privacy was not observed');
  const binding = state.reportBindings.find(row => row.id === ownerReport.reportId);
  for (const match of audited.matches) {
    boundRegressionSource(state, binding, match.runId);
  }
  return canonical({ protocol: actualRegressionHistoryProtocol, preparation: 'actual-natural-QA-A', identity, acceptedAt, closedAt,
    planId: identity.planId, beforeContent: plan, afterContent: actualRegressionPlan(plan.cases.map(row => row.id), 'b'),
    caseKeys: plan.cases.map(row => `${identity.planId}:${row.id}`), currentPlanVersion: 2,
    final: state, history: context.history, reviewerPolicy: context.reviewerPolicy, runChecksPolicy: context.runChecksPolicy,
    immutable: { runs: rowHash(state.runs), reviews: rowHash(state.reviews), captures: rowHash(captures) },
    runIds: state.runs.map(row => row.id), currentRunIds: [...new Set(audited.matches.map(row => row.runId))],
    receipts, scheduler, ownerReport, oracleMatches: audited.matches, reportScope: audited.reportScope,
    usageScope: 'Actual A preparation is excluded from B measured attempts and duration. Its saved attempt meters are separate; initiating V and monetary/end-to-end totals remain unknown, never inferred zero.',
    semanticReview: 'independent_review_pending' });
}

/** Import of this exact immutable A artifact into the same owned workspace.
 * It rechecks current DB rows and owner-read bytes; it never inserts/adopts an
 * execution or turns a synthetic record into an actual historical result. */
export function importActualRegressionHistory(bytes, expected, observed, reads, protocol) {
  assert.equal(hash(bytes), expected.artifactSha256, 'Actual A artifact changed'); const preparation = JSON.parse(bytes.toString());
  assert.equal(preparation.protocol, actualRegressionHistoryProtocol); assert.equal(preparation.preparation, 'actual-natural-QA-A');
  assert.deepEqual(preparation.identity, expected.identity); checkIdentity(preparation.identity);
  const oldIds = new Set(preparation.runIds), original = preparation.final;
  const mission = observed.missions.find(row => row.id === original.missions[0].id); assert.ok(mission);
  assert.deepEqual(canonical(mission), original.missions[0], 'Actual A persisted mission identity, original selection or terminal state changed');
  assert.equal(mission.lifecycle, 'closed');
  assert.deepEqual(observed.versions.find(row => row.item_id === preparation.planId && row.version === 1)?.content, preparation.beforeContent, 'Actual A plan version changed');
  const originalAttempts = new Set(original.attempts.map(row => row.id));
  const runs = observed.runs.filter(row => oldIds.has(row.id) || row.thread_id === preparation.identity.threadId || originalAttempts.has(row.mission_attempt_id));
  assert.equal(rowHash(runs), preparation.immutable.runs, 'Actual A results changed, disappeared or gained an undeclared execution');
  const reviews = observed.reviews.filter(row => oldIds.has(row.run_id));
  assert.equal(rowHash(reviews), preparation.immutable.reviews, 'Actual A reviews changed or disappeared');
  const captures = observed.captures.filter(row => oldIds.has(row.run_id)); assert.equal(rowHash(captures), preparation.immutable.captures, 'Actual A capture identities changed');
  // Scope to original mission/thread, not merely the IDs already known at
  // seal: new late jobs, attempts, reports or reviews must not disappear when
  // the B measurement projects A away. These are persisted fields only; the
  // deliberately changed current plan's computed report staleness is excluded.
  for (const table of ['tasks', 'attempts', 'waits', 'reports', 'reportBindings']) {
    assert.equal(rowHash(observed[table].filter(row => row.mission_id === mission.id)), rowHash(original[table]), `Actual A ${table} history changed`);
  }
  assert.equal(rowHash(observed.jobs.filter(row => row.thread_id === preparation.identity.threadId)), rowHash(original.jobs), 'Actual A browser-job history changed');
  const eventsHash = rows => regressionFingerprint(rows.map(regressionFingerprint).sort());
  assert.equal(eventsHash(observed.events.filter(row => row.mission_id === mission.id)), eventsHash(original.events), 'Actual A event history changed');
  const reportItems = new Set(original.reports.map(row => row.item_id).filter(Boolean));
  assert.equal(rowHash(observed.reportItems.filter(row => reportItems.has(row.id))), rowHash(original.reportItems), 'Actual A report material changed');
  for (const receipt of preparation.receipts) {
    const actual = reads.receipts.find(row => row.itemId === receipt.itemId);
    assert.ok(actual && actual.sha256 === receipt.sha256 && actual.bytes === receipt.bytes && actual.denials?.length === 2 && actual.denials.every(status => [401, 403, 404].includes(status)), 'Actual A bytes were not independently reread');
  }
  auditActualHistoryA(original, { ...reads, history: preparation.history, protocol, reviewerPolicy: preparation.reviewerPolicy, runChecksPolicy: preparation.runChecksPolicy }, preparation.identity, preparation.beforeContent);
  return preparation;
}

/** Exclude A's measured graph, not its existence. Every unexpected third
 * mission/run is rejected. Original A rows remain available to the immutable
 * import check and the report can reference them explicitly as historical. */
export function projectRegressionMission(state, preparation, threadId) {
  const old = preparation.final.missions[0], current = state.missions.filter(row => row.thread_id === threadId);
  assert.ok(current.length <= 1 && state.missions.every(row => row.id === old.id || row.thread_id === threadId), 'Unexpected mission beside actual A and measured B');
  assert.equal(state.missions.filter(row => row.id === old.id && row.lifecycle === 'closed').length, 1, 'Actual A mission is no longer closed');
  const ids = new Set(current.map(row => row.id)), tasks = state.tasks.filter(row => ids.has(row.mission_id)), attempts = state.attempts.filter(row => ids.has(row.mission_id));
  const attemptIds = new Set(attempts.map(row => row.id)), oldRunIds = new Set(preparation.runIds), runs = state.runs.filter(row => !oldRunIds.has(row.id));
  assert.ok(runs.every(row => attemptIds.has(row.mission_attempt_id)), 'Undeclared run is not part of A history or measured B');
  const runIds = new Set(runs.map(row => row.id)), reports = state.reports.filter(row => ids.has(row.mission_id));
  const reportIds = new Set(reports.map(row => row.id)), itemIds = new Set(reports.map(row => row.item_id).filter(Boolean));
  return { ...state, missions: current, tasks, attempts, runs, reviews: state.reviews.filter(row => runIds.has(row.run_id)),
    captures: state.captures.filter(row => runIds.has(row.run_id)), reports, reportBindings: state.reportBindings.filter(row => reportIds.has(row.id)),
    reportItems: state.reportItems.filter(row => itemIds.has(row.id)), jobs: state.jobs.filter(row => row.thread_id === threadId),
    waits: state.waits.filter(row => ids.has(row.mission_id)), events: state.events.filter(row => ids.has(row.mission_id)) };
}

export function auditActualRegressionB(state, preparation, report) {
  assert.equal(preparation.protocol, actualRegressionHistoryProtocol); const mission = state.missions[0];
  assert.notEqual(mission.id, preparation.final.missions[0].id); assert.notEqual(mission.thread_id, preparation.identity.threadId);
  for (const [field, original] of [['workspace_id', 'workspaceId'], ['user_id', 'userId'], ['runtime', 'runtime']]) assert.equal(mission[field], preparation.identity[original]);
  assert.equal(mission.admission.intent, 'regression'); assert.equal(mission.admission.target.url, `${regressionOrigin}/regression/b`);
  assert.deepEqual([...mission.admission.caseKeys].sort(), [...preparation.caseKeys].sort());
  const version = state.versions.find(row => row.item_id === preparation.planId && row.version === 2);
  assert.ok(version); assert.deepEqual(version.content, preparation.afterContent);
  for (const run of state.runs) { assert.equal(run.plan_version, 2); assert.deepEqual(run.snapshot, preparation.afterContent.cases.find(row => row.id === run.case_id)); }
  const binding = state.reportBindings.find(row => row.id === report.id);
  assert.ok(binding?.snapshot_config && binding.snapshot_delivery && binding.snapshot_tasks, 'Missing actual immutable comparison snapshot');
  const comparisons = mission.config.criteria.filter(row => row.delivery?.kind === 'regression_comparison');
  assert.equal(comparisons.length, preparation.caseKeys.length);
  assert.deepEqual(comparisons.map(row => row.delivery.caseKey).sort(), [...preparation.caseKeys].sort());
  assert.deepEqual(binding.snapshot_config.criteria, mission.config.criteria, 'Report changed original comparison criteria');
  assert.deepEqual(binding.snapshot_delivery.cases.map(row => row.caseKey).sort(), [...preparation.caseKeys].sort());
  const oldBinding = preparation.final.reportBindings.find(row => row.id === preparation.ownerReport.reportId);
  assert.ok(oldBinding?.snapshot_tasks, 'Actual A report source identity is missing');
  const currentRunIds = [];
  for (const criterion of comparisons) {
    const { caseKey, baseline, capturedAt } = criterion.delivery;
    const old = preparation.final.runs.find(run => key(run) === caseKey && preparation.currentRunIds.includes(run.id));
    assert.ok(old && baseline && baseline.runId === old.id, 'Comparison substituted the actual original A run');
    const originalSource = boundRegressionSource(preparation.final, oldBinding, old.id);
    assert.deepEqual(baseline, { runId: old.id, planVersion: old.plan_version, snapshot: old.snapshot, target: old.target,
      startedAt: new Date(old.started_at).toISOString(), finishedAt: new Date(old.finished_at).toISOString(), sourceRevision: originalSource.sourceRevision });
    assert.ok(time(old.finished_at) <= time(capturedAt) && time(capturedAt) <= Math.min(...state.runs.map(run => time(run.started_at))), 'Historical selection happened after B execution');
    const selected = binding.snapshot_delivery.cases.find(row => row.caseKey === caseKey);
    assert.ok(selected?.complete && selected.runId && selected.runId !== old.id);
    const current = state.runs.find(run => run.id === selected.runId && key(run) === caseKey); assert.ok(current);
    currentRunIds.push(current.id);
    const oldTest = report.document.tests.filter(row => row.runId === old.id);
    assert.equal(oldTest.length, 1); assert.equal(oldTest[0].originalOutcome, old.result.outcome); assert.equal(oldTest[0].status, old.result.outcome); assert.equal(oldTest[0].review, 'supported');
    const findings = report.document.findings.filter(row => row.criterionId === criterion.id);
    assert.equal(findings.length, 1); assert.equal(findings[0].verdict, 'supported');
    for (const [run, captures] of [[old, preparation.final.captures], [current, state.captures]]) {
      const source = boundRegressionSource(state, binding, run.id);
      assert.deepEqual(source.target, run.target); assert.equal(time(source.startedAt), time(run.started_at)); assert.equal(time(source.finishedAt), time(run.finished_at));
      if (run.id === old.id) assert.equal(source.sourceRevision, baseline.sourceRevision);
      assert.ok(captures.some(capture => capture.run_id === run.id && capture.provenance?.producer === 'browser-action'
        && source.evidence.some(evidence => evidence.itemId === capture.item_id && evidence.origin === 'tool' && evidence.provenance?.sourceType === 'test'
          && evidence.provenance.sourceId === run.id && evidence.provenance.sha256 === capture.provenance.sha256
          && findings[0].evidenceIds.includes(evidence.id)
          && report.document.evidence.some(saved => saved.id === evidence.id && saved.itemId === capture.item_id && saved.read)
          && report.read_receipts.some(read => read.id === evidence.id && !read.limited && read.digest === capture.provenance.sha256))), 'Comparison has not cited read-backed actual A/B action evidence for each selected case');
    }
  }
  assert.deepEqual(report.document.tests.map(row => row.runId).sort(), [...currentRunIds, ...preparation.currentRunIds].sort(), 'Unexpected, duplicate or missing historical/current report row');
  // These are exact source/read identities, not a proof that the prose explains
  // fixed versus unchanged behavior correctly. That remains independent review.
  return { binding: 'immutable-regression-comparison-v1', reportSnapshotHash: binding.snapshot_hash,
    historicalBaseline: preparation.preparation, historicalRunIds: preparation.runIds, currentHistoricalRunIds: preparation.currentRunIds,
    currentRunIds, newRunIds: state.runs.map(row => row.id), actualHistoryVerified: true, fullRealHistoricalRegression: true, semanticComparison: 'independent_review_pending' };
}
