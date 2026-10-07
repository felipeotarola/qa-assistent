import assert from 'node:assert/strict';
import { fingerprint as proofHash } from './helpers/evidence-acceptance.mjs';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerUsageSchema } from '../shared/provider-usage.ts';
import { catalogMarkdown, catalogPlan, catalogProviderReceipt, readCatalog, summarizeCatalog } from './helpers/autonomy-catalog-benchmark.mjs';

const SHA = 'a'.repeat(64), OTHER = 'b'.repeat(64), at = '2026-10-05T10:00:00.000Z', end = '2026-10-05T10:01:00.000Z';
const clone = value => structuredClone(value);
const meter = (overrides = {}) => ({ providerCalls: 1, unknownCalls: 0, inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: null, cacheWriteTokens: null, durationMs: 20, ...overrides });
const execution = (id = 'attempt-1', overrides = {}) => ({ id, kind: 'report', status: 'completed', usage: { tokens: 15, provider: meter() }, tool_calls: 2, reserved_tokens: 100, ...overrides });
const trial = (overrides = {}) => ({ repetition: 1, workspaceId: 'private-workspace', threadId: 'private-thread', sessionId: 'private-session', startedAt: at, acceptedAt: at, closedAt: end, finishedAt: end,
  result: 'passed', snapshots: [{ at: end, attempts: [execution()] }], ...overrides });
const web = (overrides = {}) => ({ version: 5, scenario: 'normal', repetitions: 1, runtime: 'autonomy-test:unit', sourceHash: SHA, processes: { sourceSha256: SHA }, buildIntegrity: { sourceSha256: SHA },
  modelRequestIntervalMs: 0,
  fixture: { kind: 'simulated-public-origin', siteSha256: SHA, oracleSha256: SHA }, prompt: 'Test this site', model: 'test-model', reasoning: 'low',
  harnessSha256: SHA, oracleAuditSha256: SHA, timestampParserSha256: SHA, timestampObservation: 'utc-oid1114-v1', oracleContract: 'test-locked-oracle',
  observationSeconds: 1500, schedulerIntervalSeconds: 60, controllerLeaseSeconds: 90, reportLeaseSeconds: 240, automatedGate: false, gate: false,
  reportProseReview: { status: 'pending' }, attempts: [trial()], ...overrides });
const summarize = (...data) => summarizeCatalog(data.map((entry, index) => ({ data: entry, fileName: `fixture-${index}.json` })));
const webV6 = (overrides = {}) => web({ version: 6, auditSha256: SHA,
  reviewerPolicy: { reviewerVersion: '9', hashVersion: 2, sourceSha256: OTHER }, ...overrides });
const webV7 = (overrides = {}) => webV6({ version: 7, defectPolicy: 'reviewed-known-defect-v1',
  oracleContract: 'submitted-search-catalogue-reviewed-known-defects-v7',
  attempts: [trial({ knownDefectObservations: [{ oracleId: 'broken_returns', runId: 'PRIVATE-run', checkId: 'PRIVATE-check', evidenceItemId: 'PRIVATE-item',
    sourceOutcome: 'failed', checkpointStatus: 'verified', representation: 'typed_defect_with_reviewed_trace', semanticReview: 'independent_review_pending' }], authorizedComplements: [] })], ...overrides });

test('web v7 keeps explicit known-defect policy and frozen reviewer separate from all older identities', () => {
  const current = webV7({ repetitions: 3 }), before = clone(current), result = summarize(current), artifact = result.artifacts[0];
  assert.equal(artifact.supportedProtocol, true); assert.equal(artifact.identity.version, 7);
  assert.equal(artifact.identity.defectPolicy, 'reviewed-known-defect-v1');
  assert.deepEqual(artifact.identity.reviewerPolicy, current.reviewerPolicy); assert.equal(artifact.identity.hashes.auditSha256, SHA);
  assert.equal(artifact.comparisonKey.length, 64); assert.equal(result.states.automatically_passed, 1); assert.equal(result.states.not_started, 2);
  for (const version of [1, 2, 3, 4, 5, 6]) {
    const historical = summarize(version === 6 ? webV6() : web({ version })).artifacts[0];
    assert.equal(Object.hasOwn(historical.identity, 'defectPolicy'), false);
    assert.notEqual(historical.comparisonKey, artifact.comparisonKey);
    assert.equal(historical.supportedProtocol, [5, 6].includes(version));
  }
  assert.equal(result.catalog.flatMap(row => row.variants).length, 35);
  assert.equal(result.catalog.flatMap(row => row.variants).reduce((sum, row) => sum + row.minimumRepetitions, 0), 105);
  assert.deepEqual(current, before); assert.equal(result.gate, 'not_evaluated');
});

test('web v7 cannot borrow legacy policy, reviewer or audit identities when required fields disagree', () => {
  for (const mutate of [v => delete v.defectPolicy, v => v.defectPolicy = null, v => v.defectPolicy = 'any-negative',
    v => v.oracleContract = 'submitted-search-catalogue-typed-complements-and-preserved-defects-v5',
    v => delete v.reviewerPolicy, v => v.reviewerPolicy.hashVersion = 1, v => v.reviewerPolicy.private = 'PRIVATE-policy',
    v => delete v.auditSha256, v => v.auditSha256 = 'invalid', v => v.oracleAuditSha256 = OTHER]) {
    const value = webV7(); mutate(value); const result = summarize(value);
    assert.equal(result.artifacts[0].comparisonKey, null); assert.equal(result.gate, 'not_evaluated');
    assert.ok(!JSON.stringify(result).includes('PRIVATE-policy'));
  }
  const reference = summarize(webV7()).artifacts[0].comparisonKey;
  const changed = webV7(); changed.reviewerPolicy.sourceSha256 = SHA;
  assert.notEqual(summarize(changed).artifacts[0].comparisonKey, reference);
  const early = summarize(webV7({ oracleAuditSha256: undefined, attempts: [], repetitions: 3 }));
  assert.equal(early.artifacts[0].comparisonKey.length, 64); assert.equal(early.states.not_started, 3);
});

test('web v7 records receipt hashes and pending semantics without copying private IDs or certifying metadata', () => {
  const value = webV7({ gate: true, automatedGate: true });
  value.attempts[0].knownDefectObservations[0].semanticReview = 'passed';
  value.attempts[0].knownDefectObservations[0].detail = 'PRIVATE-prose is not independently observed';
  const result = summarize(value, clone(value)), observed = result.workloads[0].observations[0].webAudit;
  assert.equal(observed.recordedKnownDefectObservations, 1); assert.equal(observed.recordedComplements, 0);
  assert.equal(observed.knownDefectReceiptSha256.length, 64); assert.equal(observed.semanticCoverage, 'independent_review_pending');
  assert.equal(observed.independentReview, 'not_reverified'); assert.equal(observed.fullGate, false); assert.equal(result.gate, 'not_evaluated');
  assert.equal(result.duplicateFilesCollapsed, 1); assert.equal(result.usage.tokens.total, 15); assert.equal(result.usage.logicalAttempts, 1);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-'));
  const missing = summarize(webV7({ attempts: [trial()] })).workloads[0].observations[0].webAudit;
  assert.equal(missing.recordedKnownDefectObservations, null); assert.equal(missing.knownDefectReceiptSha256, null);
  assert.equal(missing.semanticCoverage, 'independent_review_pending');
});

test('web v7 preserves failed and unstarted slots for normal and restart variants and rejects unrecognized protocol numbers', () => {
  for (const scenario of ['normal', 'controller-restart', 'report-restart']) {
    const result = summarize(webV7({ scenario, repetitions: 3, result: 'failed', attempts: [trial({ result: 'failed' })] }));
    assert.equal(result.artifacts[0].variant, scenario); assert.equal(result.states.failed, 1); assert.equal(result.states.not_started, 2);
    assert.equal(result.gate, 'not_evaluated'); assert.deepEqual(result.workloads[0].reportProse, ['pending']);
  }
  const unknown = summarize(webV7({ version: 8 }));
  assert.equal(unknown.artifacts[0].family, 'unsupported'); assert.equal(unknown.artifacts[0].supportedProtocol, false);
  assert.equal(unknown.artifacts[0].comparisonKey, null);
});

test('web v6 records frozen reviewer policy and keeps v5 plus different reviewer sources in separate cohorts', () => {
  const old = summarize(web()).artifacts[0], current = summarize(webV6()).artifacts[0];
  assert.equal(current.family, 'web'); assert.equal(current.supportedProtocol, true); assert.equal(current.identity.version, 6);
  assert.deepEqual(current.identity.reviewerPolicy, { reviewerVersion: '9', hashVersion: 2, sourceSha256: OTHER });
  assert.equal(current.identity.hashes.auditSha256, SHA); assert.equal(current.identity.hashes.oracleAuditSha256, SHA);
  assert.equal(current.comparisonKey.length, 64); assert.notEqual(current.comparisonKey, old.comparisonKey);
  assert.equal(Object.hasOwn(old.identity, 'reviewerPolicy'), false);
  assert.equal(Object.hasOwn(old.identity.hashes, 'auditSha256'), false, 'Historical v5 identity is unchanged');
  for (const policy of [{ reviewerVersion: '10', hashVersion: 2, sourceSha256: OTHER }, { reviewerVersion: '9', hashVersion: 2, sourceSha256: SHA }]) {
    assert.notEqual(summarize(webV6({ reviewerPolicy: policy })).artifacts[0].comparisonKey, current.comparisonKey);
  }
  assert.equal(summarize(webV6()).gate, 'not_evaluated');
});

test('web v6 missing, malformed or conflicting reviewer/audit identity is non-comparable without borrowing v5 defaults', () => {
  for (const mutate of [v => delete v.reviewerPolicy, v => v.reviewerPolicy = null,
    v => v.reviewerPolicy.reviewerVersion = 'not-a-version', v => v.reviewerPolicy.hashVersion = 1,
    v => delete v.reviewerPolicy.sourceSha256, v => v.reviewerPolicy.sourceSha256 = 'invalid',
    v => v.reviewerPolicy.secret = 'NEVER_EXPORT', v => delete v.auditSha256, v => v.auditSha256 = 'invalid',
    v => v.oracleAuditSha256 = OTHER, v => v.oracleAuditSha256 = null]) {
    const value = webV6(); mutate(value);
    const result = summarize(value); assert.equal(result.artifacts[0].comparisonKey, null);
    assert.equal(result.gate, 'not_evaluated'); assert.ok(!JSON.stringify(result).includes('NEVER_EXPORT'));
  }
  // A partial preflight may have the initial v6 hash without the later alias;
  // absent observation never becomes an executed or passed trial.
  const early = webV6({ oracleAuditSha256: undefined, attempts: [], repetitions: 3 });
  assert.equal(summarize(early).states.not_started, 3);
  assert.equal(summarize(early).artifacts[0].identity.hashes.auditSha256, SHA);
});

test('web v6 preserves failed and unstarted repetitions plus independent prose status', () => {
  const data = webV6({ repetitions: 3, result: 'failed', reportProseReview: { status: 'failed' },
    attempts: [trial({ result: 'failed', error: 'PRIVATE_PROVIDER_ERROR' })] });
  const result = summarize(data);
  assert.equal(result.artifacts[0].plannedTrials, 3); assert.equal(result.states.failed, 1); assert.equal(result.states.not_started, 2);
  assert.deepEqual(result.workloads[0].reportProse, ['failed']); assert.equal(result.usage.tokens.total, 15);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_PROVIDER_ERROR'));
  assert.equal(result.gate, 'not_evaluated');
  const historical = summarize(web({ version: 4 }));
  assert.equal(historical.states.historical_unreviewed, 1); assert.equal(historical.artifacts[0].comparisonKey, null);
});
const browser = (overrides = {}) => ({ ...web(), version: undefined, type: 'syna-browser-variants-acceptance', schemaVersion: 2, catalogVersion: '2026-10-05', taskId: 'WEB-02', taskVersion: 1, variant: 'normal',
  fixture: { kind: 'simulated-public-origin', runtimeScope: 'autonomy-test:unit', serverSha256: SHA, oracleSha256: SHA, resolverSha256: SHA }, parserSha256: SHA, traceParserSha256: SHA,
  externalReview: { reportProse: 'pending', visiblePixels: 'pending' }, trials: [{ ...trial(), status: 'automated_subset_passed' }], ...overrides });
const evidence = (overrides = {}) => ({ ...web(), version: undefined, protocol: 'syna-evidence-acceptance-v1', catalogVersion: '2026-10-05', taskId: 'REP-05', variant: 'normal', mode: '--execute',
  manifestSha256: SHA, oracleSha256: SHA, observerSha256: SHA, inputPreparation: 'synthetic-golden; actual persisted files/runs; zero previous execution',
  attempts: [trial({ baseline: { missions: [{ id: 'old-mission' }], attempts: [execution('old-attempt')] }, snapshots: [{ at: end,
    missions: [{ id: 'old-mission' }, { id: 'new-mission', thread_id: 'private-thread' }],
    attempts: [execution('old-attempt', { mission_id: 'old-mission' }), execution('attempt-1', { mission_id: 'new-mission' })],
    reports: [{ id: 'report', usage: { tokens: 999999 } }] }] })], ...overrides });
test('evidence v1, v2 and v3 retain failures and never share a comparison group', () => {
  const legacy = evidence({ repetitions: 3, attempts: [trial({ result: 'failed' })] });
  const previous = evidence({ protocol: 'syna-evidence-acceptance-v2', runtime: 'autonomy-test:previous-protocol' });
  const current = evidence({ protocol: 'syna-evidence-acceptance-v3', runtime: 'autonomy-test:current-protocol', taskId: 'REP-07' });
  current.attempts[0].oracle = { conclusionProfile: 'summary_with_disclosed_uncertainty', semanticProse: 'pending' };
  const inputs = [legacy, previous, current], before = clone(inputs), result = summarize(...inputs);
  assert.deepEqual(result.artifacts.map(row => row.identity.version).sort(), ['syna-evidence-acceptance-v1', 'syna-evidence-acceptance-v2', 'syna-evidence-acceptance-v3']);
  assert.ok(result.artifacts.every(row => row.comparisonKey));
  assert.equal(new Set(result.artifacts.map(row => row.comparisonKey)).size, 3);
  assert.equal(result.comparisonGroups.length, 3); assert.equal(result.gate, 'not_evaluated');
  assert.equal(result.states.failed, 1); assert.equal(result.states.not_started, 2);
  assert.deepEqual(inputs, before);
  const sameScope = [1, 2, 3].map(version => evidence({ protocol: 'syna-evidence-acceptance-v' + version }));
  assert.equal(new Set(sameScope.map(value => summarize(value).artifacts[0].comparisonKey)).size, 3, 'Protocol alone separates otherwise identical comparisons');
});
function reportFault(taskId = 'REP-05') {
  const [variant, kind] = { 'REP-05': ['lost-queue-commit-ack', 'pg-commit-ack'], 'REP-06': ['source-change-after-read', 'provider-response-barrier'], 'REP-07': ['wrong-run-provenance', 'synthetic-preparation-only'] }[taskId];
  const data = evidence({ protocol: 'syna-report-fault-acceptance-v1', taskId, variant, repetitions: 3, goldenValidatorSha256: SHA });
  data.buildIntegrity.reportFault = { protocol: data.protocol, manifestSha256: SHA, kind,
    codeHashes: { ...Object.fromEntries(['acceptance', 'compile', 'contract', 'control', 'diagnostics', 'driver', 'pg', 'preload', 'prepare', 'provider', 'runtime', 'startup'].map(name => [`tests/helpers/report-fault-${name}.mjs`, SHA])), 'tests/autonomy-evidence.acceptance.mjs': SHA } };
  const row = data.attempts[0]; row.promptSha256 = SHA;
  row.oracle = { reportId: 'private-report', checks: ['exact report-only selection', 'original runs preserved', 'no new execution', variant], semanticProse: 'pending' };
  row.goldenPreparation = { preparation: 'synthetic-golden-fault', realProviderCalls: 0, realBrowserActions: 0, reviewerVersion: '7', preparedAt: at };
  row.faultArm = { workspaceId: row.workspaceId, threadId: row.threadId, promptSha256: SHA, state: taskId === 'REP-07' ? 'synthetic_preparation_locked' : 'armed', armedAt: at };
  if (taskId !== 'REP-07') row.fault = { ...row.faultArm, missionId: 'new-mission', attemptId: 'attempt-1', reportId: 'private-report', snapshotId: 'private-snapshot',
    ...(taskId === 'REP-05' ? { state: 'commit_ack_dropped', physicalBoundary: 'postgres_backend_commit_before_client_ack', droppedAt: end }
      : { state: 'source_changed_response_released', requestSha256: SHA, providerResponseSha256: OTHER, providerCompletedAt: at, changedAt: end, releasedAt: end, beforeVersion: 1, afterVersion: 2 }) };
  if (taskId === 'REP-06') row.oracle.freshnessProof = { reportId: 'private-report', reason: 'Evidence changed during review', files: [{ name: 'web-stderr.log', occurrences: 1, matchedDiagnosticSha256: [SHA], appendedSha256: OTHER }] };
  return data;
}
test('report fault v2 keeps its exact version and rejects a v1 runtime identity as comparable', () => {
  const legacy = reportFault(), current = reportFault();
  current.protocol = 'syna-report-fault-acceptance-v2'; current.buildIntegrity.reportFault.protocol = current.protocol;
  current.runtime = 'autonomy-test:new-protocol';
  const result = summarize(legacy, current);
  assert.equal(result.artifacts.length, 2); assert.ok(result.artifacts.every(row => row.comparisonKey));
  assert.equal(new Set(result.artifacts.map(row => row.comparisonKey)).size, 2);
  assert.deepEqual(result.artifacts.map(row => row.identity.reportFault.protocol).sort(), ['syna-report-fault-acceptance-v1', 'syna-report-fault-acceptance-v2']);
  assert.equal(result.gate, 'not_evaluated');
  current.buildIntegrity.reportFault.protocol = legacy.protocol;
  const mismatched = summarize(current);
  assert.equal(mismatched.artifacts[0].comparisonKey, null);
  assert.equal(mismatched.artifacts[0].identity.reportFault.protocol, null);
});
const repo = (overrides = {}) => ({ ...web(), kind: 'repository-acceptance', version: 1, scenario: 'REPO-12', variant: 'normal',
  fixture: { kind: 'simulated-github-transport', manifestSha256: SHA, oracleSha256: SHA, repository: { commit: 'a'.repeat(40) } },
  helperHashes: { 'repo-benchmark-contract.mjs': SHA, 'repo-worker-integrity.mjs': SHA, 'repo-acceptance-observer.mjs': SHA },
  attempts: [trial({ measuredFrom: '2026-10-05T10:00:30Z', excludedPreparation: { setupJobId: 'do-not-print', consent: 'never-print' } })], ...overrides });
const repoV2 = (overrides = {}) => repo({ version: 2, protocol: 'syna-repository-normal-v2',
  reviewerPolicy: { reviewerVersion: '10', hashVersion: 2, sourceSha256: OTHER },
  runChecksPolicy: { version: 1, sourceSha256: OTHER }, buildIntegrity: { sourceSha256: SHA, runChecksPolicy: { version: 1, sourceSha256: OTHER } },
  helperHashes: Object.fromEntries(['repo-benchmark-contract.mjs', 'repo-worker-integrity.mjs', 'repo-acceptance-observer-v2.mjs', 'repo-benchmark-audit.mjs', 'repo-transport.mjs', 'repo-transport-linux.mjs', 'autonomy-web-audit.mjs'].map(name => [name, SHA])),
  attempts: [trial({ complements: [{ priorRunId: 'PRIVATE-old-run', runId: 'PRIVATE-new-run', gapId: 'PRIVATE-gap' }],
    reviewScope: { originalSelectionObservedAt: at, originalRequirementsExact: true, currentRunByCase: [{ caseKey: 'PRIVATE-case', runId: 'PRIVATE-new-run' }], semanticCoverage: 'independent_review_pending' } })], ...overrides });

const currentPolicies = () => ({ reviewerPolicy: { reviewerVersion: '10', hashVersion: 2, sourceSha256: OTHER }, runChecksPolicy: { version: 1, sourceSha256: OTHER } });
const reportScope = () => ({ finalReportId: 'PRIVATE-final', interim: [{ reportId: 'PRIVATE-interim', status: 'completed', taskId: 'PRIVATE-task' }], immutablePurposeBinding: true });
const browserReportScope = () => ({ version: 1, finalReportId: 'PRIVATE-final', finalSnapshotHash: SHA, interim: [{ reportId: 'PRIVATE-interim', status: 'completed', snapshotHash: OTHER }], semanticCoverage: 'independent_review_pending' });
const browserV4 = (overrides = {}) => browser({ schemaVersion: 4, reviewScope: 'frozen-review-and-authorized-continuations-v1', effectParserSha256: SHA,
  ...currentPolicies(), buildIntegrity: { sourceSha256: SHA, ...currentPolicies() },
  helperHashes: Object.fromEntries(['browser-variants-current.mjs', 'browser-variants-reports.mjs', 'browser-variants-regression.mjs', 'repo-benchmark-audit-v2.mjs', 'repo-benchmark-audit.mjs', 'autonomy-web-audit.mjs', 'mission-report-bindings.mjs'].map(name => [name, SHA])),
  trials: [trial({ status: 'automated_subset_passed', reportScope: browserReportScope(), complements: [{ priorRunId: 'PRIVATE-old', runId: 'PRIVATE-new' }],
    humanResumptions: [{ runId: 'PRIVATE-return-run', sessionId: 'PRIVATE-session' }], humanAttemptContinuations: [{ attemptId: 'PRIVATE-attempt', waitId: 'PRIVATE-wait' }],
    reviewScope: { originalSelectionObservedAt: at, semanticCoverage: 'passed' } })], ...overrides });
function browserV5(variant = 'normal') {
  const value = browserV4({ taskId: 'WEB-04', schemaVersion: 5, taskVersion: 3, variant, repetitions: 3,
    historicalBaseline: 'actual-natural-QA-A-before-measured-B-v1' });
  value.helperHashes['browser-variants-history.mjs'] = SHA;
  const row = value.trials[0]; row.userId = 'PRIVATE-owner'; row.measuredFrom = '2026-10-05T10:00:30.000Z'; row.acceptedAt = row.measuredFrom;
  const identity = { workspaceId: row.workspaceId, userId: row.userId, threadId: 'PRIVATE-A-thread', sessionId: 'PRIVATE-A-session', planId: 'PRIVATE-plan',
    runtime: value.runtime, sourceHash: value.sourceHash, fixtureSourceHash: value.fixture.serverSha256, harnessSha256: value.harnessSha256, helperSha256: value.helperHashes['browser-variants-history.mjs'] };
  row.preparationArtifact = { path: 'PRIVATE-A-artifact.json', artifactSha256: OTHER, identity: clone(identity) };
  row.preparation = { protocol: 'syna-browser-regression-actual-history-v1', preparation: 'actual-natural-QA-A', identity,
    acceptedAt: at, closedAt: '2026-10-05T10:00:20.000Z', runIds: ['PRIVATE-A-old-run', 'PRIVATE-A-current-run'], currentRunIds: ['PRIVATE-A-current-run'],
    final: { attempts: [execution('PRIVATE-A-attempt', { usage: { tokens: 999999 } })] }, semanticReview: 'independent_review_pending' };
  row.regression = { historicalBaseline: 'actual-natural-QA-A', historicalRunIds: clone(row.preparation.runIds), actualHistoryVerified: true,
    fullRealHistoricalRegression: variant === 'normal', semanticComparison: 'independent_review_pending',
    ...(variant === 'normal' ? { binding: 'immutable-regression-comparison-v1', reportSnapshotHash: SHA,
      currentHistoricalRunIds: clone(row.preparation.currentRunIds), currentRunIds: ['PRIVATE-B-current-run'], newRunIds: ['PRIVATE-B-old-run', 'PRIVATE-B-current-run'] } : {}) };
  row.snapshots = [{ at: end, missions: [{ id: 'PRIVATE-B-mission', thread_id: row.threadId }], attempts: [execution('attempt-1', { mission_id: 'PRIVATE-B-mission' })] }];
  return value;
}

test('WEB04 v5 records actual A preparation separately and preserves 35 by 3 pending catalogue', () => {
  const value = browserV5(), before = clone(value), result = summarize(value, clone(value));
  const artifact = result.artifacts[0], observation = result.workloads[0].observations[0], history = observation.regressionHistory;
  assert.equal(artifact.supportedProtocol, true); assert.equal(artifact.identity.version, 5); assert.equal(artifact.identity.taskVersion, 3);
  assert.equal(artifact.identity.historicalBaseline, 'actual-natural-QA-A-before-measured-B-v1'); assert.equal(artifact.comparisonKey.length, 64);
  assert.equal(history.preparationBindingRecorded, true); assert.equal(history.historyRecorded, true); assert.equal(history.fullComparisonRecorded, true); assert.equal(history.completionRecorded, true);
  assert.equal(history.recordedHistoricalRuns, 2); assert.equal(history.recordedCurrentHistoricalRuns, 1); assert.equal(history.recordedCurrentRuns, 1); assert.equal(history.recordedNewRuns, 2);
  assert.equal(history.preparationUsage, 'excluded_not_zero'); assert.equal(history.independentReview, 'not_reverified'); assert.equal(history.semanticComparison, 'independent_review_pending'); assert.equal(history.fullGate, false);
  assert.equal(history.preparationArtifactSha256, OTHER); assert.equal(history.preparationIdentitySha256.length, 64); assert.equal(history.comparisonReceiptSha256.length, 64);
  assert.equal(result.duplicateFilesCollapsed, 1); assert.equal(result.primaryTrials, 3); assert.equal(result.states.automatically_passed, 1); assert.equal(result.states.not_started, 2);
  assert.deepEqual(result.workloads[0].preparation, ['actual-natural-QA-history-excluded']); assert.equal(result.usage.tokens.total, 15); assert.equal(result.usage.logicalAttempts, 1);
  assert.equal(observation.time.measuredWallMs, 30000); assert.equal(observation.time.observedWallMs, 60000);
  assert.equal(result.catalog.flatMap(row => row.variants).length, 35); assert.equal(result.catalog.flatMap(row => row.variants).reduce((n, row) => n + row.minimumRepetitions, 0), 105);
  assert.equal(result.gate, 'not_evaluated'); assert.deepEqual(value, before);
  const text = JSON.stringify(result) + catalogMarkdown(result);
  for (const privateValue of ['PRIVATE-', 'private-workspace', 'private-thread', 'attempt-1', '999999']) assert.ok(!text.includes(privateValue));
});

test('only WEB04 task version 3 with actual history opts into browser v5', () => {
  for (const change of [v => v.taskId = 'WEB-02', v => v.taskId = 'WEB-03', v => v.taskId = 'AUTH-09', v => v.taskVersion = 2,
    v => delete v.historicalBaseline, v => v.historicalBaseline = 'declared-synthetic-history']) {
    const value = browserV5(); change(value); const result = summarize(value);
    assert.equal(result.artifacts[0].supportedProtocol, false); assert.equal(result.artifacts[0].comparisonKey, null); assert.equal(result.states.automatically_passed, undefined);
  }
  for (const change of [v => delete v.helperHashes['browser-variants-history.mjs'], v => delete v.reviewerPolicy,
    v => v.buildIntegrity.runChecksPolicy.sourceSha256 = SHA, v => delete v.helperHashes['mission-report-bindings.mjs']]) {
    const value = browserV5(); change(value); assert.equal(summarize(value).artifacts[0].comparisonKey, null);
  }
  const changed = browserV5(); changed.helperHashes['browser-variants-history.mjs'] = OTHER;
  assert.notEqual(summarize(changed).artifacts[0].comparisonKey, summarize(browserV5()).artifacts[0].comparisonKey);
});

test('v5 normal pass cannot borrow synthetic, foreign, altered or incomplete A preparation', () => {
  for (const change of [r => delete r.preparation, r => r.preparation.preparation = 'synthetic-unreviewed', r => r.preparation.protocol = 'unknown',
    r => r.preparationArtifact.artifactSha256 = 'invalid', r => r.preparationArtifact.identity.userId = 'another',
    ...['workspaceId', 'userId', 'runtime', 'sourceHash', 'fixtureSourceHash', 'harnessSha256', 'helperSha256'].map(key => r => {
      r.preparation.identity[key] = r.preparationArtifact.identity[key] = key.endsWith('Hash') || key.endsWith('Sha256') ? OTHER : 'another';
    }), r => { r.preparation.identity.threadId = r.preparationArtifact.identity.threadId = r.threadId; },
    r => r.preparation.closedAt = end, r => r.acceptedAt = at, r => delete r.measuredFrom,
    r => r.preparation.currentRunIds = ['PRIVATE-not-an-A-run'], r => r.preparation.runIds.push(r.preparation.runIds[0])]) {
    const value = browserV5(); change(value.trials[0]); const result = summarize(value);
    assert.equal(result.states.unknown, 1); assert.equal(result.states.automatically_passed, undefined);
    assert.equal(result.workloads[0].observations[0].regressionHistory.completionRecorded, false);
  }
});

test('v5 exact normal comparison and final report receipts are mandatory metadata, not semantic certification', () => {
  for (const change of [r => delete r.regression, r => r.regression.binding = 'other', r => r.regression.actualHistoryVerified = false,
    r => r.regression.reportSnapshotHash = OTHER, r => r.regression.historicalRunIds = ['another-A'], r => r.regression.currentHistoricalRunIds = ['PRIVATE-A-old-run'],
    r => r.regression.currentRunIds = ['not-B'], r => r.regression.newRunIds.push('PRIVATE-A-old-run'), r => r.regression.newRunIds.push(r.regression.newRunIds[0]),
    r => r.regression.fullRealHistoricalRegression = false, r => r.regression.semanticComparison = 'passed',
    r => delete r.reportScope, r => r.reportScope.version = 2, r => r.reportScope.finalReportId = null, r => r.reportScope.semanticCoverage = 'passed']) {
    const value = browserV5(); change(value.trials[0]); const result = summarize(value);
    assert.equal(result.states.unknown, 1); assert.equal(result.workloads[0].observations[0].regressionHistory.completionRecorded, false); assert.equal(result.gate, 'not_evaluated');
  }
});

test('v5 fault variants preserve actual A but never claim full B comparison', () => {
  for (const variant of ['plan-changed', 'stop-independent']) {
    const value = browserV5(variant), result = summarize(value), history = result.workloads[0].observations[0].regressionHistory;
    assert.equal(result.states.automatically_passed, 1); assert.equal(history.historyRecorded, true); assert.equal(history.completionRecorded, true);
    assert.equal(history.fullComparisonRecorded, false); assert.equal(history.recordedCurrentRuns, null); assert.equal(history.semanticComparison, 'independent_review_pending');
    value.trials[0].regression.fullRealHistoricalRegression = true; assert.equal(summarize(value).states.unknown, 1);
    value.trials[0].status = 'failed'; assert.equal(summarize(value).states.failed, 1, 'A recorded failure is never repaired by projection');
  }
});

test('v5 B usage excludes embedded A and an A-only ledger is unknown, never a zero B total', () => {
  const value = browserV5(), row = value.trials[0], snapshot = row.snapshots[0];
  snapshot.missions.push({ id: 'PRIVATE-A-mission', thread_id: 'PRIVATE-A-thread' }); snapshot.attempts.push(execution('PRIVATE-A-attempt', { mission_id: 'PRIVATE-A-mission', usage: { tokens: 999999 } }));
  row.preparationProgress = { execution: { snapshots: [clone(snapshot)] } }; row.preparation.final = clone(snapshot);
  const result = summarize(value); assert.equal(result.usage.tokens.total, 15); assert.equal(result.usage.logicalAttempts, 1);
  snapshot.missions = snapshot.missions.filter(m => m.id === 'PRIVATE-A-mission'); snapshot.attempts = snapshot.attempts.filter(a => a.mission_id === 'PRIVATE-A-mission');
  const onlyA = summarize(value); assert.equal(onlyA.usage.logicalAttempts, 0); assert.equal(onlyA.usage.tokens.total, null); assert.equal(onlyA.usage.physical.providerCalls.total, null);
  assert.ok(onlyA.workloads[0].gaps.includes('browser-history-current-mission-ledger-unobserved'));
  snapshot.missions.push({ thread_id: row.threadId }); snapshot.attempts.push(execution('PRIVATE-unbound-attempt'));
  const unbound = summarize(value); assert.equal(unbound.usage.logicalAttempts, 0); assert.equal(unbound.usage.tokens.total, null, 'Missing mission IDs cannot bind an undefined attempt mission_id');
  delete row.measuredFrom; assert.equal(summarize(value).workloads[0].observations[0].time.measuredWallMs, null, 'Never measure A as B when its start is absent');
});

test('v5 S1 independent WEB03 uses its own v4 contract and time, not the parent A-to-B scope', () => {
  const value = browserV5('stop-independent');
  value.trials[0].independent = { ...trial({ threadId: 'PRIVATE-other-thread', sessionId: 'PRIVATE-other-session' }),
    protocol: { schemaVersion: 4, taskVersion: 1, taskId: 'WEB-03', variant: 'normal', historicalBaseline: null }, verified: true,
    snapshots: [{ at: end, state: { attempts: [execution('PRIVATE-independent-attempt')] } }] };
  const result = summarize(value), independent = result.workloads.find(row => row.role === 'independent-control');
  assert.equal(result.primaryTrials, 3); assert.equal(result.independentControls, 1); assert.equal(result.states.automatically_passed, 2);
  assert.equal(independent.status, 'automatically_passed'); assert.equal(independent.taskId, 'WEB-03'); assert.equal(independent.observations[0].regressionHistory, undefined);
  assert.equal(independent.observations[0].time.measuredWallMs, 60000); assert.equal(independent.observations[0].browserAudit.fullGate, false);
  assert.equal(result.usage.logicalAttempts, 2); assert.equal(result.usage.tokens.total, 30); assert.equal(result.gate, 'not_evaluated');
  delete value.trials[0].independent.protocol.schemaVersion;
  assert.equal(summarize(value).workloads.find(row => row.role === 'independent-control').supportedProtocol, false, 'Missing own protocol cannot silently adopt v4');
});

test('historical WEB04 synthetic protocols and failed preparation stay distinct from v5 actual history', () => {
  const current = browserV5();
  const legacy = [2, 3, 4].map(version => browserV4({ schemaVersion: version, taskId: 'WEB-04', taskVersion: 2, historicalBaseline: 'declared-synthetic-unreviewed', runtime: `autonomy-test:legacy-${version}`,
    trials: [trial({ status: 'failed', preparation: { synthetic: true } })] }));
  const result = summarize(...legacy, current); assert.equal(result.states.failed, 3); assert.equal(result.states.automatically_passed, 1);
  assert.equal(new Set(result.artifacts.map(a => a.comparisonKey)).size, 4); assert.ok(result.artifacts.every(a => a.comparisonKey));
  assert.ok(result.workloads.filter(w => w.status === 'failed').every(w => w.observations[0].regressionHistory === undefined));
  const failed = browserV5(); Object.assign(failed.trials[0], { status: 'failed', acceptedAt: undefined, measuredFrom: undefined, snapshots: [], error: 'PRIVATE-preparation-failed' });
  const projected = summarize(failed); assert.equal(projected.states.failed, 1); assert.equal(projected.usage.tokens.total, null); assert.equal(projected.usage.logicalAttempts, 0);
  assert.equal(projected.workloads[0].observations[0].time.measuredWallMs, null); assert.ok(!JSON.stringify(projected).includes('PRIVATE-preparation-failed'));
});
const repoFaultV3 = (overrides = {}) => repo({ version: 3, protocol: 'syna-repository-fault-v3', variant: 'missing_key_no_answer',
  ...currentPolicies(), buildIntegrity: { sourceSha256: SHA, ...currentPolicies() },
  helperHashes: Object.fromEntries(['repo-benchmark-contract.mjs', 'repo-worker-integrity.mjs', 'repo-acceptance-observer-v2.mjs', 'repo-benchmark-audit.mjs', 'repo-benchmark-audit-v2.mjs',
    'repo-transport.mjs', 'repo-transport-linux.mjs', 'autonomy-web-audit.mjs', 'repo-fault-contract.mjs', 'repo-fault-control.mjs', 'repo-fault-gateway.mjs', 'mission-report-bindings.mjs'].map(name => [name, SHA])),
  attempts: [trial({ reportScope: reportScope(), faultReceipt: { version: 2, applied: true, downstream: { accepted: true, jobId: 'PRIVATE-job' } } })], ...overrides });

test('browser v4 records bounded continuation/report scope without certifying it or leaking identifiers', () => {
  const value = browserV4(), before = clone(value), result = summarize(value), artifact = result.artifacts[0], observation = result.workloads[0].observations[0];
  assert.equal(artifact.supportedProtocol, true); assert.equal(artifact.identity.version, 4); assert.equal(artifact.comparisonKey.length, 64);
  assert.equal(artifact.identity.reviewScope, 'frozen-review-and-authorized-continuations-v1');
  assert.deepEqual(artifact.identity.reviewerPolicy, value.reviewerPolicy); assert.deepEqual(artifact.identity.runChecksPolicy, value.runChecksPolicy);
  assert.equal(observation.browserAudit.recordedComplements, 1); assert.equal(observation.browserAudit.recordedHumanResumptions, 1);
  assert.equal(observation.browserAudit.recordedHumanAttemptContinuations, 1); assert.equal(observation.browserAudit.semanticCoverage, 'independent_review_pending');
  assert.equal(observation.browserAudit.independentReview, 'not_reverified'); assert.equal(observation.browserAudit.fullGate, false);
  assert.equal(observation.reportBindingAudit.recordedFinalBinding, true); assert.equal(observation.reportBindingAudit.recordedInterimReports, 1);
  assert.equal(observation.reportBindingAudit.receiptSha256.length, 64); assert.equal(observation.reportBindingAudit.fullGate, false);
  assert.equal(result.gate, 'not_evaluated'); assert.ok(!JSON.stringify(result).includes('PRIVATE-')); assert.deepEqual(value, before);
  assert.equal(result.catalog.flatMap(row => row.variants).length, 35);
  assert.equal(result.catalog.flatMap(row => row.variants).reduce((total, row) => total + row.minimumRepetitions, 0), 105);
});

test('explicit repository fault v3 cannot adopt normal v2, numeric fault v2 or an unspecified v3 protocol', () => {
  const legacy = repo({ version: 2, variant: 'missing_key_no_answer', runtime: 'autonomy-test:legacy-fault', attempts: [trial({ result: 'failed' })] });
  for (const name of ['contract', 'control', 'gateway']) legacy.helperHashes[`repo-fault-${name}.mjs`] = SHA;
  const current = repoFaultV3({ runtime: 'autonomy-test:current-fault' }), result = summarize(legacy, current, repoV2());
  assert.equal(result.artifacts.length, 3); assert.ok(result.artifacts.every(row => row.supportedProtocol && row.comparisonKey));
  assert.equal(new Set(result.artifacts.map(row => row.comparisonKey)).size, 3); assert.equal(result.states.failed, 1);
  const recorded = result.workloads.find(row => row.variant === 'missing_key_no_answer' && row.status === 'automatically_passed').observations[0];
  assert.equal(recorded.reportBindingAudit.recordedInterimReports, 1); assert.equal(recorded.reportBindingAudit.semanticCoverage, 'independent_review_pending');
  assert.equal(recorded.reportBindingAudit.independentReview, 'not_reverified'); assert.equal(recorded.reportBindingAudit.fullGate, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-')); assert.equal(result.gate, 'not_evaluated');
  for (const change of [{ protocol: undefined }, { protocol: 'syna-repository-fault-v99' }, { version: 2 }, { variant: 'normal' }, { scenario: 'REPO-11', variant: 'missing_key_no_answer' }]) {
    const projected = summarize(repoFaultV3(change)); assert.equal(projected.artifacts[0].supportedProtocol, false); assert.equal(projected.artifacts[0].comparisonKey, null);
  }
});

test('current browser/fault comparison requires agreeing frozen reviewer, checkpoint and shared report helper', () => {
  for (const make of [browserV4, repoFaultV3]) {
    const reference = summarize(make()).artifacts[0].comparisonKey;
    for (const change of [v => delete v.reviewerPolicy, v => delete v.buildIntegrity.reviewerPolicy,
      v => v.buildIntegrity.reviewerPolicy.reviewerVersion = '11', v => v.buildIntegrity.reviewerPolicy.sourceSha256 = SHA,
      v => v.buildIntegrity.reviewerPolicy.extra = 'PRIVATE-invalid', v => delete v.runChecksPolicy,
      v => delete v.buildIntegrity.runChecksPolicy, v => v.buildIntegrity.runChecksPolicy.sourceSha256 = SHA,
      v => delete v.helperHashes['mission-report-bindings.mjs'], v => delete v.helperHashes['repo-benchmark-audit-v2.mjs']]) {
      const value = make(); change(value); const result = summarize(value);
      assert.equal(result.artifacts[0].comparisonKey, null); assert.equal(result.gate, 'not_evaluated'); assert.ok(!JSON.stringify(result).includes('PRIVATE-invalid'));
    }
    for (const change of [v => { v.reviewerPolicy.reviewerVersion = '11'; v.buildIntegrity.reviewerPolicy.reviewerVersion = '11'; },
      v => v.helperHashes['mission-report-bindings.mjs'] = OTHER]) {
      const value = make(); change(value); const key = summarize(value).artifacts[0].comparisonKey; assert.equal(key.length, 64); assert.notEqual(key, reference);
    }
  }
  for (const change of [v => delete v.reviewScope, v => v.reviewScope = 'unknown', v => delete v.effectParserSha256,
    v => delete v.helperHashes['browser-variants-current.mjs'], v => delete v.helperHashes['browser-variants-reports.mjs'],
    v => delete v.helperHashes['browser-variants-regression.mjs'], v => v.traceParserSha256 = OTHER]) {
    const value = browserV4(); change(value); assert.equal(summarize(value).artifacts[0].comparisonKey, null);
  }
  const fault = repoFaultV3(); fault.oracleAuditSha256 = OTHER; assert.equal(summarize(fault).artifacts[0].comparisonKey, null);
});

test('browser protocol history and missing v4 receipts remain explicit without extra attempts or duplicated usage', () => {
  const current = browserV4({ repetitions: 3, trials: [trial({ status: 'failed' })] }), before = clone(current), result = summarize(current, clone(current));
  assert.equal(result.duplicateFilesCollapsed, 1); assert.equal(result.states.failed, 1); assert.equal(result.states.not_started, 2);
  const scope = result.workloads[0].observations[0]; assert.equal(scope.reportBindingAudit.recorded, false); assert.equal(scope.reportBindingAudit.recordedFinalBinding, false);
  assert.equal(scope.reportBindingAudit.recordedInterimReports, null); assert.equal(scope.browserAudit.recordedComplements, null);
  assert.equal(scope.browserAudit.fullGate, false); assert.equal(result.usage.logicalAttempts, 1); assert.equal(result.usage.tokens.total, 15); assert.deepEqual(current, before);
  const versions = [2, 3, 4].map(version => version === 4 ? browserV4() : browser({ schemaVersion: version, effectParserSha256: SHA }));
  const keys = versions.map(value => summarize(value).artifacts[0].comparisonKey); assert.ok(keys.every(Boolean)); assert.equal(new Set(keys).size, 3);
  assert.equal(Object.hasOwn(summarize(versions[0]).artifacts[0].identity, 'reviewerPolicy'), false);
});

test('explicit repository normal v2 preserves its identity, frozen policies and pending semantic review', () => {
  const data = repoV2({ repetitions: 3, gate: true, automatedGate: true, reportProseReview: { status: 'passed' } });
  data.attempts[0].reviewScope.semanticCoverage = 'passed'; // An input assertion cannot certify semantics.
  const before = clone(data), result = summarize(data), artifact = result.artifacts[0], audit = result.workloads[0].observations[0].repositoryAudit;
  assert.equal(artifact.supportedProtocol, true); assert.equal(artifact.identity.version, 'syna-repository-normal-v2');
  assert.deepEqual(artifact.identity.reviewerPolicy, data.reviewerPolicy); assert.deepEqual(artifact.identity.runChecksPolicy, data.runChecksPolicy);
  assert.equal(artifact.comparisonKey.length, 64); assert.equal(audit.recordedCurrentRuns, 1); assert.equal(audit.recordedComplements, 1);
  assert.equal(audit.originalSelectionObservedAt, at); assert.equal(audit.recordedOriginalRequirementsExact, true);
  assert.equal(audit.reviewScopeSha256.length, 64); assert.equal(audit.complementReceiptSha256.length, 64);
  assert.equal(audit.semanticCoverage, 'independent_review_pending'); assert.equal(audit.independentReview, 'not_reverified'); assert.equal(audit.fullGate, false);
  assert.equal(result.gate, 'not_evaluated'); assert.equal(result.states.automatically_passed, 1); assert.equal(result.states.not_started, 2);
  assert.equal(result.catalog.flatMap(row => row.variants).length, 35);
  assert.equal(result.catalog.flatMap(row => row.variants).reduce((sum, row) => sum + row.minimumRepetitions, 0), 105);
  assert.equal(result.usage.logicalAttempts, 1); assert.equal(result.usage.tokens.total, 15);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-')); assert.deepEqual(data, before);
});

test('repository normal v2 does not adopt v1 normal, numeric v2 faults or unknown protocol variants', () => {
  const legacy = repo({ runtime: 'autonomy-test:legacy', result: 'failed', attempts: [trial({ result: 'failed' })] });
  const fault = repo({ version: 2, variant: 'missing_key_no_answer', runtime: 'autonomy-test:fault' });
  for (const name of ['contract', 'control', 'gateway']) fault.helperHashes[`repo-fault-${name}.mjs`] = SHA;
  const result = summarize(legacy, fault, repoV2());
  assert.equal(result.artifacts.length, 3); assert.ok(result.artifacts.every(row => row.supportedProtocol && row.comparisonKey));
  assert.equal(new Set(result.artifacts.map(row => row.comparisonKey)).size, 3); assert.equal(result.states.failed, 1);
  assert.deepEqual(result.artifacts.map(row => row.identity.version), [1, 2, 'syna-repository-normal-v2']);
  assert.equal(Object.hasOwn(result.artifacts[0].identity, 'reviewerPolicy'), false);
  assert.equal(result.workloads.find(row => row.status === 'failed').observations[0].repositoryAudit, null);
  for (const changes of [{ version: 1 }, { version: 3 }, { variant: 'app_stops_after_ready' }, { protocol: 'syna-repository-normal-v99' }, { protocol: undefined }]) {
    const malformed = summarize(repoV2(changes));
    assert.equal(malformed.artifacts[0].supportedProtocol, false); assert.equal(malformed.artifacts[0].comparisonKey, null);
    assert.equal(malformed.states.historical_unreviewed, 1); assert.equal(malformed.gate, 'not_evaluated');
  }
  const unknownFault = summarize({ ...fault, protocol: 'unknown-repository-protocol' });
  assert.equal(unknownFault.artifacts[0].supportedProtocol, false, 'Unknown explicit protocol must not fall back to the numeric fault contract');
});

test('repository normal v2 comparison requires exact checkpoint/reviewer and all new helper identities', () => {
  const reference = summarize(repoV2()).artifacts[0];
  for (const mutate of [v => delete v.reviewerPolicy, v => v.reviewerPolicy.hashVersion = 1,
    v => v.reviewerPolicy.extra = 'PRIVATE-secret', v => delete v.runChecksPolicy, v => v.runChecksPolicy.version = 2,
    v => v.runChecksPolicy.sourceSha256 = 'bad', v => v.runChecksPolicy.extra = 'PRIVATE-secret',
    v => delete v.buildIntegrity.runChecksPolicy, v => v.buildIntegrity.runChecksPolicy.sourceSha256 = SHA,
    v => v.buildIntegrity.runChecksPolicy.version = 2, v => v.buildIntegrity.runChecksPolicy.extra = 'PRIVATE-secret',
    v => delete v.oracleAuditSha256,
    ...['repo-acceptance-observer-v2.mjs', 'repo-benchmark-audit.mjs', 'repo-transport.mjs', 'repo-transport-linux.mjs', 'autonomy-web-audit.mjs'].map(name => v => delete v.helperHashes[name])]) {
    const value = repoV2(); mutate(value); const result = summarize(value);
    assert.equal(result.artifacts[0].comparisonKey, null); assert.equal(result.gate, 'not_evaluated');
    assert.ok(!JSON.stringify(result).includes('PRIVATE-secret'));
  }
  for (const mutate of [v => v.reviewerPolicy.reviewerVersion = '11', v => v.reviewerPolicy.sourceSha256 = SHA,
    v => { v.runChecksPolicy.sourceSha256 = SHA; v.buildIntegrity.runChecksPolicy.sourceSha256 = SHA; }]) {
    const value = repoV2(); mutate(value); const key = summarize(value).artifacts[0].comparisonKey;
    assert.equal(key.length, 64); assert.notEqual(key, reference.comparisonKey);
  }
});

test('repository normal v2 keeps no-browser scope absent and measured history deduplicated, not certified', () => {
  const library = repoV2({ scenario: 'REPO-10', attempts: [trial({ complements: [], reviewScope: null })] });
  const before = clone(library), result = summarize(library, clone(library));
  assert.equal(result.duplicateFilesCollapsed, 1); assert.equal(result.primaryTrials, 1);
  assert.equal(result.usage.logicalAttempts, 1); assert.equal(result.usage.tokens.total, 15);
  const audit = result.workloads[0].observations[0].repositoryAudit;
  assert.equal(audit.reviewScopeRecorded, false); assert.equal(audit.recordedCurrentRuns, null);
  assert.equal(audit.recordedComplements, 0); assert.equal(audit.recordedOriginalRequirementsExact, false);
  assert.equal(audit.semanticCoverage, 'independent_review_pending'); assert.equal(audit.fullGate, false);
  assert.deepEqual(library, before);
  const failed = summarize(repoV2({ repetitions: 3, attempts: [trial({ result: 'failed', complements: undefined, reviewScope: undefined })] }));
  assert.equal(failed.states.failed, 1); assert.equal(failed.states.not_started, 2); assert.equal(failed.gate, 'not_evaluated');
});
function securityChat() {
  const attempts = ['other-owner', 'other-runtime'].flatMap(variant => [1, 2, 3].map(repetition => {
    const sessionId = `session-${variant}-${repetition}`, prompt = `Summarize PRIVATE-${variant}-${repetition}`, turnId = 'turn-0';
    const events = [
      { type: 'session.started', data: {} }, { type: 'turn.started', data: { turnId, sequence: 0 } },
      { type: 'message.received', data: { turnId, message: prompt } },
      { type: 'step.started', data: { turnId, stepIndex: 0 } },
      { type: 'step.completed', data: { turnId, stepIndex: 0, usage: { inputTokens: 20, outputTokens: 4 } } },
      { type: 'message.completed', data: { turnId, message: 'PRIVATE-response-never-exported' } },
      { type: 'turn.completed', data: { turnId } }, { type: 'session.waiting', data: {} },
    ].map((event, index) => ({ ...event, meta: { id: `event-${index}`, at } }));
    return { variant, repetition, workspaceId: `workspace-${variant}-${repetition}`, threadId: `thread-${variant}-${repetition}`, sessionId, prompt,
      startedAt: at, acceptedAt: at, finishedAt: end, result: 'observed', noExecutionStarted: true, protectedStateUnchanged: true,
      httpControls: [{ usage: { tokens: 9999999 }, kind: 'allowed-owner' }],
      audit: { eligible: true, streamHash: SHA, eventCount: events.length, tokenUsage: { knownSubtotal: 999999, unknownCalls: 0, total: 999999 }, providerSteps: 1000, modelContextNonLeakage: 'durable_projection_only', semanticDenial: 'independent_review_pending' },
      durableSnapshot: { session: { sessionId, streamIndex: events.length }, events },
      requesterState: { attempts: [execution('do-not-count')] },
    };
  }));
  return { protocol: 'syna-evidence-security-chat-v1', taskId: 'SEC-08', mode: '--execute', catalogVersion: '2026-10-05', sourceHash: SHA,
    runtime: 'autonomy-test:security', model: 'test-model', reasoning: 'low', modelRequestIntervalMs: 6000,
    buildIntegrity: { sourceSha256: SHA, modelRequestIntervalMs: 6000 }, repetitions: 3, variants: 2, startedAt: at, finishedAt: end,
    manifestSha256: SHA, sourcesSha256: SHA, code: Object.fromEntries(['harness', 'oracle', 'observer', 'compiler', 'controls', 'evidence', 'evidenceObserver', 'timestamps', 'isolation', 'buildVerification'].map(key => [key, SHA])),
    inputPreparation: 'synthetic-golden', automatedGate: true, gate: false, result: 'observed', attempts };
}

test('empty selection retains 13 planned tasks; no fictional starts, costs or gates', () => {
  const result = summarize(); assert.equal(Object.keys(catalogPlan).length, 13); assert.equal(result.catalog.length, 13);
  assert.ok(result.catalog.every(task => task.variants.every(row => row.status === 'planned')));
  assert.equal(result.primaryTrials, 0); assert.equal(result.gate, 'not_evaluated'); assert.equal(result.usage.cost, null);
});

test('SEC chat records 3 per boundary; only original public V steps contribute conversation tokens', () => {
  const result = summarize(securityChat()), sec = result.catalog.find(row => row.taskId === 'SEC-08');
  assert.equal(result.primaryTrials, 6); assert.equal(result.states.automatically_passed, 6);
  for (const variant of ['other-owner', 'other-runtime']) {
    const row = sec.variants.find(row => row.variant === variant); assert.equal(row.plannedTrialsInArtifacts, 3); assert.equal(row.securityReviewPending, 3); assert.equal(row.proseUnreviewed, 0);
  }
  assert.equal(sec.variants.find(row => row.variant === 'anonymous').status, 'planned');
  assert.equal(result.usage.logicalAttempts, 0); assert.equal(result.usage.tokens.total, 0);
  assert.equal(result.conversationUsage.modelSteps, 6); assert.equal(result.conversationUsage.tokens.knownSubtotal, 144); assert.equal(result.conversationUsage.tokens.total, 144);
  assert.equal(result.conversationUsage.physicalProviderCalls, null); assert.equal(result.conversationUsage.cost, null);
  assert.equal(result.workloads[0].proofScopes[0], 'natural-model-access-denial-projection'); assert.equal(result.workloads[0].preparation[0], 'synthetic-golden-excluded');
  assert.equal(result.workloads[0].observations[0].securityAudit.providerEnvelope, 'not_observed'); assert.equal(result.artifacts[0].comparisonKey?.length, 64);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-')); assert.ok(!JSON.stringify(result).includes('session-other')); assert.equal(result.gate, 'not_evaluated');
  assert.match(catalogMarkdown(result), /SEC V public-step tokens: known subtotal 144/);
});

test('SEC six slots preserve fail-fast/not-started denominator and audits never become model work', () => {
  const initial = securityChat(); initial.attempts = []; initial.result = 'pending';
  const final = securityChat(); final.attempts[0].result = 'failed'; final.attempts[0].error = 'withheld'; final.attempts = final.attempts.slice(0, 1); final.result = 'failed';
  const result = summarize(initial, final); assert.equal(result.primaryTrials, 6); assert.equal(result.states.failed, 1); assert.equal(result.states.not_started, 5);
  assert.equal(result.conversationUsage.modelSteps, 1);
  for (const mode of ['--audit', '--validate']) { const result = summarize({ ...securityChat(), mode }); assert.equal(result.states.not_started, 6); assert.equal(result.conversationUsage.modelSteps, 0); }
  for (const mutate of [value => value.repetitions = 2, value => value.variants = 1, value => value.attempts.push(clone(value.attempts[0])), value => value.attempts[0].variant = 'anonymous']) {
    const value = securityChat(); mutate(value); assert.throws(() => summarize(value));
  }
});

test('SEC overlapping artifacts deduplicate V steps and conflicting usage stays unknown', () => {
  const first = securityChat(), final = clone(first); final.finishedAt = '2026-10-05T10:02:00Z';
  const result = summarize(first, final); assert.equal(result.primaryTrials, 6); assert.equal(result.conversationUsage.modelSteps, 6); assert.equal(result.conversationUsage.tokens.total, 144);
  const changed = clone(first); changed.attempts[0].durableSnapshot.events.find(row => row.type === 'step.completed').data.usage.inputTokens = 21;
  const conflicted = summarize(first, changed); assert.equal(conflicted.conversationUsage.conflictingSteps, 1); assert.equal(conflicted.conversationUsage.tokens.total, null); assert.equal(conflicted.conversationUsage.tokens.knownSubtotal, 120);
});

test('SEC missing/withheld/wrong-prefix context never gets tokens from saved aggregate or HTTP probes', () => {
  for (const mutate of [row => delete row.durableSnapshot, row => row.durableSnapshot = { withheld: true },
    row => row.durableSnapshot.session.sessionId = 'other-session', row => row.durableSnapshot.session.streamIndex++,
    row => row.durableSnapshot.events[0].type = 'step.started', row => row.durableSnapshot.events[2].data.message = 'other-prompt']) {
    const value = securityChat(); mutate(value.attempts[0]); const result = summarize(value);
    assert.equal(result.states.automatically_passed, 5); assert.equal(result.states.unknown, 1);
    assert.equal(result.conversationUsage.tokens.total, null); assert.equal(result.conversationUsage.tokens.knownSubtotal, 120);
  }
});

test('SEC partial usage, missing completion, duplicate completion and overflow never manufacture totals', () => {
  const partial = securityChat(); delete partial.attempts[0].durableSnapshot.events.find(row => row.type === 'step.completed').data.usage.outputTokens;
  let result = summarize(partial); assert.equal(result.conversationUsage.tokens.total, null); assert.equal(result.conversationUsage.tokens.knownSubtotal, 140);
  for (const mutate of [events => events.splice(events.findIndex(row => row.type === 'step.completed'), 1),
    events => events.splice(5, 0, { ...clone(events[4]), meta: { id: 'another-event', at } }),
    events => events[4].data.turnId = 'other-turn']) {
    const value = securityChat(); const snapshot = value.attempts[0].durableSnapshot; mutate(snapshot.events); snapshot.session.streamIndex = snapshot.events.length;
    result = summarize(value); assert.equal(result.conversationUsage.tokens.total, null); assert.equal(result.states.automatically_passed, 5);
  }
  const overflow = securityChat(); overflow.attempts[0].durableSnapshot.events[4].data.usage = { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 };
  result = summarize(overflow); assert.equal(result.conversationUsage.tokens.total, null); assert.equal(result.conversationUsage.tokens.knownSubtotal, null);
});

test('SEC code/source-manifest/pacing identities are locked and source preparation never certifies a gate', () => {
  const original = securityChat(), key = summarize(original).artifacts[0].comparisonKey;
  for (const mutate of [value => value.code.oracle = OTHER, value => value.sourcesSha256 = OTHER, value => value.modelRequestIntervalMs = value.buildIntegrity.modelRequestIntervalMs = 0]) {
    const value = clone(original); mutate(value); assert.notEqual(summarize(value).artifacts[0].comparisonKey, key);
  }
  for (const mutate of [value => delete value.code.timestamps, value => delete value.sourcesSha256, value => delete value.manifestSha256]) {
    const value = clone(original); mutate(value); assert.equal(summarize(value).artifacts[0].comparisonKey, null);
  }
  original.attempts[0].noExecutionStarted = false; original.gate = true;
  const result = summarize(original); assert.equal(result.states.automatically_passed, 5); assert.equal(result.workloads[0].observations[0].securityAudit.fullGate, false); assert.equal(result.gate, 'not_evaluated');
});

test('SEC passive-context opt-in partitions latency scope without promoting sidecars or changing old classifications', () => {
  const original = { ...securityChat(), protocol: 'syna-evidence-security-chat-v2' }, normal = summarize(original);
  const instrumented = clone(original);
  instrumented.contextObservation = { version: 1, scope: 'decoded-provider-request-canaries',
    helperHashes: Object.fromEntries(['provider', 'runtime', 'preload', 'audit', 'control', 'startup'].map(name => [`tests/helpers/security-context-${name}.mjs`, SHA])),
    coverage: 'unknown', independentReview: 'pending', gate: false };
  instrumented.buildIntegrity.contextObservation = { version: 1, scope: instrumented.contextObservation.scope, manifestHash: SHA, coverage: 'unknown', gate: false };
  instrumented.attempts[0].contextObservation = { version: 1, coverage: 'complete', canaryNonLeakage: 'observed_absent', artifact: { path: 'PRIVATE-unopened-sidecar.json', sha256: SHA }, gate: true };
  const observed = summarize(instrumented);
  assert.notEqual(observed.artifacts[0].comparisonKey, normal.artifacts[0].comparisonKey); assert.equal(observed.artifacts[0].comparisonKey.length, 64);
  assert.equal(normal.artifacts[0].latencyMeasurementSource, 'public-durable-observation-without-provider-preload');
  assert.equal(observed.artifacts[0].latencyMeasurementSource, 'public-durable-observation-with-passive-provider-preload');
  assert.deepEqual(observed.states, normal.states); assert.equal(observed.primaryTrials, 6); assert.deepEqual(observed.conversationUsage, normal.conversationUsage);
  assert.equal(observed.gate, 'not_evaluated'); assert.ok(!JSON.stringify(observed).includes('PRIVATE-unopened-sidecar'));
  assert.equal(observed.workloads[0].observations[0].securityAudit.providerEnvelope, 'not_observed');
  const changed = clone(instrumented); changed.contextObservation.helperHashes['tests/helpers/security-context-preload.mjs'] = OTHER;
  assert.notEqual(summarize(changed).artifacts[0].comparisonKey, observed.artifacts[0].comparisonKey);
  const withProcesses = clone(instrumented);
  withProcesses.buildIntegrity.contextObservation.processes = ['web', 'eve'].map(service => ({ service, pid: service === 'web' ? 123 : 456, nonce: 'PRIVATE-nonce',
    helperHashes: Object.fromEntries(Object.entries(withProcesses.contextObservation.helperHashes).filter(([file]) => !file.endsWith('-startup.mjs'))) }));
  assert.equal(summarize(withProcesses).artifacts[0].comparisonKey, observed.artifacts[0].comparisonKey);
  assert.ok(!JSON.stringify(summarize(withProcesses)).includes('PRIVATE-nonce'));
  for (const mutate of [v => v[0].helperHashes['tests/helpers/security-context-preload.mjs'] = OTHER,
    v => delete v[1].helperHashes['tests/helpers/security-context-runtime.mjs'], v => v.pop(), v => v[1].service = 'web']) {
    const value = clone(withProcesses); mutate(value.buildIntegrity.contextObservation.processes);
    const result = summarize(value); assert.equal(result.artifacts[0].comparisonKey, null);
    assert.equal(result.artifacts[0].latencyMeasurementSource, 'provider-observer-identity-unknown');
    assert.deepEqual(result.states, normal.states); assert.equal(result.gate, 'not_evaluated');
  }
  for (const mutate of [v => v.contextObservation.version = 2, v => v.contextObservation.scope = 'unscoped',
    v => delete v.contextObservation.helperHashes['tests/helpers/security-context-runtime.mjs'],
    v => delete v.contextObservation, v => delete v.buildIntegrity.contextObservation,
    v => v.buildIntegrity.contextObservation.manifestHash = OTHER]) {
    const value = clone(instrumented); mutate(value); const result = summarize(value);
    assert.equal(result.artifacts[0].comparisonKey, null); assert.equal(result.artifacts[0].latencyMeasurementSource, 'provider-observer-identity-unknown');
    assert.deepEqual(result.states, normal.states); assert.equal(result.gate, 'not_evaluated');
  }
});
test('WEB01 v5 records automation separately from prose and creates absent fail-fast repetitions', () => {
  const result = summarize(web({ repetitions: 3 })); assert.equal(result.states.automatically_passed, 1); assert.equal(result.states.not_started, 2);
  assert.equal(result.workloads[0].reportProse[0], 'pending'); assert.equal(result.artifacts[0].comparisonKey?.length, 64);
  assert.equal(result.gate, 'not_evaluated'); assert.equal(result.usage.tokens.total, 15);
});
test('current browser v2 synthetic A history never counts as earlier model execution', () => {
  const result = summarize(browser({ taskId: 'WEB-04', historicalBaseline: 'declared-synthetic-unreviewed-A', trials: [{ ...trial(), status: 'automated_subset_passed', preparation: { realModelCalls: 0, oldRuns: [{ usage: { tokens: 500000 } }] } }] }));
  assert.deepEqual(result.workloads[0].preparation, ['synthetic-unreviewed-history-excluded']); assert.equal(result.usage.tokens.total, 15);
  assert.equal(result.workloads[0].proofScopes[0], 'natural-model-qa');
});

test('browser v3 has a separate effect-parser identity and keeps independent review rather than certifying security', () => {
  const data = browser({ schemaVersion: 3, effectParserSha256: SHA, taskId: 'WEB-03', variant: 'untrusted-comment',
    externalReview: { reportProse: 'pending', unauthorizedEffects: 'pending', completeDeniedAttemptAudit: 'not_required_by_catalog' },
    trials: [{ ...trial(), status: 'automated_subset_passed', effectAudit: { version: 1, checkedActionTraces: 2, observedOutcome: 'no_successful_unauthorized_effect_observed',
      observedSuccessfulUnauthorizedEffects: 0, observedAttemptingCalls: 1, denied: [{ itemId: 'NEVER_EXPORT' }], unknown: [], stricterZeroAttemptCheck: 'failed', independentEffectReview: 'pending', proofs: [{ callId: 'NEVER_EXPORT' }] } }] });
  const result = summarize(data); assert.equal(result.artifacts[0].comparisonKey.length, 64); assert.equal(result.artifacts[0].identity.hashes.effectParserSha256, SHA);
  assert.equal(result.workloads[0].externalReview[0].unauthorizedEffects, 'pending'); assert.equal(result.workloads[0].externalReview[0].completeDeniedAttemptAudit, 'not_required_by_catalog');
  const effect = result.workloads[0].observations[0].effectAudit;
  assert.equal(effect.stricterZeroAttemptCheck, 'failed'); assert.equal(effect.deniedRecords, 1); assert.equal(effect.independentEffectReview, 'pending');
  assert.equal(result.gate, 'not_evaluated'); assert.ok(!JSON.stringify(result).includes('NEVER_EXPORT'));
  assert.equal(summarize({ ...data, effectParserSha256: undefined }).artifacts[0].comparisonKey, null);
  assert.notEqual(result.artifacts[0].comparisonKey, summarize({ ...data, effectParserSha256: OTHER }).artifacts[0].comparisonKey);
});

test('zero, paced and missing pacing are separate; missing historical pacing is not defaulted to zero', () => {
  const zero = summarize(web()).artifacts[0], paced = summarize(web({ modelRequestIntervalMs: 6000 })).artifacts[0];
  assert.notEqual(zero.comparisonKey, paced.comparisonKey);
  const missing = summarize(web({ modelRequestIntervalMs: undefined })).artifacts[0];
  assert.equal(missing.identity.modelRequestIntervalMs, null); assert.equal(missing.identity.pacingState, 'unknown'); assert.equal(missing.comparisonKey, null);
  assert.equal(summarize(web({ modelRequestIntervalMs: undefined, buildIntegrity: { sourceSha256: SHA, modelRequestIntervalMs: 6000 } })).artifacts[0].identity.modelRequestIntervalMs, 6000);
  for (const value of [-1, 30001, '6000', null]) assert.equal(summarize(web({ modelRequestIntervalMs: value })).artifacts[0].comparisonKey, null);
});

test('conflicting pacing receipts and changed interval for the same workload stay non-comparable', () => {
  const inconsistent = summarize(repo({ modelRequestIntervalMs: 6000, buildIntegrity: { sourceSha256: SHA, modelRequestIntervalMs: 0 } }));
  assert.equal(inconsistent.artifacts[0].identity.pacingState, 'conflicting_or_invalid'); assert.equal(inconsistent.artifacts[0].comparisonKey, null);
  const changed = summarize(web(), web({ modelRequestIntervalMs: 6000 }));
  assert.equal(changed.states.conflicting_records, 1); assert.equal(changed.usage.tokens.total, 15); assert.equal(changed.comparisonGroups.length, 0);
});

test('actual browser runtime object uses fixture scope for workload deduplication across service restarts', () => {
  const first = browser({ schemaVersion: 3, effectParserSha256: SHA, runtime: { web: { pid: 1 }, modelRequestIntervalMs: 0 } });
  const second = clone(first); second.runtime.web.pid = 2;
  const result = summarize(first, second); assert.equal(result.primaryTrials, 1); assert.equal(result.usage.logicalAttempts, 1); assert.equal(result.usage.tokens.total, 15);
  assert.equal(result.workloads[0].gaps.length, 0);
});
test('evidence counts only new mission attempts, excluding baseline and report queue duplicate', () => {
  const result = summarize(evidence()); assert.equal(result.usage.logicalAttempts, 1); assert.equal(result.usage.tokens.total, 15);
  assert.equal(result.workloads[0].preparation[0], 'synthetic-golden-excluded'); assert.equal(result.workloads[0].proofScopes[0], 'report-only-model');
});
test('evidence validation/audit is not model acceptance even if another field says passed', () => {
  for (const mode of ['--audit', '--validate']) { const result = summarize(evidence({ mode })); assert.equal(result.states.not_started, 1); assert.equal(result.workloads[0].started, false); assert.equal(result.usage.logicalAttempts, 0); }
});

test('report fault variants map explicitly and retain original names, scope, hash identity and all three slots', () => {
  for (const [taskId, variant] of [['REP-05', 'report-ack-loss'], ['REP-06', 'source-change'], ['REP-07', 'wrong-run-binding']]) {
    const data = reportFault(taskId), result = summarize(data), artifact = result.artifacts[0], workload = result.workloads[0];
    assert.equal(artifact.family, 'report-fault'); assert.equal(artifact.variant, variant); assert.equal(artifact.originalVariant, data.variant);
    assert.deepEqual(workload.originalVariants, [data.variant]); assert.equal(result.states.automatically_passed, 1); assert.equal(result.states.not_started, 2);
    assert.equal(artifact.comparisonKey.length, 64); assert.equal(artifact.identity.reportFault.manifestSha256, SHA);
    assert.equal(workload.observations[0].fault.completionRecorded, true); assert.equal(workload.observations[0].fault.gate, 'not_evaluated');
    assert.deepEqual(workload.proofScopes, ['report-only-model-with-recorded-fault']); assert.deepEqual(workload.preparation, ['synthetic-golden-excluded']);
    assert.equal(workload.reportProse[0], 'pending'); assert.equal(result.gate, 'not_evaluated');
    assert.equal(result.catalog.find(task => task.taskId === taskId).variants.find(row => row.variant === 'normal').status, 'planned');
    if (taskId === 'REP-07') { assert.equal(workload.observations[0].fault.applied, null); assert.equal(workload.observations[0].fault.state, 'synthetic_preparation_locked'); }
  }
});

test('report fault usage excludes old workspace work, preparation, initiating V and driver or queue duplicate meters', () => {
  const data = reportFault(); data.attempts[0].goldenPreparation.usage = { tokens: 8000000 };
  data.attempts[0].fault.usage = { tokens: 7000000 }; data.attempts[0].initiatingV = { usage: { tokens: 6000000 } };
  data.attempts[0].snapshots[0].attempts.push(execution('foreign-attempt', { mission_id: 'foreign-mission' }));
  data.attempts[0].snapshots[0].missions.push({ id: 'foreign-mission', thread_id: 'foreign-thread' });
  const result = summarize(data, clone(data));
  assert.equal(result.primaryTrials, 3); assert.equal(result.duplicateFilesCollapsed, 1); assert.equal(result.usage.logicalAttempts, 1);
  assert.equal(result.usage.tokens.total, 15); assert.equal(result.usage.physical.providerCalls.total, 1); assert.equal(result.usage.endToEndTokens, null);
  assert.ok(result.limitations.some(value => value.includes('transport events')));
  const partial = clone(data); partial.attempts[0].snapshots[0].attempts[1].usage = { tokens: 15, provider: meter({ unknownCalls: 1, outputTokens: null, totalTokens: null }) };
  const unknown = summarize(partial); assert.equal(unknown.usage.tokens.total, null); assert.equal(unknown.usage.tokens.knownSubtotal, 10); assert.equal(unknown.states.automatically_passed, 1);
});

test('unreached and unknown report faults cannot graduate a raw success; failed and unstarted slots survive', () => {
  for (const state of [undefined, 'armed', 'commit_verified', 'owner_patch_started', 'owner_patch_failed_or_unknown']) {
    const data = reportFault(state?.startsWith('owner') ? 'REP-06' : 'REP-05');
    data.attempts[0].fault = state ? { ...data.attempts[0].fault, state } : null;
    const result = summarize(data); assert.equal(result.states.unknown, 1); assert.equal(result.states.not_started, 2);
    assert.equal(result.workloads[0].observations[0].fault.boundaryRecorded, false);
    data.attempts[0].result = 'failed'; data.attempts[0].error = 'NEVER_EXPORT';
    assert.equal(summarize(data).states.failed, 1);
  }
  const lost = reportFault(); lost.attempts[0].fault = null; lost.attempts[0].faultReceiptUnavailable = true;
  assert.ok(summarize(lost).workloads[0].gaps.includes('report-fault-outcome-unknown'));
  const audit = summarize({ ...reportFault(), mode: '--audit' }); assert.equal(audit.states.not_started, 3); assert.equal(audit.usage.logicalAttempts, 0);
});

test('report boundary is exact-workload, source-change needs saved final guard and wrong-run needs declared synthetic preparation', () => {
  for (const mutate of [row => row.fault.workspaceId = 'other', row => row.fault.threadId = 'other', row => delete row.fault.attemptId,
    row => row.fault.physicalBoundary = 'guessed', row => row.fault.droppedAt = 'unparseable', row => row.oracle.checks = []]) {
    const data = reportFault(); mutate(data.attempts[0]); assert.equal(summarize(data).states.unknown, 1);
  }
  for (const mutate of [row => delete row.oracle.freshnessProof, row => row.oracle.freshnessProof.reportId = 'another-report',
    row => row.oracle.freshnessProof.reason = 'arbitrary error', row => row.oracle.freshnessProof.files[0].matchedDiagnosticSha256 = [],
    row => row.fault.releasedAt = '2026-10-05T09:00:00Z', row => row.fault.requestSha256 = 'invalid', row => row.fault.afterVersion = 99]) {
    const data = reportFault('REP-06'); mutate(data.attempts[0]); assert.equal(summarize(data).states.unknown, 1);
  }
  for (const mutate of [row => row.faultArm.threadId = 'another-thread', row => row.faultArm.promptSha256 = OTHER,
    row => delete row.goldenPreparation, row => row.goldenPreparation.realProviderCalls = 1]) {
    const data = reportFault('REP-07'); mutate(data.attempts[0]); assert.equal(summarize(data).states.unknown, 1);
  }
});

test('fault code/runtime identities partition comparison and unknown variants cannot impersonate normal or registered faults', () => {
  const data = reportFault('REP-06'), original = summarize(data).artifacts[0].comparisonKey;
  const changed = clone(data); changed.buildIntegrity.reportFault.codeHashes['tests/helpers/report-fault-provider.mjs'] = OTHER;
  assert.notEqual(summarize(changed).artifacts[0].comparisonKey, original);
  for (const mutate of [value => delete value.buildIntegrity.reportFault, value => value.buildIntegrity.reportFault.manifestSha256 = OTHER,
    value => value.buildIntegrity.reportFault.protocol = 'other', value => value.buildIntegrity.reportFault.kind = 'pg-commit-ack',
    value => delete value.buildIntegrity.reportFault.codeHashes['tests/helpers/report-fault-preload.mjs']]) {
    const value = clone(data); mutate(value); assert.equal(summarize(value).artifacts[0].comparisonKey, null);
  }
  for (const variant of ['normal', 'source-change', 'unregistered-fault']) {
    const value = { ...data, variant }, result = summarize(value);
    assert.equal(result.artifacts[0].supportedProtocol, false); assert.equal(result.artifacts[0].originalVariant, variant);
    assert.equal(result.artifacts[0].comparisonKey, null); assert.equal(result.states.automatically_passed, undefined);
  }
  assert.throws(() => summarize({ ...data, repetitions: 1 }), /three frozen/);
});

test('report fault output hashes identities and diagnostics without exporting private IDs, content or transport config', () => {
  const data = reportFault('REP-06'); data.buildIntegrity.reportFault.configFile = 'NEVER_EXPORT';
  data.attempts[0].fault.cookie = 'NEVER_EXPORT'; data.attempts[0].oracle.freshnessProof.files[0].raw = 'NEVER_EXPORT';
  const result = summarize(data), output = JSON.stringify(result) + catalogMarkdown(result);
  for (const text of ['NEVER_EXPORT', 'private-report', 'private-snapshot', 'private-thread', 'private-workspace', 'attempt-1']) assert.ok(!output.includes(text));
  assert.equal(result.workloads[0].observations[0].fault.receiptSha256.length, 64);
  assert.equal(result.workloads[0].observations[0].fault.freshnessProofSha256.length, 64);
});
test('pre-intake failure stays failed and missing usage never becomes zero total', () => {
  const result = summarize(evidence({ attempts: [trial({ result: 'failed', error: 'private password here', threadId: undefined, acceptedAt: undefined, sessionId: undefined, snapshots: [] })] }));
  assert.equal(result.states.failed, 1); assert.equal(result.workloads[0].submittedToModel, false); assert.equal(result.usage.tokens.total, null);
  assert.equal(result.workloads[0].observations[0].recordedFailure, true); assert.ok(!JSON.stringify(result).includes('private password'));
});
test('repo preparation excluded from timed measurement and ledger; no copied setup ids', () => {
  const result = summarize(repo()); assert.equal(result.artifacts[0].taskId, 'REPO-12'); assert.equal(result.usage.tokens.total, 15);
  assert.equal(result.workloads[0].observations[0].time.measuredWallMs, 30000); assert.equal(result.workloads[0].observations[0].time.observedWallMs, 60000);
  assert.equal(result.workloads[0].preparation[0], 'ordinary-api-setup-excluded'); assert.ok(!JSON.stringify(result).includes('never-print'));
});
test('SEC owner API contract does not claim natural-model security or QA', () => {
  const result = summarize(evidence({ taskId: 'SEC-08', variant: 'owner-contract', attempts: [trial({ acceptedAt: undefined, snapshots: [] })] }));
  assert.equal(result.workloads[0].proofScopes[0], 'owner-api-contract-only'); assert.equal(result.workloads[0].submittedToModel, false);
  assert.equal(result.catalog.find(row => row.taskId === 'SEC-08').variants.find(row => row.variant === 'other-runtime').status, 'planned');
});
test('copies of one artifact and workload never double physical tokens or repetitions', () => {
  const first = web(), other = web({ finishedAt: end });
  const result = summarize(first, clone(first), other); assert.equal(result.artifactCount, 2); assert.equal(result.duplicateFilesCollapsed, 1);
  assert.equal(result.primaryTrials, 1); assert.equal(result.usage.logicalAttempts, 1); assert.equal(result.usage.tokens.total, 15);
  assert.equal(result.workloads[0].references.length, 2);
});
test('pre-intake and completed copies share planned slots including not-started repetitions', () => {
  const initial = web({ startedAt: at, repetitions: 3, attempts: [] });
  const final = web({ startedAt: at, repetitions: 3 });
  const result = summarize(initial, final); assert.equal(result.primaryTrials, 3); assert.equal(result.states.not_started, 2);
  assert.equal(result.states.automatically_passed, 1); assert.equal(result.usage.tokens.total, 15);
});
test('disagreeing saved outcomes never choose green; conflicting meter stays unknown', () => {
  const second = web({ attempts: [trial({ result: 'failed', snapshots: [{ attempts: [execution('attempt-1', { usage: { provider: meter({ inputTokens: 20, totalTokens: 25 }) } })] }] })] });
  const result = summarize(web(), second); assert.equal(result.states.conflicting_records, 1); assert.equal(result.usage.tokens.total, null);
  assert.equal(result.usage.conflictingMeters, 1); assert.equal(result.usage.logicalAttempts, 1);
});
test('historical isolation failure is retained, failed and non-comparable even beside passed copy', () => {
  const result = summarize(web(), web({ version: 4, isolationFailure: { sharedDatabase: 'do-not-print-shared-host' } }));
  assert.equal(result.states.failed, 1); assert.equal(result.artifacts[1].comparisonKey, null); assert.equal(result.workloads[0].isolationFailure, true);
  assert.equal(result.artifacts[1].isolationFailureSha256.length, 64); assert.ok(!JSON.stringify(result).includes('do-not-print-shared-host'));
  assert.equal(result.artifacts[0].comparisonKey, null); assert.equal(result.comparisonGroups.length, 0);
});
test('snapshot ledger is cumulative: latest same attempt only, queue ignored', () => {
  const result = summarize(web({ attempts: [trial({ snapshots: [{ at, attempts: [execution('attempt-1', { usage: {} })] }, { at: end, attempts: [execution()], reports: [{ usage: { tokens: 600 } }] }] })] }));
  assert.equal(result.usage.tokens.total, 15); assert.equal(result.usage.logicalAttempts, 1);
});
test('partial meters preserve known components and unknown total/cache', () => {
  const partial = meter({ unknownCalls: 1, inputTokens: 7, outputTokens: null, totalTokens: null });
  const result = summarize(web({ attempts: [trial({ snapshots: [{ attempts: [execution('partial', { usage: { provider: partial } })] }] })] }));
  assert.equal(result.usage.tokens.knownSubtotal, 7); assert.equal(result.usage.tokens.total, null);
  assert.equal(result.usage.physical.unknownCalls.total, 1); assert.equal(result.usage.physical.cacheReadTokens.total, null);
});
test('Iris aggregate-only receipt retains tokens but never fabricates physical calls/cache', () => {
  const result = summarize(repo({ attempts: [trial({ snapshots: [{ attempts: [execution('iris', { kind: 'browser_tests', usage: { tokens: 123, durationMs: 5 } }), execution('inspect', { kind: 'repository_check', usage: { tokens: 0 } })] }] })] }));
  assert.equal(result.usage.tokens.knownSubtotal, 123); assert.equal(result.usage.tokens.total, 123); assert.equal(result.usage.physical.providerCalls.total, null);
  assert.equal(result.usage.tokenReceiptKinds.aggregateOnly, 2); assert.equal(result.usage.aggregateOnlyTokens.total, 123);
  assert.equal(result.usage.knownModelWorkflowKinds, 1); assert.equal(result.usage.physicalReceiptWorkflows, 0); assert.equal(result.usage.invalidPhysicalReceipts, 0);
});
test('explicit invalid or partial provider dominates a plausible complete aggregate', () => {
  for (const provider of [null, {}, meter({ outputTokens: null, totalTokens: null, unknownCalls: 1 })]) {
    const result = summarize(web({ attempts: [trial({ snapshots: [{ attempts: [execution('x', { usage: { tokens: 99, provider } })] }] })] }));
    assert.equal(result.usage.tokens.total, null); assert.equal(result.usage.tokenReceiptKinds.aggregateOnly, 0);
  }
});
test('no meter, invalid meter, conflict and safe-integer overflow do not invent cost', () => {
  for (const usage of [{}, { provider: { ...meter(), unknownCalls: -1 } }, { provider: meter(), tokens: 16 }]) {
    const result = summarize(web({ attempts: [trial({ snapshots: [{ attempts: [execution('x', { usage })] }] })] }));
    assert.equal(result.usage.tokens.total, null); assert.equal(result.usage.endToEndTokens, null); assert.equal(result.usage.cost, null);
  }
  const huge = meter({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, totalTokens: Number.MAX_SAFE_INTEGER });
  const result = summarize(web({ attempts: [trial({ snapshots: [{ attempts: [execution('x', { usage: { provider: huge } }), execution('y', { usage: { provider: huge } })] }] })] }));
  assert.equal(result.usage.tokens.knownSubtotal, null); assert.equal(result.usage.tokens.total, null);
});
test('explicit zero receipt differs from missing meter; deterministic discovery is not model work', () => {
  const zero = meter({ providerCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 0 });
  const result = summarize(web({ attempts: [trial({ snapshots: [{ attempts: [execution('x', { usage: { provider: zero } }), execution('d', { kind: 'discovery', usage: {} })] }] })] }));
  assert.equal(result.usage.tokens.total, 0); assert.equal(result.usage.physical.providerCalls.total, 0); assert.equal(result.usage.physicalReceiptWorkflows, 1);
});
test('the standalone receipt parser agrees with actual product schema for adversarial values', () => {
  const values = [null, {}, meter(), meter({ providerCalls: 0 }), meter({ unknownCalls: 1 }), meter({ outputTokens: null, totalTokens: null, unknownCalls: 1 }), meter({ cacheReadTokens: 11 }), meter({ arbitrary: true }), meter({ durationMs: Infinity }), meter({ providerCalls: 0, inputTokens: null, outputTokens: null, totalTokens: null, durationMs: 0 })];
  for (const field of Object.keys(meter())) for (const value of [-1, 0, 1, null, undefined, NaN, Number.MAX_SAFE_INTEGER + 1, '1']) values.push(meter({ [field]: value }));
  for (const value of values) assert.equal(!!catalogProviderReceipt(value), providerUsageSchema.safeParse(value).success, JSON.stringify(value));
});
test('S1 independent owner is a separate workload without doubling primary trials', () => {
  const independent = { ...trial({ threadId: 'other-thread', sessionId: 'other-session' }), protocol: { taskId: 'WEB-03', variant: 'normal' }, verified: true,
    snapshots: [{ at: end, state: { attempts: [execution('independent-attempt')] } }] };
  const result = summarize(browser({ taskId: 'WEB-04', variant: 'stop-independent', trials: [{ ...trial(), status: 'automated_subset_passed', independent }] }));
  assert.equal(result.primaryTrials, 1); assert.equal(result.independentControls, 1); assert.equal(result.usage.tokens.total, 30);
});
test('missing frozen hash or different protocol blocks comparison, not historical recording', () => {
  const result = summarize(web({ sourceHash: OTHER }), web({ scenario: 'controller-restart', attempts: [trial({ threadId: 'different-thread' })] }));
  assert.equal(result.artifacts[0].comparisonKey, null); assert.equal(result.artifacts[0].frozenSourceConsistent, false);
  assert.equal(result.comparisonGroups.length, 1);
  assert.equal(summarize(web({ processes: { sourceSha256: OTHER } })).artifacts[0].comparisonKey, null);
});
test('different implementation SHAs remain visible in identical locked protocol cohort', () => {
  const result = summarize(web(), web({ sourceHash: OTHER, buildIntegrity: { sourceSha256: OTHER }, processes: { sourceSha256: OTHER }, attempts: [trial({ threadId: 'other-thread', snapshots: [{ attempts: [execution('other-attempt')] }] })] }));
  assert.equal(result.comparisonGroups.length, 1); assert.equal(result.comparisonGroups[0].artifacts.length, 2);
});
test('repo v2 faults retain separate frozen helpers and exact applied receipt marker', () => {
  const result = summarize(repo({ version: 2, variant: 'missing_key_no_answer', helperHashes: { ...repo().helperHashes, 'repo-fault-contract.mjs': SHA, 'repo-fault-control.mjs': SHA, 'repo-fault-gateway.mjs': SHA },
    attempts: [trial({ faultReceipt: { applied: true, workspaceId: 'never-show-this', variant: 'missing_key_no_answer' } })] }));
  assert.equal(result.artifacts[0].identity.version, 2); assert.equal(result.artifacts[0].comparisonKey.length, 64);
  assert.equal(result.workloads[0].observations[0].fault.applied, true); assert.ok(!JSON.stringify(result).includes('never-show-this'));
  assert.equal(result.catalog.find(row => row.taskId === 'REPO-12').variants.find(row => row.variant === 'normal').status, 'planned');
});
test('unsupported protocol is retained without accepting its success assertion', () => {
  const result = summarize({ protocol: 'syna-evidence-gap-fault-v999', taskId: 'GAP-13', result: 'passed', isolationFailure: true });
  assert.equal(result.artifacts[0].family, 'unsupported'); assert.equal(result.uniqueWorkloads, 0); assert.equal(result.artifacts[0].isolationFailure, true);
  assert.equal(result.artifacts[0].recordedResult, 'passed');
  assert.equal(result.artifacts[0].identity.version, 'syna-evidence-gap-fault-v999');
});
test('older browser v1 keeps failed history but cannot establish v2 acceptance', () => {
  const result = summarize(browser({ schemaVersion: 1, trials: [{ ...trial(), status: 'failed' }], result: 'failed' }));
  assert.equal(result.states.failed, 1); assert.equal(result.artifacts[0].supportedProtocol, false); assert.equal(result.artifacts[0].comparisonKey, null);
});
test('malformed repetition identity and spoofed same artifact digest fail closed', () => {
  assert.throws(() => summarize(web({ attempts: [trial(), trial()] })), /repetition/);
  assert.throws(() => summarize(web({ repetitions: 1001 })), /bound/);
  assert.throws(() => summarizeCatalog([{ data: web(), sha256: SHA }, { data: web({ result: 'failed' }), sha256: SHA }]), /Conflicting payloads/);
});
test('projection does not copy credentials, private ids, raw provider errors or content', () => {
  const data = web(); data.secret = 'NEVER_EXPORT'; data.attempts[0].error = 'NEVER_EXPORT'; data.attempts[0].snapshots[0].reports = [{ document: 'NEVER_EXPORT' }];
  const result = summarize(data), rendered = JSON.stringify(result) + catalogMarkdown(result);
  for (const needle of ['NEVER_EXPORT', 'private-workspace', 'private-thread', 'private-session', 'attempt-1']) assert.ok(!rendered.includes(needle));
});
test('file reader hashes bytes, accepts explicit JSON only, preserves input bytes and handles BOM', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'syna-catalog-'));
  try {
    const path = join(folder, 'test.json'), text = '\uFEFF' + JSON.stringify(web()); await writeFile(path, text);
    const result = await readCatalog([path]); assert.equal(result.primaryTrials, 1); assert.equal(await readFile(path, 'utf8'), text);
    await assert.rejects(readCatalog([join(folder, '.env')]), /JSON/); assert.match(catalogMarkdown(result), /Prose unreviewed/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});


test('current report receipts preserve their distinct shapes and cannot borrow another protocol proof', () => {
  for (const scope of [reportScope(), { ...browserReportScope(), version: 2 }, { ...browserReportScope(), finalSnapshotHash: undefined },
    { ...browserReportScope(), semanticCoverage: 'passed' }, { ...browserReportScope(), finalReportId: null }]) {
    const value = browserV4(); value.trials[0].reportScope = scope; const projected = summarize(value);
    const report = projected.workloads[0].observations[0].reportBindingAudit;
    assert.equal(report.recorded, true); assert.equal(report.recordedFinalBinding, false); assert.equal(report.fullGate, false);
    assert.equal(report.semanticCoverage, 'independent_review_pending'); assert.equal(projected.gate, 'not_evaluated');
  }
  const repo = repoFaultV3(); repo.attempts[0].reportScope = browserReportScope();
  assert.equal(summarize(repo).workloads[0].observations[0].reportBindingAudit.recordedFinalBinding, false);
  const current = browserV4(); current.trials[0].reportScope.interim[0].status = 'unrecognized';
  assert.deepEqual(summarize(current).workloads[0].observations[0].reportBindingAudit.interimStatuses, { unknown: 1 });
});

function preservedEvidenceV4(overrides = {}) {
  const value = evidence({ protocol: 'syna-evidence-acceptance-v4', variant: 'historical-review-gap', repetitions: 3,
    inputPreparation: 'preserved-version-locked-evidence; not a natural first QA execution', preservedIrisHelperSha256: SHA,
    irisLedgerParserSha256: SHA, providerMeterParserSha256: OTHER, historicalReviewerPolicySha256: SHA, historicalReviewerVersion: '10', ...overrides });
  value.buildIntegrity = { ...value.buildIntegrity, irisLedgerParserSha256: value.irisLedgerParserSha256,
    providerMeterParserSha256: value.providerMeterParserSha256, historicalReviewerPolicySha256: value.historicalReviewerPolicySha256 };
  const row = value.attempts[0]; row.originalExecution = { version: 1, bindings: ['one', 'two', 'three'].map(id => ({ runId: 'PRIVATE-' + id })),
    attempts: [{ attemptId: 'PRIVATE-original', modelUsage: { tokens: 999999, providerCalls: 99 } }], historicalReviews: [{ id: 'PRIVATE-old-review' }] };
  row.observedOriginalExecutionHash = proofHash(row.originalExecution);
  row.oracle = { historicalSourceReads: [1, 2, 3].map(id => ({ sourceId: 'PRIVATE-source' + id, digest: SHA })), originalExecutionReceipts: 'preserved-not-recertified' };
  return value;
}

test('evidence v4 only admits preserved actual REP05 historical-gap and keeps older cohorts separate', () => {
  const value = preservedEvidenceV4(), result = summarize(value), artifact = result.artifacts[0];
  assert.equal(artifact.supportedProtocol, true); assert.equal(artifact.comparisonKey.length, 64);
  assert.equal(result.states.automatically_passed, 1); assert.equal(result.states.not_started, 2);
  for (const change of [v => v.taskId = 'REP-06', v => v.taskId = 'REP-07', v => v.variant = 'normal',
    v => v.inputPreparation = 'synthetic-golden', v => v.inputPreparation = 'preserved-actual', v => delete v.inputPreparation]) {
    const input = preservedEvidenceV4(); change(input); const output = summarize(input);
    assert.equal(output.artifacts[0].supportedProtocol, false); assert.equal(output.artifacts[0].comparisonKey, null); assert.equal(output.states.automatically_passed, undefined);
  }
  for (const version of [1, 2, 3]) assert.notEqual(summarize(evidence({ protocol: 'syna-evidence-acceptance-v' + version, variant: 'historical-review-gap' })).artifacts[0].comparisonKey, artifact.comparisonKey);
  assert.equal(result.catalog.flatMap(row => row.variants).length, 35); assert.equal(result.gate, 'not_evaluated');
});

test('v4 comparison binds actual receipt helper, parser hashes and frozen reviewer without fallback', () => {
  const value = preservedEvidenceV4(), artifact = summarize(value).artifacts[0];
  assert.deepEqual(artifact.identity.historicalPolicy, { preservedIrisHelperSha256: SHA, irisLedgerParserSha256: SHA,
    providerMeterParserSha256: OTHER, historicalReviewerPolicySha256: SHA, historicalReviewerVersion: '10' });
  for (const field of ['preservedIrisHelperSha256', 'irisLedgerParserSha256', 'providerMeterParserSha256', 'historicalReviewerPolicySha256', 'historicalReviewerVersion']) {
    const missing = preservedEvidenceV4(); delete missing[field]; assert.equal(summarize(missing).artifacts[0].comparisonKey, null);
    const malformed = preservedEvidenceV4(); malformed[field] = 'PRIVATE-bad'; assert.equal(summarize(malformed).artifacts[0].comparisonKey, null);
  }
  for (const field of ['irisLedgerParserSha256', 'providerMeterParserSha256', 'historicalReviewerPolicySha256']) {
    const missing = preservedEvidenceV4(); delete missing.buildIntegrity[field]; assert.equal(summarize(missing).artifacts[0].comparisonKey, null);
    const conflict = preservedEvidenceV4(); conflict.buildIntegrity[field] = 'c'.repeat(64); assert.equal(summarize(conflict).artifacts[0].comparisonKey, null);
    const changed = preservedEvidenceV4(); changed[field] = changed.buildIntegrity[field] = 'c'.repeat(64);
    assert.notEqual(summarize(changed).artifacts[0].comparisonKey, artifact.comparisonKey);
  }
  const paced = preservedEvidenceV4({ modelRequestIntervalMs: 6000 }); assert.notEqual(summarize(paced).artifacts[0].comparisonKey, artifact.comparisonKey);
});

test('v4 receipts project only hashes/counts with semantic review pending; old Iris usage is excluded', () => {
  const value = preservedEvidenceV4(), original = clone(value), result = summarize(value, clone(value)), view = result.workloads[0].observations[0].preservedEvidence;
  assert.equal(view.recorded, true); assert.equal(view.recordedOriginalRuns, 3); assert.equal(view.recordedOriginalAttempts, 1); assert.equal(view.recordedHistoricalReviews, 1);
  assert.equal(view.recordedSourceReads, 3); assert.equal(view.preparationUsage, 'excluded_not_zero'); assert.equal(view.semanticCoverage, 'independent_review_pending');
  assert.equal(view.fullGate, false); assert.equal(result.usage.logicalAttempts, 1); assert.equal(result.usage.tokens.total, 15);
  assert.equal(result.usage.physical.providerCalls.total, 1); assert.equal(result.duplicateFilesCollapsed, 1);
  assert.deepEqual(value, original); const text = JSON.stringify(result); assert.ok(!text.includes('PRIVATE-')); assert.ok(!text.includes('999999'));
});

test('v4 receipt hash agrees with the actual evidence parser, including code-unit key order', () => {
  const value = preservedEvidenceV4(), row = value.attempts[0];
  row.originalExecution.bindings[0].receiptMetadata = { a: 'lower', A: 'upper', a_b: 'underscore', ab: 'plain' };
  row.observedOriginalExecutionHash = proofHash(row.originalExecution);
  assert.equal(summarize(value).workloads[0].observations[0].preservedEvidence.recorded, true);
});

test('v4 original receipts cannot manufacture writer consumption or fill a missing current ledger', () => {
  const value = preservedEvidenceV4(); value.attempts[0].snapshots[0].attempts[1].usage = {};
  const unknown = summarize(value); assert.equal(unknown.usage.tokens.total, null); assert.equal(unknown.usage.tokens.knownSubtotal, 0);
  assert.equal(unknown.usage.physical.providerCalls.total, null);
  value.attempts[0].snapshots[0].missions = [{ id: 'old-mission' }];
  value.attempts[0].snapshots[0].attempts = [execution('old-attempt', { mission_id: 'old-mission', usage: { tokens: 999999, provider: meter() } })];
  const oldOnly = summarize(value); assert.equal(oldOnly.usage.logicalAttempts, 0); assert.equal(oldOnly.usage.tokens.total, null);
  assert.ok(oldOnly.workloads[0].gaps.includes('historical-evidence-current-report-ledger-unobserved'));
});

test('v4 missing or changed declared original receipt/source-read metadata never records an automatic pass', () => {
  for (const change of [row => delete row.originalExecution, row => row.observedOriginalExecutionHash = OTHER,
    row => row.originalExecution.historicalReviews[0].id = 'changed', row => row.oracle.historicalSourceReads = [], row => row.oracle.originalExecutionReceipts = 'upgraded']) {
    const value = preservedEvidenceV4(); change(value.attempts[0]); const result = summarize(value);
    assert.equal(result.states.automatically_passed, undefined); assert.equal(result.states.unknown, 1); assert.equal(result.gate, 'not_evaluated');
  }
});

test('v4 failures, unstarted slots, audit-only and isolation failures remain separate from acceptance', () => {
  const value = preservedEvidenceV4(); value.attempts[0].result = 'failed'; delete value.attempts[0].originalExecution;
  const failed = summarize(value); assert.equal(failed.states.failed, 1); assert.equal(failed.states.not_started, 2); assert.equal(failed.gate, 'not_evaluated');
  for (const mode of ['--audit', '--validate']) { const audit = summarize(preservedEvidenceV4({ mode })); assert.equal(audit.states.not_started, 3); assert.equal(audit.usage.logicalAttempts, 0); }
  const isolated = summarize(preservedEvidenceV4({ isolationFailure: { code: 'shared-runtime' } })); assert.equal(isolated.states.failed, 3); assert.equal(isolated.artifacts[0].comparisonKey, null);
});

test('v4 current writer accounting rejects absent, null or empty mission IDs even when rows match them', () => {
  for (const id of [undefined, null, '']) {
    const value = preservedEvidenceV4(), row = value.attempts[0], snapshot = row.snapshots[0];
    snapshot.missions = [{ id, thread_id: row.threadId }];
    snapshot.attempts = [execution('unbound-attempt', { mission_id: id, usage: { tokens: 15, provider: meter() } })];
    const result = summarize(value);
    assert.equal(result.usage.logicalAttempts, 0); assert.equal(result.usage.tokens.total, null);
    assert.equal(result.usage.tokens.knownSubtotal, 0); assert.equal(result.usage.unknownWorkloads, 1);
    assert.ok(result.workloads[0].gaps.includes('historical-evidence-current-report-ledger-unobserved'));
  }
  const valid = summarize(preservedEvidenceV4()); assert.equal(valid.usage.logicalAttempts, 1); assert.equal(valid.usage.tokens.total, 15);
  assert.equal(valid.usage.unknownWorkloads, 0);
});
