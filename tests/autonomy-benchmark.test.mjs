import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeArtifact, summarizeBenchmark, readBenchmark, benchmarkMarkdown, distribution } from './helpers/autonomy-benchmark.mjs';

const sha = c => c.repeat(64);
const provider = { providerCalls: 2, unknownCalls: 0, inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 6, cacheWriteTokens: null, durationMs: 30 };
function fixture() {
  const snapshot = { at: '2026-10-05T12:01:00Z', missions: [{ id: 'm', config: { criteria: [{ id: 'qa' }], caseKeys: ['plan:case'] }, lease_until: null }], tasks: [],
    attempts: [{ id: 'a', task_id: 't', kind: 'report', status: 'completed', attempt_no: 1, reserved_tokens: 100000, tool_calls: 2, usage: { tokens: 12, toolCalls: 2, durationMs: 70, provider } }],
    reports: [{ id: 'report', item_id: 'item', status: 'completed', attempts: 1, lease_until: null, document: { partial: false, findings: [{ criterionId: 'qa', verdict: 'supported' }] }, usage: { totalTokens: 12, inputTokens: 10, outputTokens: 2, queueMs: 200, durationMs: 70, steps: 2 } }],
    runs: [{ id: 'run', result: { outcome: 'failed' } }], reviews: [{ id: 'review', run_id: 'run', status: 'completed', assessment: { verdict: 'supported' } }], claims: [], browsers: [] };
  return { version: 4, scenario: 'normal', repetitions: 1, sourceHash: sha('a'), processes: { sourceSha256: sha('a') }, prompt: 'Test the selected site', model: 'fixture-model', reasoning: 'low',
    fixture: { kind: 'simulated-public-origin', siteSha256: sha('b'), oracleSha256: sha('c') }, oracleContract: 'frozen-contract', harnessSha256: sha('d'), oracleAuditSha256: sha('e'), timestampObservation: 'utc-oid1114-v1', timestampParserSha256: sha('f'),
    observationSeconds: 1500, schedulerIntervalSeconds: 60, controllerLeaseSeconds: 90, reportLeaseSeconds: 240, reportProseReview: { status: 'pending' }, automatedGate: true, gate: false,
    finishedAt: '2026-10-05T12:01:01Z', attempts: [{ repetition: 1, workspaceId: 'w', threadId: 'thread', sessionId: 'session', startedAt: '2026-10-05T12:00:00Z', acceptedAt: '2026-10-05T12:00:01Z', closedAt: '2026-10-05T12:01:00Z', finishedAt: '2026-10-05T12:01:01Z', result: 'passed', snapshots: [snapshot], oracleMatches: [{ oracleId: 'known-defect' }] }] };
}
const summary = value => summarizeArtifact(value, { fileName: 'fixture.json', sha256: sha('1') });

test('WEB-01 v5 retains all original runs and remains a distinct protocol from v4', () => {
  const old = fixture(), current = structuredClone(old); current.version = 5;
  current.attempts[0].snapshots[0].runs.push({ id: 'complement', result: { outcome: 'failed' } });
  const value = summary(current);
  assert.equal(value.protocol.version, 5);
  assert.equal(value.trials[0].quality.testRuns, 2);
  assert.notEqual(value.comparisonKey, summary(old).comparisonKey);
  assert.equal(summary(old).trials[0].quality.testRuns, 1);
});

test('repeated snapshots and queue/provider receipts are counted once per logical attempt', () => {
  const f = fixture(), a = f.attempts[0]; a.snapshots.push(structuredClone(a.snapshots[0]), structuredClone(a.snapshots[0]));
  const before = structuredClone(f), trial = summary(f).trials[0];
  assert.equal(trial.usage.logicalAttempts, 1); assert.equal(trial.usage.tokens.total, 12);
  assert.equal(trial.usage.provider.totalCalls, 2); assert.equal(trial.usage.provider.cacheReadTokens.total, 6);
  assert.equal(trial.usage.toolCalls.total, 2); assert.equal(trial.reportQueueObservations.length, 1);
  assert.equal(trial.quality.testRuns, 1); assert.equal(trial.quality.savedReports, 1);
  assert.equal(trial.quality.testOutcomes.failed, 1); assert.equal(trial.quality.runsWithRecordedSupportingReview, 1);
  assert.equal(trial.usage.endToEndTokens, null); assert.equal(trial.usage.cost, null);
  assert.deepEqual(f, before);
});
test('all planned repetitions remain visible after early failure and operator stop', () => {
  const f = fixture(); f.repetitions = 3; f.attempts[0].result = 'failed'; f.notStarted = { repetitions: 2 };
  const report = summarizeBenchmark([summary(f)]);
  assert.deepEqual(report.statuses, { passed: 0, failed: 1, not_started: 2, in_progress: 0, unknown: 0 });
  assert.equal(report.artifacts[0].trials[1].usage, null); assert.equal(report.artifacts[0].trials[2].time.observationWallMs, null);
  assert.equal(report.comparisonGroups[0].observationWallMs.samples, 1);
});
test('baseline intake steps are neither provider calls nor QA functional parity', () => {
  const f = fixture(); delete f.scenario; f.version = 1; f.fixture = 'Unversioned example.com'; f.repetitions = 3;
  f.attempts[0].result = 'acceptance not reached within fixed observation window';
  f.attempts[0].observedMetrics = { steps: 4, inputTokens: 100, outputTokens: 5, usageKnown: true, modelTurnMs: 8700 };
  const artifact = summary(f), trial = artifact.trials[0];
  assert.equal(artifact.comparisonKey, null); assert.match(artifact.comparisonLimitation, /not QA functional parity/);
  assert.equal(trial.status, 'failed'); assert.equal(trial.usage.totalTokens, 105); assert.equal(trial.usage.providerCalls, null);
  assert.equal(trial.usage.modelSteps, 4); assert.equal(trial.usage.modelTurnMs, 8700);
  assert.equal(summarizeBenchmark([artifact]).cohorts.qaAcceptance.plannedTrials, 0);
  assert.equal(summarizeBenchmark([artifact]).cohorts.baselineIntake.plannedTrials, 3);
});
test('unknown and missing receipts never become zero or complete totals', () => {
  const f = fixture(), attempts = f.attempts[0].snapshots[0].attempts;
  attempts.push({ id: 'retry', kind: 'report', status: 'failed', attempt_no: 2, usage: { tokens: null, toolCalls: null, durationMs: 90 } });
  const trial = summary(f).trials[0];
  assert.equal(trial.usage.tokens.total, null); assert.equal(trial.usage.tokens.knownSubtotal, 12); assert.equal(trial.usage.tokens.unknownRecords, 1);
  assert.equal(trial.usage.provider.totalCalls, null); assert.equal(trial.usage.provider.recordedCalls, 2); assert.equal(trial.usage.provider.unknownWorkflowCoverage, 1);
  assert.equal(trial.usage.provider.inputTokens.total, null); assert.equal(trial.usage.provider.inputTokens.knownSubtotal, 10);
  assert.equal(trial.usage.provider.cacheWriteTokens.total, null); assert.equal(trial.usage.toolCalls.total, null);
  assert.equal(trial.usage.retries.total, 1);
});
test('partial physical receipts retain known input but incomplete token total', () => {
  const f = fixture(), a = f.attempts[0].snapshots[0].attempts[0];
  a.usage.tokens = null; a.usage.provider = { ...provider, unknownCalls: 1, outputTokens: null, totalTokens: null };
  const u = summary(f).trials[0].usage;
  assert.equal(u.provider.totalCalls, 2); assert.equal(u.provider.unknownUsageCalls, 1);
  assert.equal(u.provider.inputTokens.total, 10); assert.equal(u.provider.outputTokens.total, null); assert.equal(u.tokens.total, null);
  a.usage.tokens = 12;
  const staleAggregate = summary(f).trials[0].usage;
  assert.equal(staleAggregate.tokens.total, null); assert.equal(staleAggregate.tokens.unknownRecords, 1);
  assert.equal(staleAggregate.tokens.knownSubtotal, 10); // Partial physical measurement, never aggregate + receipt.
});
test('malformed receipts and contradictory totals are explicit measurement gaps', () => {
  const f = fixture(); f.attempts[0].snapshots[0].attempts[0].usage.provider = { ...provider, totalTokens: 999 };
  let trial = summary(f).trials[0]; assert.equal(trial.usage.provider.totalCalls, null); assert.ok(trial.gaps.some(g => g.includes('Malformed')));
  assert.equal(trial.usage.tokens.total, null); assert.equal(trial.usage.tokens.unknownRecords, 1); assert.equal(trial.usage.tokens.knownSubtotal, 0);
  f.attempts[0].snapshots[0].attempts[0].usage.provider = { ...provider, inputTokens: 20, totalTokens: 22 };
  trial = summary(f).trials[0]; assert.equal(trial.usage.tokens.total, null); assert.ok(trial.gaps.some(g => g.includes('disagrees')));
});
test('missing state observations are unknown rather than a clean empty execution', () => {
  const f = fixture(); f.attempts[0].snapshots = [{ at: '2026-10-05T12:01:00Z' }];
  const trial = summary(f).trials[0]; assert.equal(trial.usage, null); assert.equal(trial.quality.testRuns, null);
  assert.equal(trial.cleanup.unreturnedResourceClaims, null); assert.equal(trial.cleanup.leaseRecords, null);
});
test('prose certification and cleanup remain separate from saved report and automated pass', () => {
  const f = fixture(), s = f.attempts[0].snapshots[0]; s.claims = [{ id: 'claim', state: 'held', owner: 'human' }]; s.browsers = [{ id: 'browser', session_id: 'owned' }];
  const artifact = summary(f), trial = artifact.trials[0];
  assert.equal(artifact.declaredAutomatedGate, true); assert.equal(artifact.declaredOverallGate, false); assert.equal(trial.proseReview.status, 'pending');
  assert.equal(trial.cleanup.unreturnedResourceClaims, 1); assert.equal(trial.cleanup.physicalBrowserAssignments, 1);
  assert.equal(trial.quality.independentFalseApprovals, null); assert.equal(trial.oracle.matchedChecks, 1);
});
test('different oracle, prompt, fault scenario or protocol cannot be averaged as parity', () => {
  const base = fixture(), first = summary(base);
  for (const mutate of [f => { f.oracleContract = 'changed'; }, f => { f.prompt += ' also search'; }, f => { f.version = 3; }, f => { f.scenario = 'report-restart'; }, f => { f.fixture.oracleSha256 = sha('0'); }]) {
    const changed = structuredClone(base); mutate(changed); assert.notEqual(summary(changed).comparisonKey, first.comparisonKey);
  }
  const implementation = structuredClone(base); implementation.sourceHash = implementation.processes.sourceSha256 = sha('0');
  assert.equal(summary(implementation).comparisonKey, first.comparisonKey); assert.notEqual(summary(implementation).frozenSourceSha256, first.frozenSourceSha256);
  implementation.attempts[0].sessionId = 'different-actual-trial';
  const changed = summarizeArtifact(implementation, { sha256: sha('2') });
  const group = summarizeBenchmark([first, changed]).comparisonGroups[0];
  assert.equal(group.byImplementation.length, 2); assert.deepEqual(group.byImplementation.map(row => row.plannedTrials), [1, 1]);
  assert.deepEqual(group.byImplementation.map(row => row.missionAttemptTokens.median), [12, 12]);
  implementation.processes.sourceSha256 = sha('2'); assert.equal(summary(implementation).comparisonKey, null);
  for (const key of ['timestampParserSha256', 'model', 'reasoning', 'observationSeconds', 'schedulerIntervalSeconds', 'controllerLeaseSeconds', 'reportLeaseSeconds']) {
    const incomplete = structuredClone(base); delete incomplete[key]; assert.equal(summary(incomplete).comparisonKey, null, key);
  }
});
test('restarts retain actual downtime and logical history without adding queue or workflow times to wall time', () => {
  const f = fixture(); f.scenario = 'report-restart'; f.attempts[0].fault = { stoppedAt: '2026-10-05T12:00:10Z', restartedAt: '2026-10-05T12:00:20Z' };
  const trial = summary(f).trials[0]; assert.equal(trial.time.observationWallMs, 61000); assert.equal(trial.time.acceptedToClosureMs, 59000); assert.equal(trial.time.faultDowntimeMs, 10000);
  assert.deepEqual(trial.restart, { injected: true, stopRecorded: true, restartRecorded: true });
  assert.equal(trial.usage.workflowDurationMs.total, 70); assert.equal(trial.usage.provider.durationMs.total, 30);
  assert.equal(trial.reportQueueObservations[0].queueMs, 200);
});
test('invalid time zones or reversed times never manufacture durations', () => {
  const f = fixture(); f.attempts[0].startedAt = '2026-10-05 12:00:00';
  assert.equal(summary(f).trials[0].time.observationWallMs, null);
  assert.equal(summary(f).trials[0].status, 'passed'); assert.equal(summary(f).trials[0].started, true);
  assert.ok(summary(f).trials[0].gaps.some(g => g.includes('no valid start')));
  f.attempts[0].startedAt = '2026-10-05T12:02:00Z'; assert.equal(summary(f).trials[0].time.observationWallMs, null);
  assert.deepEqual(distribution([10, 20, 30, null]), { samples: 3, unknown: 1, min: 10, median: 20, max: 30, mean: 20 });
});
test('duplicate artifacts or logical trials and unsupported contract versions are rejected', () => {
  const a = summary(fixture()); assert.throws(() => summarizeBenchmark([a, a]), /artifact/);
  assert.throws(() => summarizeBenchmark([a, { ...a, artifactSha256: sha('2') }]), /logical trial/);
  const f = fixture(); f.attempts.push(structuredClone(f.attempts[0])); assert.throws(() => summary(f), /Duplicate/);
  assert.throws(() => summary({ ...fixture(), version: 999 }), /Unsupported/);
});

test('confirmed isolation failure is preserved but cannot certify or compare functional acceptance', () => {
  const f = fixture(); f.isolationFailure = { status: 'confirmed' };
  const a = summary(f);
  assert.equal(a.comparisonKey, null); assert.match(a.comparisonLimitation, /isolation failure/);
  assert.equal(a.trials[0].status, 'passed'); // Preserve the originally recorded outcome, not regrade it.
  assert.equal(a.trials[0].oracle.wholeTrialPassed, false);
  assert.equal(a.trials[0].isolation, 'failed');
  assert.equal(summarizeBenchmark([a]).comparisonGroups.length, 0);
});
test('explicit file reader is read-only, fingerprinted and includes unstarted trials in Markdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'syna-benchmark-'));
  try {
    const file = join(directory, 'selected.json'), f = fixture(); f.repetitions = 3; const bytes = JSON.stringify(f);
    await writeFile(file, bytes); const report = await readBenchmark([file]);
    assert.match(report.artifacts[0].artifactSha256, /^[a-f0-9]{64}$/); assert.equal(await readFile(file, 'utf8'), bytes);
    const markdown = benchmarkMarkdown(report); assert.match(markdown, /selected.json \/ 3/); assert.match(markdown, /not_started/); assert.match(markdown, /unknown/);
    await assert.rejects(readBenchmark([]), /explicit/); await assert.rejects(readBenchmark([file, file]), /distinct/);
  } finally { await rm(directory, { recursive: true }); }
});
