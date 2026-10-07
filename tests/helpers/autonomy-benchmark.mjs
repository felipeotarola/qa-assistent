// Read-only, explicit-file benchmark. Never imports app configuration, queries
// a database, drives a queue, starts a process or calls a model.
// pnpm exec node tests/helpers/autonomy-benchmark.mjs [--format=markdown] FILE...
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const sum = values => { const n = values.reduce((a, b) => a + b, 0); return Number.isSafeInteger(n) ? n : null; };
const array = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
const instant = value => typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const duration = (start, end) => { const a = instant(start), b = instant(end); return a !== null && b !== null && b >= a ? b - a : null; };
const counts = (rows, read) => Object.fromEntries([...new Set(rows.map(read))].sort().map(value => [value, rows.filter(row => read(row) === value).length]));
const tally = (values, selected) => Object.fromEntries(selected.map(key => [key, values.filter(value => value === key).length]));

/** Keep every observed logical record once, using its latest recorded state.
 * Repeated snapshots and queue receipts are never independent executions. */
function history(snapshots, key, gaps) {
  const rows = new Map();
  for (const snapshot of snapshots) for (const row of array(snapshot[key])) {
    if (!row || typeof row.id !== 'string') { gaps.add(`${key}: record without identity excluded from totals`); continue; }
    rows.set(row.id, row);
  }
  return [...rows.values()];
}
function providerReceipt(value) {
  const p = object(value);
  const fields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'durationMs'];
  if (count(p.providerCalls) === null || count(p.unknownCalls) === null || p.unknownCalls > p.providerCalls
    || fields.some(key => p[key] !== null && count(p[key]) === null)) return null;
  const total = p.inputTokens === null || p.outputTokens === null ? null : sum([p.inputTokens, p.outputTokens]);
  if (p.totalTokens !== total || p.unknownCalls > 0 && total !== null || p.providerCalls > 0 && p.unknownCalls === 0 && total === null
    || p.providerCalls === 0 && fields.some(key => p[key] !== null && p[key] !== 0)
    || ['cacheReadTokens', 'cacheWriteTokens'].some(key => p.inputTokens !== null && p[key] !== null && p[key] > p.inputTokens)) return null;
  return p;
}
function measurement(values) {
  const known = values.flatMap(value => count(value) === null ? [] : [value]);
  return { knownSubtotal: sum(known), measuredRecords: known.length, unknownRecords: values.length - known.length,
    total: known.length === values.length ? sum(known) : null };
}
function executionUsage(attempts, gaps) {
  const rows = attempts.map(attempt => {
    const usage = object(attempt.usage), provider = providerReceipt(usage.provider);
    const hasProvider = Object.hasOwn(usage, 'provider'), incompleteProvider = hasProvider && (!provider || provider.totalTokens === null);
    if (hasProvider && !provider) gaps.add('Malformed provider receipt remains unknown');
    const tokenConflict = count(usage.tokens) !== null && provider?.totalTokens != null && usage.tokens !== provider.totalTokens;
    if (tokenConflict) gaps.add('Attempt token total disagrees with its provider receipt');
    if (provider?.unknownCalls > 0) gaps.add('Physical provider receipt contains unknown token consumption');
    return { kind: typeof attempt.kind === 'string' ? attempt.kind : 'unknown', status: typeof attempt.status === 'string' ? attempt.status : 'unknown',
      // Aggregate and provider receipt describe the same calls, never sum both.
      tokens: tokenConflict || incompleteProvider ? null : count(usage.tokens), provider,
      measuredTokenSubtotal: tokenConflict || hasProvider && !provider ? null : incompleteProvider
        ? sum([provider.inputTokens, provider.outputTokens].filter(value => value !== null))
        : count(usage.tokens) ?? count(provider?.totalTokens),
      toolCalls: count(usage.toolCalls), toolCallReceipts: count(attempt.tool_calls), workflowDurationMs: count(usage.durationMs),
      reservedTokens: count(attempt.reserved_tokens), retry: count(attempt.attempt_no) === null ? null : attempt.attempt_no > 1,
    };
  });
  // Discovery is an HTTP acquisition, not a model workflow. For other roles,
  // zero tokens without a physical receipt does not prove zero provider calls.
  const modelRows = rows.filter(row => row.kind !== 'discovery'), physical = modelRows.flatMap(row => row.provider ? [row.provider] : []);
  const unknownProviderWorkflows = modelRows.length - physical.length;
  if (unknownProviderWorkflows) gaps.add('Some model workflows lack physical provider receipts');
  const tokenTotal = measurement(rows.map(row => row.tokens));
  return {
    scope: 'Mission attempts only; excludes the initiating V conversation',
    logicalAttempts: rows.length, retries: measurement(rows.map(row => row.retry === null ? null : row.retry ? 1 : 0)),
    tokens: { ...tokenTotal, knownSubtotal: sum(rows.flatMap(row => row.measuredTokenSubtotal === null ? [] : [row.measuredTokenSubtotal])) },
    provider: {
      recordedCalls: sum(physical.map(p => p.providerCalls)), unknownUsageCalls: sum(physical.map(p => p.unknownCalls)), unknownWorkflowCoverage: unknownProviderWorkflows,
      totalCalls: unknownProviderWorkflows ? null : sum(physical.map(p => p.providerCalls)),
      inputTokens: measurement([...physical.map(p => p.inputTokens), ...Array(unknownProviderWorkflows).fill(null)]), outputTokens: measurement([...physical.map(p => p.outputTokens), ...Array(unknownProviderWorkflows).fill(null)]),
      cacheReadTokens: measurement([...physical.map(p => p.cacheReadTokens), ...Array(unknownProviderWorkflows).fill(null)]), cacheWriteTokens: measurement([...physical.map(p => p.cacheWriteTokens), ...Array(unknownProviderWorkflows).fill(null)]),
      durationMs: measurement([...physical.map(p => p.durationMs), ...Array(unknownProviderWorkflows).fill(null)]),
    },
    toolCalls: measurement(rows.map(row => row.toolCalls)),
    reservedTokens: measurement(rows.map(row => row.reservedTokens)),
    workflowDurationMs: measurement(rows.map(row => row.workflowDurationMs)),
    byKind: [...new Set(rows.map(row => row.kind))].sort().map(kind => ({ kind, logicalAttempts: rows.filter(row => row.kind === kind).length,
      statuses: counts(rows.filter(row => row.kind === kind), row => row.status), tokens: measurement(rows.filter(row => row.kind === kind).map(row => row.tokens)) })),
    endToEndTokens: null, cost: null, costReason: 'No verified dated price table; cached input is not added to input tokens',
  };
}
function baselineUsage(attempt) {
  const metrics = object(attempt.observedMetrics);
  const inputTokens = metrics.usageKnown === true ? count(metrics.inputTokens) : null;
  const outputTokens = metrics.usageKnown === true ? count(metrics.outputTokens) : null;
  return { scope: 'Saved initiating Eve conversation events; not a completed QA pipeline',
    inputTokens, outputTokens, totalTokens: inputTokens === null || outputTokens === null ? null : sum([inputTokens, outputTokens]),
    modelSteps: count(metrics.steps), modelTurnMs: count(metrics.modelTurnMs), providerCalls: null, endToEndTokens: null,
    cost: null, costReason: 'No verified dated price table; event steps are not physical provider calls' };
}
function quality(snapshots, gaps) {
  const known = key => snapshots.some(snapshot => Array.isArray(snapshot[key]));
  const missions = history(snapshots, 'missions', gaps), runs = history(snapshots, 'runs', gaps), reviews = history(snapshots, 'reviews', gaps), reports = history(snapshots, 'reports', gaps);
  const supported = new Set(reviews.filter(review => review.status === 'completed' && review.assessment?.verdict === 'supported').map(review => review.run_id));
  const criteria = missions.flatMap(mission => array(mission.config?.criteria));
  const findings = reports.filter(report => report.status === 'completed').flatMap(report => array(report.document?.findings));
  return { label: 'Recorded outcomes and model assessments, not independent prose or oracle certification',
    missions: known('missions') ? missions.length : null, criteria: known('missions') ? criteria.length : null, selectedCases: known('missions') ? new Set(missions.flatMap(mission => array(mission.config?.caseKeys))).size : null,
    testRuns: known('runs') ? runs.length : null, testOutcomes: known('runs') ? counts(runs, run => typeof run.result?.outcome === 'string' ? run.result.outcome : 'unfinished') : null,
    reviews: known('reviews') ? reviews.length : null, reviewStatuses: known('reviews') ? counts(reviews, review => review.status ?? 'unknown') : null,
    reviewVerdicts: known('reviews') ? counts(reviews.filter(review => review.status === 'completed'), review => review.assessment?.verdict ?? 'unknown') : null,
    runsWithRecordedSupportingReview: known('runs') && known('reviews') ? runs.filter(run => supported.has(run.id)).length : null,
    reportedPassesWithoutRecordedSupport: known('runs') && known('reviews') ? runs.filter(run => run.result?.outcome === 'passed' && !supported.has(run.id)).length : null,
    reports: known('reports') ? reports.length : null, savedReports: known('reports') ? reports.filter(report => report.status === 'completed' && report.item_id).length : null,
    partialReports: known('reports') ? reports.filter(report => report.status === 'completed' && report.document?.partial === true).length : null,
    reportCriterionVerdicts: known('reports') ? counts(findings, finding => finding.verdict ?? 'unknown') : null,
    independentFalseApprovals: null, missedKnownDefects: null, falseDefectReports: null, duplicateSideEffects: null, sourcePrecision: null,
  };
}
function trial(artifact, attempt, repetition, baseline) {
  const gaps = new Set(), snapshots = array(attempt?.snapshots);
  const isolationFailed = !!artifact.isolationFailure;
  if (isolationFailed) gaps.add('Isolation failure invalidated this functional acceptance; the attempt remains in history');
  const final = snapshots.at(-1) ?? {};
  // A malformed timestamp cannot erase an observed execution from the denominator.
  const started = !!attempt && (attempt.startedAt != null || snapshots.length > 0 || attempt.result != null);
  const status = !started ? 'not_started' : attempt.result === 'passed' ? 'passed' : attempt.result === 'failed' || baseline && attempt.finishedAt ? 'failed' : attempt.finishedAt ? 'unknown' : 'in_progress';
  if (!attempt) gaps.add(artifact.finishedAt ? 'Planned repetition was never submitted' : 'Planned repetition has not been submitted in this captured artifact');
  if (started && !snapshots.length) gaps.add('No saved state snapshot');
  if (started && instant(attempt.startedAt) === null) gaps.add('Observed trial has no valid start timestamp; elapsed time remains unknown');
  if (!baseline && started && !snapshots.some(snapshot => Array.isArray(snapshot.attempts))) gaps.add('No observed mission attempt collection; usage remains unknown');
  if (!baseline && started) gaps.add('Initiating V conversation consumption is not in mission attempt totals');
  if (!baseline && !artifact.timestampObservation) gaps.add('Legacy artifact lacks the UTC database timestamp observation contract');
  const attempts = history(snapshots, 'attempts', gaps), reports = history(snapshots, 'reports', gaps);
  const prose = object(attempt?.reportProseReview ?? artifact.reportProseReview);
  const state = ['pending', 'passed', 'failed', 'completed', 'not_reviewed'].includes(prose.status) ? prose.status : 'not_recorded';
  const queue = reports.map(report => ({ status: report.status ?? 'unknown', attempts: count(report.attempts),
    queueMs: count(report.usage?.queueMs), workflowDurationMs: count(report.usage?.durationMs), modelSteps: count(report.usage?.steps) }));
  return {
    repetition, status, started, isolation: isolationFailed ? 'failed' : 'not_reverified', trialIdentity: started && (attempt.sessionId || attempt.threadId) ? hash(JSON.stringify([attempt.workspaceId ?? null, attempt.threadId ?? null, attempt.sessionId ?? null])) : null,
    reason: !started ? 'No recorded start; excluded from duration/usage statistics, included in attempt denominators' : baseline ? 'Baseline did not reach autonomous QA acceptance' : attempt.error ? 'Failure recorded; preserved source artifact contains its diagnostic' : null,
    time: { startedAt: attempt?.startedAt ?? null, finishedAt: attempt?.finishedAt ?? null, observationWallMs: duration(attempt?.startedAt, attempt?.finishedAt),
      acceptedToClosureMs: duration(attempt?.acceptedAt, attempt?.closedAt), snapshotAt: final.at ?? null,
      faultDowntimeMs: duration(attempt?.fault?.stoppedAt, attempt?.fault?.restartedAt),
    },
    quality: started && snapshots.length ? quality(snapshots, gaps) : null,
    usage: !started ? null : baseline ? baselineUsage(attempt) : snapshots.some(snapshot => Array.isArray(snapshot.attempts)) ? executionUsage(attempts, gaps) : null,
    reportQueueObservations: queue, reportQueueTimingScope: 'Latest saved queue/workflow measurement per report, not additive model latency or total queue history',
    oracle: { matchesRecorded: Array.isArray(attempt?.oracleMatches), matchedChecks: Array.isArray(attempt?.oracleMatches) ? attempt.oracleMatches.length : null,
      wholeTrialPassed: status === 'passed' && !baseline && !isolationFailed, requiredCheckCount: null },
    proseReview: { status: state, independentOfAutomatedGate: true },
    restart: { injected: !!attempt?.fault, stopRecorded: instant(attempt?.fault?.stoppedAt) !== null, restartRecorded: instant(attempt?.fault?.restartedAt) !== null },
    cleanup: !started || !snapshots.length ? null : { unreturnedResourceClaims: Array.isArray(final.claims) ? final.claims.filter(claim => claim.state !== 'released').length : null,
      physicalBrowserAssignments: Array.isArray(final.browsers) ? final.browsers.filter(browser => browser.session_id).length : null,
      nonterminalAttempts: Array.isArray(final.attempts) ? final.attempts.filter(attempt => !['completed', 'failed', 'cancelled'].includes(attempt.status)).length : null,
      leaseRecords: ['missions', 'attempts', 'reports'].every(key => Array.isArray(final[key])) ? [...final.missions, ...final.attempts, ...final.reports].filter(row => row.lease_until).length : null,
      meaning: 'Saved final state only; no live cleanup inference' },
    gaps: [...gaps],
  };
}

/** Input bytes are preserved and fingerprinted; no historical run is regraded. */
export function summarizeArtifact(artifact, { fileName = 'selected.json', sha256 = null } = {}) {
  if (!artifact || ![1, 2, 3, 4, 5].includes(artifact.version) || !Number.isSafeInteger(artifact.repetitions) || artifact.repetitions < 1 || artifact.repetitions > 1000 || !Array.isArray(artifact.attempts)) throw new Error('Unsupported acceptance/baseline artifact contract');
  const baseline = artifact.version === 1 && !artifact.scenario;
  if (!baseline && !['normal', 'controller-restart', 'report-restart'].includes(artifact.scenario)) throw new Error('Unknown benchmark scenario');
  const numbers = artifact.attempts.map(attempt => attempt.repetition);
  if (numbers.some(n => !Number.isSafeInteger(n) || n < 1 || n > artifact.repetitions) || new Set(numbers).size !== numbers.length) throw new Error('Duplicate or out-of-range trial identity');
  const fixture = object(artifact.fixture);
  const protocol = { version: artifact.version, scenario: baseline ? 'baseline-intake-only' : artifact.scenario,
    promptSha256: typeof artifact.prompt === 'string' ? hash(artifact.prompt) : null, model: artifact.model ?? null, reasoning: artifact.reasoning ?? null,
    fixtureKind: fixture.kind ?? (baseline ? 'unversioned-public-site' : null), siteSha256: digest(fixture.siteSha256), oracleSha256: digest(fixture.oracleSha256),
    oracleContract: artifact.oracleContract ?? null, harnessSha256: digest(artifact.harnessSha256), oracleAuditSha256: digest(artifact.oracleAuditSha256),
    timestampObservation: artifact.timestampObservation ?? null, timestampParserSha256: digest(artifact.timestampParserSha256),
    observationSeconds: count(artifact.observationSeconds), schedulerIntervalSeconds: count(artifact.schedulerIntervalSeconds),
    controllerLeaseSeconds: count(artifact.controllerLeaseSeconds), reportLeaseSeconds: count(artifact.reportLeaseSeconds),
  };
  const trials = Array.from({ length: artifact.repetitions }, (_, i) => trial(artifact, artifact.attempts.find(attempt => attempt.repetition === i + 1), i + 1, baseline));
  const sourceHash = digest(artifact.sourceHash), processHash = digest(artifact.processes?.sourceSha256);
  const comparable = !artifact.isolationFailure && !baseline && !!sourceHash && !!protocol.siteSha256 && !!protocol.oracleSha256 && !!protocol.promptSha256 && !!protocol.oracleContract && !!protocol.harnessSha256 && !!protocol.oracleAuditSha256 && !!protocol.timestampObservation && !!protocol.timestampParserSha256
    && typeof protocol.model === 'string' && protocol.model.length > 0 && typeof protocol.reasoning === 'string' && !!protocol.fixtureKind
    && ['observationSeconds', 'schedulerIntervalSeconds', 'controllerLeaseSeconds', 'reportLeaseSeconds'].every(key => protocol[key] !== null)
    && sourceHash === processHash;
  return { fileName: basename(fileName), artifactSha256: sha256, frozenSourceSha256: sourceHash, processSourceSha256: processHash,
    frozenSourceConsistent: processHash && sourceHash ? processHash === sourceHash : null, baseline, protocol,
    comparisonKey: comparable ? hash(JSON.stringify(protocol)) : null,
    comparisonLimitation: artifact.isolationFailure ? 'Confirmed isolation failure; excluded from functional/performance comparison, retained as an unsuccessful test execution' : baseline ? `${artifact.repetitions} intake observations are not QA functional parity or a broad quality benchmark` : comparable ? 'Compare only identical protocol keys; implementation SHAs may differ and remain visible' : 'Missing or inconsistent protocol identity; functional/performance parity is not established',
    declaredAutomatedGate: typeof artifact.automatedGate === 'boolean' ? artifact.automatedGate : null, declaredOverallGate: typeof artifact.gate === 'boolean' ? artifact.gate : null,
    plannedTrials: artifact.repetitions, capturedAt: artifact.finishedAt ?? null, trials,
  };
}
export function distribution(values) {
  const known = values.filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  return { samples: known.length, unknown: values.length - known.length, min: known[0] ?? null, median: known.length ? (known[Math.floor((known.length - 1) / 2)] + known[Math.floor(known.length / 2)]) / 2 : null,
    max: known.at(-1) ?? null, mean: known.length ? known.reduce((a, b) => a + b, 0) / known.length : null };
}
export function summarizeBenchmark(artifacts) {
  const hashes = artifacts.map(artifact => artifact.artifactSha256).filter(Boolean);
  if (new Set(hashes).size !== hashes.length) throw new Error('Same preserved artifact selected more than once');
  const trials = artifacts.flatMap(artifact => artifact.trials), statuses = trials.map(trial => trial.status);
  const identities = trials.map(trial => trial.trialIdentity).filter(Boolean);
  if (new Set(identities).size !== identities.length) throw new Error('Same logical trial appears in more than one selected artifact');
  const groups = [...new Set(artifacts.map(artifact => artifact.comparisonKey).filter(Boolean))].map(key => {
    const selected = artifacts.filter(artifact => artifact.comparisonKey === key), groupTrials = selected.flatMap(artifact => artifact.trials);
    return { key, artifacts: selected.map(artifact => artifact.artifactSha256), frozenSourceHashes: [...new Set(selected.map(artifact => artifact.frozenSourceSha256))],
      statuses: tally(groupTrials.map(trial => trial.status), ['passed', 'failed', 'not_started', 'in_progress', 'unknown']),
      observationWallMs: distribution(groupTrials.filter(trial => trial.started).map(trial => trial.time.observationWallMs)),
      byImplementation: [...new Set(selected.map(artifact => artifact.frozenSourceSha256))].map(sourceSha256 => {
        const members = selected.filter(artifact => artifact.frozenSourceSha256 === sourceSha256).flatMap(artifact => artifact.trials), started = members.filter(trial => trial.started);
        return { sourceSha256, plannedTrials: members.length, statuses: tally(members.map(trial => trial.status), ['passed', 'failed', 'not_started', 'in_progress', 'unknown']),
          observationWallMs: distribution(started.map(trial => trial.time.observationWallMs)), missionAttemptTokens: distribution(started.map(trial => trial.usage?.tokens?.total)),
          providerCalls: distribution(started.map(trial => trial.usage?.provider?.totalCalls)) };
      }),
      limitation: 'All started attempts, including failures; not completion latency for successful QA only' };
  });
  return { schemaVersion: 1, artifactCount: artifacts.length, plannedTrials: trials.length,
    statuses: tally(statuses, ['passed', 'failed', 'not_started', 'in_progress', 'unknown']),
    cohorts: Object.fromEntries([['baselineIntake', true], ['qaAcceptance', false]].map(([key, baseline]) => {
      const selected = artifacts.filter(artifact => artifact.baseline === baseline).flatMap(artifact => artifact.trials);
      return [key, { plannedTrials: selected.length, statuses: tally(selected.map(trial => trial.status), ['passed', 'failed', 'not_started', 'in_progress', 'unknown']) }];
    })),
    comparisonGroups: groups, artifacts,
    limitations: ['No current services, queues or models were queried', 'Effective infrastructure and database isolation are not verified by this file-only summary', 'Historical gates and prose reviews are recorded, never inferred or regraded',
      'Queue, workflow and physical model time can overlap; they are not added together', 'No dated price table verified; all costs remain unknown',
      'No cross-protocol average or performance improvement is computed', 'Known token subtotals are not full end-to-end consumption when intake or receipts are absent'],
  };
}
export async function readBenchmark(paths) {
  if (!paths.length || paths.length > 100 || new Set(paths.map(path => resolve(path))).size !== paths.length) throw new Error('Select 1–100 distinct explicit artifact files');
  const artifacts = [];
  for (const path of paths) {
    if (!path.endsWith('.json')) throw new Error('Only explicit JSON artifacts are supported');
    const info = await stat(path);
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('Artifact exceeds the bounded read size or is not a file');
    const bytes = await readFile(path);
    if (bytes.length > 64 * 1024 * 1024) throw new Error('Artifact exceeds the bounded read size');
    artifacts.push(summarizeArtifact(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), { fileName: path, sha256: hash(bytes) }));
  }
  return summarizeBenchmark(artifacts);
}
export function benchmarkMarkdown(report) {
  const value = n => n === null || n === undefined ? 'unknown' : String(n);
  const lines = ['# Preserved autonomy benchmark', '', `${report.artifactCount} artifacts; ${report.plannedTrials} planned trials. ${Object.entries(report.statuses).map(([key, n]) => `${n} ${key}`).join(', ')}.`, '',
    '| Artifact / trial | Source SHA | Protocol / scenario | Result | Observed wall ms | Known tokens / complete scope total | Reports / supporting reviews | Prose |', '| --- | --- | --- | --- | ---: | --- | --- | --- |'];
  for (const artifact of report.artifacts) for (const trial of artifact.trials) {
    const token = artifact.baseline ? trial.usage?.totalTokens : trial.usage?.tokens.knownSubtotal;
    const total = artifact.baseline ? trial.usage?.totalTokens : trial.usage?.tokens.total;
    lines.push(`| ${artifact.fileName.replaceAll('|', '\\|')} / ${trial.repetition} | ${artifact.frozenSourceSha256?.slice(0, 12) ?? 'unknown'} | v${artifact.protocol.version} / ${artifact.protocol.scenario} | ${trial.status} | ${value(trial.time.observationWallMs)} | ${value(token)} / ${value(total)} | ${value(trial.quality?.savedReports)} / ${value(trial.quality?.runsWithRecordedSupportingReview)} | ${trial.proseReview.status} |`);
  }
  lines.push('', `Cohorts: ${report.cohorts.baselineIntake.plannedTrials} baseline intake observations, ${report.cohorts.qaAcceptance.plannedTrials} planned QA acceptance trials. Baseline observations are excluded from functional QA comparisons.`, '', 'Token scopes differ: baseline measures saved intake events; acceptance measures mission attempts. Neither is presented as complete end-to-end QA cost.', '', ...report.artifacts.map(artifact => `- ${artifact.fileName}: ${artifact.comparisonLimitation}. Artifact SHA: ${artifact.artifactSha256 ?? 'unknown'}.`), '', ...report.limitations.map(limit => `- ${limit}`));
  return `${lines.join('\n')}\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), markdown = args.includes('--format=markdown');
  if (args.some(arg => arg.startsWith('--') && arg !== '--format=markdown')) throw new Error('Only --format=markdown and explicit JSON files are supported');
  const report = await readBenchmark(args.filter(arg => !arg.startsWith('--')));
  process.stdout.write(markdown ? benchmarkMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`);
}
