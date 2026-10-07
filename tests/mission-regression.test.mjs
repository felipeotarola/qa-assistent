import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { missionConfigSchema } from '../shared/mission.ts';
import { DELIVERY_POLICY_VERSION } from '../shared/mission-delivery.ts';
import { missionMetrics } from '../shared/mission-metrics.ts';
import { validateReport, readIndependentCriterionEvidence, assembleReport } from '../shared/mission-report.ts';
import { missionReportOutput } from '../shared/mission-report-output.ts';
import { missionReportWriterContext } from '../shared/mission-report-context.ts';
import { selectMissionReportEvidence } from '../shared/mission-report-evidence.ts';
import { reportObservationOrigin, reportEvidenceAvailability } from '../shared/mission-report-remediation.ts';
import { sameRegressionRequirement, regressionDeliverySchema } from '../shared/mission-regression.ts';
import { runChecks } from '../shared/test-run.ts';
import { REVIEWER_VERSION } from '../shared/result-assessment.ts';

const sha = text => createHash('sha256').update(text).digest('hex');
function fixture() {
  const itemId = randomUUID(), caseId = randomUUID(), workspaceId = randomUUID();
  const a = { id: caseId, title: 'Read service status', type: 'browser', preconditions: '', steps: 'Open status. Read availability.', expected: 'Availability is displayed.', entryUrl: 'https://regression.example.test/a' };
  const b = { ...a, entryUrl: 'https://regression.example.test/b' };
  const key = `${itemId}:${caseId}`, item = { id: itemId, version: 2, content: { kind: 'test_plan', cases: [b] } };
  const run = (snapshot, version, date, outcome) => ({ id: randomUUID(), workspaceId, itemId, caseId, planVersion: version, snapshot,
    environment: 'QA', target: { environment: 'QA', url: snapshot.entryUrl, revision: `commit-${version}` }, startedAt: `${date}T10:00:00.000Z`, finishedAt: `${date}T10:01:00.000Z`,
    result: { outcome, actual: outcome === 'failed' ? 'Status request returned 503.' : 'Availability displayed.', unverified: '', observations: [], evidenceItemIds: [], checks: runChecks(snapshot).map(check => ({ id: check.id, status: outcome === 'failed' ? 'mismatch' : 'verified', actual: outcome === 'failed' ? '503 shown.' : 'Available shown.' })) } });
  const oldRun = run(a, 1, '2026-10-04', 'failed'), newRun = run(b, 2, '2026-10-05', 'passed');
  const source = run => {
    const text = run.result.actual, digest = sha(text), at = run.startedAt.replace('10:00:00', '10:00:30');
    const evidence = { id: `proof:${run.id}`, itemId: randomUUID(), title: 'Actual saved action', version: 1, hash: digest, kind: 'text', origin: 'tool', evidencePolicyVersion: 2, observedAt: at, unavailable: false, excerpt: text,
      provenance: { version: 1, origin: 'tool', producer: 'browser-action', sourceType: 'test', sourceId: run.id, observedAt: at, sha256: digest } };
    return { schemaVersion: 2, sourceType: 'test', sourceId: run.id, sourceRevision: sha(run.id), attemptId: run.id, status: 'completed', reportedOutcome: run.result.outcome === 'passed' ? 'achieved' : 'partial', target: run.target,
      startedAt: run.startedAt, finishedAt: run.finishedAt, summary: text, limitations: [], evidence: [evidence], claims: [],
      assessment: { id: randomUUID(), sourceHash: sha('review-' + run.id), reviewerVersion: REVIEWER_VERSION, verdict: 'supported', stale: false, findings: runChecks(run.snapshot).map(check => ({ requirementId: check.id, verdict: 'supported', explanation: text, evidenceIds: [evidence.id], suggestedNextStep: '' })) } };
  };
  const oldSource = source(oldRun), newSource = source(newRun);
  const baseline = { runId: oldRun.id, planVersion: 1, snapshot: a, target: oldRun.target, startedAt: oldRun.startedAt, finishedAt: oldRun.finishedAt, sourceRevision: oldSource.sourceRevision };
  const config = missionConfigSchema.parse({ title: 'Regression', goal: 'Rerun this selected plan and compare the observed change.', scope: 'Public read-only checks', target: newRun.target, caseKeys: [key], automaticReports: false,
    criteria: [{ id: 'qa', text: 'Current QA complete', delivery: { kind: 'test_cases', caseKeys: [key] } }, { id: 'comparison', text: 'Compare the separately observed outcomes.', delivery: { kind: 'regression_comparison', caseKey: key, capturedAt: '2026-10-05T09:00:00.000Z', baseline } }] });
  const tasks = [{ id: randomUUID(), title: 'Selected work', actor: 'main', criterionIds: ['qa', 'comparison'], parentId: null, dependsOn: [], sources: [oldSource, newSource] }];
  const runs = [oldRun, newRun], reads = new Map([oldSource, newSource].map(s => [s.evidence[0].id, { id: s.evidence[0].id, text: s.summary, digest: s.evidence[0].provenance.sha256 }]));
  const snapshot = () => { const projection = missionMetrics([item], runs, config, tasks); return { schemaVersion: 2, workspaceId, missionId: randomUUID(), revision: 1, capturedAt: '2026-10-05T10:02:00.000Z', config, tasks, ...projection }; };
  const draft = () => ({ summary: 'Adapter placeholder', limitations: [], findings: config.criteria.map(c => ({ criterionId: c.id, verdict: 'supported', conclusion: 'Adapter placeholder', nextStep: '', evidenceIds: (c.id === 'qa' ? [newSource] : [oldSource, newSource]).map(s => s.evidence[0].id), observations: [{ text: c.id === 'qa' ? newSource.summary : 'The earlier request showed 503; the later request displayed availability.', evidenceIds: (c.id === 'qa' ? [newSource] : [oldSource, newSource]).map(s => s.evidence[0].id) }] })) });
  return { item, key, config, tasks, runs, oldRun, newRun, oldSource, newSource, reads, snapshot, draft };
}

test('real historical failure and separately reviewed current success complete both criteria without rewriting history', () => {
  const f = fixture(), before = JSON.stringify(f.oldRun), s = f.snapshot();
  assert.equal(s.delivery.schemaVersion, DELIVERY_POLICY_VERSION); assert.equal(s.delivery.complete, true);
  assert.deepEqual(s.delivery.cases.map(c => c.runId), [f.newRun.id]);
  assert.deepEqual(s.tests.map(t => t.originalOutcome), ['passed', 'failed']);
  assert.match(s.tests[1].title, /Historiskt/); assert.equal(s.metrics.find(m => m.id === 'test-attempts').data[1].value, 1);
  assert.equal(validateReport(s, f.draft(), new Set(f.reads.keys()), f.reads).findings.length, 2);
  assert.equal(assembleReport(s, f.draft(), new Set(f.reads.keys()), f.reads).partial, false);
  assert.equal(JSON.stringify(f.oldRun), before);
});

test('historical acquisition never establishes current QA even when the same target and requirements are reused', () => {
  const f = fixture(); f.runs.pop(); f.tasks[0].sources.pop();
  const baseline = f.config.criteria[1].delivery.baseline;
  f.config.target = f.oldRun.target; f.item.version = 1; f.item.content.cases[0] = f.oldRun.snapshot;
  const s = f.snapshot(); assert.equal(s.delivery.cases[0].runId, null); assert.equal(s.delivery.cases[0].complete, false);
  assert.equal(s.delivery.criteria.find(c => c.criterionId === 'comparison').complete, false);
  assert.equal(baseline.runId, f.oldRun.id);
});

test('historical evidence is applicable only to the exact comparison, never B criterion', () => {
  const f = fixture(), s = f.snapshot(), ids = new Set(f.reads.keys());
  assert.deepEqual(readIndependentCriterionEvidence(s, 'qa', ids, f.reads).map(e => e.source.sourceId), [f.newRun.id]);
  assert.deepEqual(readIndependentCriterionEvidence(s, 'comparison', ids, f.reads).map(e => e.source.sourceId), [f.oldRun.id, f.newRun.id]);
  assert.match(reportObservationOrigin(s, 'comparison', [f.oldSource.evidence[0].id], f.reads), /historiskt/);
  assert.equal(reportEvidenceAvailability(s, f.reads).policyExcluded, 0);
});

test('same-target history cannot contradict current QA, while an explicitly selected historical source remains readable', () => {
  const f = fixture();
  f.oldRun.target = structuredClone(f.newRun.target); f.oldSource.target = f.oldRun.target;
  f.config.criteria[1].delivery.baseline.target = f.oldRun.target;
  const a = f.oldSource.evidence[0].id, reads = new Map([[a, f.reads.get(a)]]), s = f.snapshot();
  assert.deepEqual(readIndependentCriterionEvidence(s, 'qa', new Set(reads.keys()), reads), []);
  assert.deepEqual(missionReportOutput(s, reads).criteria[0].allowedVerdicts, ['needs_evidence']);
  const draft = f.draft(); draft.findings[0] = { ...draft.findings[0], verdict: 'contradicted', evidenceIds: [a], observations: [{ text: f.oldSource.summary, evidenceIds: [a] }] };
  assert.throws(() => validateReport(s, draft, new Set(f.reads.keys()), f.reads), /independent evidence/);
  f.config.criteria.push({ id: 'old-source', text: 'Describe the explicitly selected historical source.', delivery: { kind: 'source', sourceTypes: ['test'], sourceRefs: [{ type: 'test', id: f.oldRun.id }] } });
  f.tasks[0].criterionIds.push('old-source');
  assert.deepEqual(readIndependentCriterionEvidence(f.snapshot(), 'old-source', new Set(reads.keys()), reads).map(row => row.source.sourceId), [f.oldRun.id]);
});

test('a third older run that is not the frozen baseline cannot contradict the currently selected case', () => {
  const f = fixture(), prior = structuredClone(f.newSource);
  prior.sourceId = randomUUID(); prior.attemptId = prior.sourceId;
  prior.evidence[0].id = `proof:${prior.sourceId}`; prior.evidence[0].provenance.sourceId = prior.sourceId;
  f.tasks[0].sources.push(prior);
  const read = { ...f.reads.get(f.newSource.evidence[0].id), id: prior.evidence[0].id };
  const reads = new Map([[read.id, read]]), snapshot = f.snapshot();
  assert.deepEqual(readIndependentCriterionEvidence(snapshot, 'qa', new Set(reads.keys()), reads), []);
  assert.deepEqual(missionReportOutput(snapshot, reads).criteria[0].allowedVerdicts, ['needs_evidence']);
  const draft = f.draft(); draft.findings[0] = { ...draft.findings[0], verdict: 'contradicted', evidenceIds: [read.id], observations: [{ text: prior.summary, evidenceIds: [read.id] }] };
  assert.throws(() => validateReport(snapshot, draft, new Set([...f.reads.keys(), read.id]), new Map([...f.reads, [read.id, read]])), /independent evidence/);
});

test('an independent observation from the current incomplete run can still contradict its actual criterion', () => {
  const f = fixture(); f.newRun.result.unverified = 'Another selected check remains unperformed.';
  const s = f.snapshot(), b = f.newSource.evidence[0].id, reads = new Map([[b, f.reads.get(b)]]);
  assert.equal(s.delivery.cases[0].complete, false);
  assert.deepEqual(missionReportOutput(s, reads).criteria[0].allowedVerdicts, ['needs_evidence', 'contradicted']);
  const draft = f.draft(); draft.findings[0].verdict = 'contradicted';
  draft.findings[1] = { ...draft.findings[1], verdict: 'needs_evidence', evidenceIds: [], observations: [] };
  assert.equal(validateReport(s, draft, new Set(reads.keys()), reads).findings[0].verdict, 'contradicted');
});

test('selector reads both actual sources and writer keeps exact target/time/version relation', () => {
  const f = fixture(), s = f.snapshot(), selected = selectMissionReportEvidence(s);
  assert.deepEqual(new Set(selected.proofEvidenceIds), new Set(f.reads.keys()));
  const context = missionReportWriterContext(s, new Set(f.reads.keys()));
  assert.equal(context.regressionComparisons[0].historicalRunId, f.oldRun.id);
  assert.equal(context.regressionComparisons[0].currentRunId, f.newRun.id);
  assert.equal(context.regressionComparisons[0].historicalPlanVersion, 1);
  assert.equal(context.regressionComparisons[0].historicalTarget.url, f.oldRun.target.url);
  assert.equal(context.sources.length, 2);
});

test('supported comparison requires actual independent reads from both sides, not metadata or another run', () => {
  const f = fixture(), s = f.snapshot(), a = f.oldSource.evidence[0].id;
  const reads = new Map(f.reads); reads.delete(a);
  assert.ok(!missionReportOutput(s, reads).criteria[1].allowedVerdicts.includes('supported'));
  const draft = f.draft(); draft.findings[1].evidenceIds = [f.newSource.evidence[0].id]; draft.findings[1].observations = [];
  assert.throws(() => validateReport(s, draft, new Set(reads.keys()), reads), /both regression runs/);
  draft.findings[1].verdict = 'contradicted';
  assert.throws(() => validateReport(s, draft, new Set(reads.keys()), reads), /both regression runs/);
  assert.deepEqual(missionReportOutput(s, reads).criteria[1].allowedVerdicts, ['needs_evidence']);
  const bad = new Map(f.reads); bad.get(a).digest = '0'.repeat(64);
  assert.throws(() => validateReport(s, f.draft(), new Set(bad.keys()), bad), /both regression runs/);
});

test('missing history remains a comparison gap while B QA and its negative outcome can complete', () => {
  const f = fixture(); f.config.criteria[1].delivery.baseline = null; f.runs.shift(); f.tasks[0].sources.shift();
  f.newRun.result.outcome = 'failed';
  const s = f.snapshot(); assert.equal(s.delivery.cases[0].complete, true);
  assert.equal(s.delivery.criteria[0].complete, true); assert.equal(s.delivery.criteria[1].complete, false);
  assert.ok(s.delivery.gaps.some(g => g.code === 'baseline_missing'));
  const draft = f.draft(); draft.findings[1] = { ...draft.findings[1], verdict: 'needs_evidence', evidenceIds: [], observations: [] };
  assert.equal(assembleReport(s, validateReport(s, draft, new Set(f.reads.keys()), f.reads), new Set(f.reads.keys()), f.reads).partial, true);
});

test('entry URL/version changes are comparable, changed requirements/basis are not and do not block current QA', () => {
  const f = fixture(); assert.equal(sameRegressionRequirement(f.oldRun.snapshot, f.newRun.snapshot), true);
  for (const field of ['title', 'type', 'preconditions', 'steps', 'expected', 'basis']) {
    const g = fixture(), value = field === 'basis' ? { kind: 'exploratory', quote: '', source: null } : field === 'type' ? 'manual' : 'Different requirement';
    g.item.content.cases[0][field] = value; g.newRun.snapshot[field] = value;
    const s = g.snapshot(); assert.equal(s.delivery.criteria[1].complete, false, field);
    assert.ok(s.delivery.gaps.some(gap => gap.code === 'comparison_definition_changed'), field);
  }
});

test('changed historical identity, newer review, wrong target and replaced evidence cannot borrow baseline permission', () => {
  for (const alter of [s => { s.sourceRevision = sha('changed'); }, s => { s.sourceId = randomUUID(); }, s => { s.target = { ...s.target, revision: 'other' }; }, s => { s.finishedAt = '2026-10-04T10:02:00.000Z'; }]) {
    const f = fixture(); alter(f.oldSource); const s = f.snapshot();
    assert.equal(s.delivery.criteria[1].complete, false);
    assert.ok(!selectMissionReportEvidence(s).proofEvidenceIds.includes(f.oldSource.evidence[0].id));
  }
});

test('selection timestamp and checkpoint identity cannot be invented or moved past the baseline capture', () => {
  const f = fixture(), delivery = f.config.criteria[1].delivery;
  assert.equal(regressionDeliverySchema.safeParse(delivery).success, true);
  assert.equal(regressionDeliverySchema.safeParse({ ...delivery, capturedAt: '2026-10-04T10:00:30.000Z' }).success, false);
  assert.equal(regressionDeliverySchema.safeParse({ ...delivery, caseKey: `${f.item.id}:${randomUUID()}` }).success, false);
});

test('installed writer SDK receives two real read results plus the exact historical/current identity and preserves both citations', async () => {
  // Match the app bundler's authored extensionless imports without a private overlay.
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/agent/lib/mission-reporter.ts')
      && ['../../shared/mission-report-output', '../../shared/mission-report-context', '../../shared/mission-report-evidence', './model-usage'].includes(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  } });
  let writeMissionReport;
  try { ({ writeMissionReport } = await import('../agent/lib/mission-reporter.ts')); }
  finally { hooks.deregister(); }
  const f = fixture(), snapshot = f.snapshot(), previousFetch = globalThis.fetch;
  const previousKey = process.env.GRUNDEN_API_TOKEN, previousPacing = process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS;
  process.env.GRUNDEN_API_TOKEN = 'synthetic-regression-key'; process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS = '0';
  const requests = [], ids = [];
  const wire = { findings: f.draft().findings.map(({ criterionId, verdict, observations }) => ({ criterionId, verdict, observations })) };
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.grunden.ai/v1/chat/completions'); requests.push(JSON.parse(options.body)); assert.equal(requests.length, 1);
    return new Response(JSON.stringify({ id: 'synthetic', created: 0, model: 'fixture', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(wire) }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 15 } }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await writeMissionReport(snapshot, async id => { ids.push(id); assert.ok(f.reads.has(id)); return f.reads.get(id); }, AbortSignal.timeout(5000));
    assert.deepEqual(new Set(ids), new Set(f.reads.keys())); assert.equal(result.usage.totalTokens, 65);
    const texts = requests[0].messages.at(-1).content.filter(part => part.type === 'text').flatMap(part => { try { return [JSON.parse(part.text)]; } catch { return []; } });
    assert.equal(texts[0].regressionComparisons[0].historicalRunId, f.oldRun.id);
    assert.equal(texts[0].regressionComparisons[0].currentRunId, f.newRun.id);
    assert.ok(texts.some(part => part.text === f.oldSource.summary)); assert.ok(texts.some(part => part.text === f.newSource.summary));
    const draft = validateReport(snapshot, result.draft, new Set(ids), f.reads);
    assert.deepEqual(new Set(draft.findings[1].evidenceIds), new Set(f.reads.keys()));
    assert.equal(assembleReport(snapshot, draft, new Set(ids), f.reads).partial, false);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of [['GRUNDEN_API_TOKEN', previousKey], ['GRUNDEN_MIN_REQUEST_INTERVAL_MS', previousPacing]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
