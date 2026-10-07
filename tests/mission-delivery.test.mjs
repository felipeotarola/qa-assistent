import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MAX_CRITERION_DELIVERIES, missionConfigSchema } from '../shared/mission.ts';
import { DELIVERY_POLICY_VERSION, missionDelivery } from '../shared/mission-delivery.ts';
import { missionMetrics } from '../shared/mission-metrics.ts';
import { runChecks } from '../shared/test-run.ts';
import { REVIEWER_VERSION } from '../shared/result-assessment.ts';

function fixture(count = 1) {
  const target = { environment: 'QA', url: 'https://example.com', revision: 'abc123' };
  const workspaceId = randomUUID(), itemId = randomUUID(), taskId = randomUUID();
  const cases = Array.from({ length: count }, (_, index) => ({ id: randomUUID(), title: `Navigation ${index + 1}`, type: 'browser', preconditions: 'Utloggad session', steps: '1. Öppna startsidan 2. Klicka Inspiration', expected: 'Länken öppnar rätt sida' }));
  const item = { id: itemId, title: 'Testplan', version: 1, content: { kind: 'test_plan', cases } };
  const caseKeys = cases.map(test => `${itemId}:${test.id}`);
  const config = { title: 'Undersök navigering', goal: 'Testa navigeringen och rapportera utfallet', scope: 'Publika sidor', criteria: [{ id: 'nav', text: 'Undersök huvudnavigationen', delivery: { kind: 'test_cases', caseKeys } }], target, caseKeys, automaticReports: false };
  const runs = cases.map(snapshot => ({ id: randomUUID(), workspaceId, itemId, caseId: snapshot.id, planVersion: 1, snapshot, target, environment: 'QA', threadId: randomUUID(), startedAt: '2026-10-05T10:00:00Z', finishedAt: '2026-10-05T10:01:00Z', result: { outcome: 'passed', actual: 'Länken fungerade', unverified: '', observations: [], evidenceItemIds: [], checks: runChecks(snapshot).map(check => ({ id: check.id, status: 'verified', actual: 'Observerat' })) } }));
  const sources = runs.map(run => ({ schemaVersion: 2, sourceType: 'test', sourceId: run.id, attemptId: run.id, status: 'completed', reportedOutcome: 'achieved', summary: run.result.actual, limitations: [], target, startedAt: run.startedAt, finishedAt: run.finishedAt, evidence: [{ id: `capture:${run.id}`, unavailable: false }], assessment: { id: randomUUID(), reviewerVersion: REVIEWER_VERSION, verdict: 'supported', summary: 'Rapporterade observationer är underbyggda', stale: false, ruleFindings: [], findings: runChecks(run.snapshot).map(check => ({ requirementId: check.id, verdict: 'supported', explanation: 'Visas i underlaget', evidenceIds: [`capture:${run.id}`], suggestedNextStep: '' })) } }));
  const tasks = [{ id: taskId, title: 'Kontrollera menyn', actor: 'browser', criterionIds: ['nav'], parentId: null, dependsOn: [], sources }];
  return { item, config, runs, tasks, project() { return missionDelivery([this.item], this.runs, this.config, this.tasks); } };
}

test('delivery expectations retain legacy input but validate explicit selection and every source type', () => {
  const f = fixture();
  assert.equal(missionConfigSchema.safeParse(f.config).success, true);
  assert.equal(missionConfigSchema.safeParse({ ...f.config, criteria: [{ id: 'nav', text: 'Legacy criterion' }] }).success, true);
  for (const delivery of [
    { kind: 'test_cases', caseKeys: [] },
    { kind: 'test_cases', caseKeys: [f.config.caseKeys[0], f.config.caseKeys[0]] },
    { kind: 'test_cases', caseKeys: [`${randomUUID()}:${randomUUID()}`] },
    { kind: 'source', sourceTypes: [] },
    { kind: 'source', sourceTypes: ['setup', 'setup'] },
    { kind: 'source', sourceTypes: ['invented'] },
  ]) assert.equal(missionConfigSchema.safeParse({ ...f.config, criteria: [{ id: 'nav', text: 'Expected', delivery }] }).success, false);
  assert.equal(missionConfigSchema.safeParse({ ...f.config, caseKeys: [f.config.caseKeys[0], f.config.caseKeys[0]] }).success, false);
});

test('terminal Iris with two out of three saved tests retains the missing delivery', () => {
  const f = fixture(3), missing = f.config.caseKeys[2];
  f.runs.pop(); f.tasks[0].sources.pop();
  f.tasks[0].sources.push({ schemaVersion: 2, sourceType: 'browser', sourceId: randomUUID(), status: 'completed', evidence: [{ id: 'narrative', unavailable: false }], assessment: null });
  const result = f.project();
  assert.equal(result.schemaVersion, DELIVERY_POLICY_VERSION);
  assert.equal(result.complete, false);
  assert.equal(result.cases.filter(test => test.complete).length, 2);
  assert.equal(result.cases.length, 3);
  assert.deepEqual(result.gaps.filter(gap => gap.code === 'run_missing').map(gap => [gap.criterionId, gap.caseKey]), [['nav', missing]]);
  const metrics = missionMetrics([f.item], f.runs, f.config, f.tasks);
  assert.equal(metrics.delivery.complete, false);
  assert.ok(metrics.gaps.some(gap => gap.includes('sparad körning')));
});

test('explicit saved sources cannot be satisfied by another source of the same type', () => {
  const f = fixture(2), refs = f.tasks[0].sources.map(source => ({ type: source.sourceType, id: source.sourceId }));
  f.config.caseKeys = [];
  f.config.criteria[0].delivery = { kind: 'source', sourceTypes: ['test'], sourceRefs: refs };
  assert.equal(missionConfigSchema.safeParse(f.config).success, true);
  assert.equal(f.project().complete, true);
  f.tasks[0].sources.pop();
  const missing = f.project();
  assert.equal(missing.complete, false);
  assert.equal(missing.gaps.find(gap => gap.code === 'source_missing').sourceId, refs[1].id);
  f.config.criteria[0].delivery.sourceTypes.push('research');
  assert.ok(f.project().gaps.some(gap => gap.sourceType === 'research'));
});

test('oversized criterion is rejected on write and stays an explicit gap in legacy data', () => {
  const f = fixture(MAX_CRITERION_DELIVERIES + 1);
  assert.equal(missionConfigSchema.safeParse(f.config).success, false);
  assert.equal(f.project().complete, false);
  assert.ok(f.project().gaps.some(gap => gap.code === 'criterion_too_large' && gap.criterionId === 'nav'));
  f.config.criteria = [
    { id: 'nav', text: 'First group', delivery: { kind: 'test_cases', caseKeys: f.config.caseKeys.slice(0, MAX_CRITERION_DELIVERIES) } },
    { id: 'rest', text: 'Remaining cases', delivery: { kind: 'test_cases', caseKeys: f.config.caseKeys.slice(MAX_CRITERION_DELIVERIES) } },
  ];
  assert.equal(missionConfigSchema.safeParse(f.config).success, true);
});

test('a supported product defect completes QA without converting its failed outcome', () => {
  const f = fixture();
  f.runs[0].result.outcome = 'failed';
  f.runs[0].result.observations = [{ title: 'Fel sida', detail: 'Klicket ger HTTP 500', kind: 'defect' }];
  f.runs[0].result.checks.at(-1).status = 'mismatch';
  f.tasks[0].sources[0].reportedOutcome = 'partial';
  const before = JSON.stringify(f);
  assert.equal(f.project().complete, true);
  assert.equal(JSON.stringify(f), before);
  const metrics = missionMetrics([f.item], f.runs, f.config, f.tasks);
  assert.equal(metrics.tests[0].originalOutcome, 'failed');
  assert.equal(metrics.tests[0].status, 'failed');
});

test('missing, duplicated, unknown and unperformed checkpoints are explicit gaps', () => {
  for (const [change, expected] of [
    [run => run.result.checks.pop(), 'check_missing'],
    [run => run.result.checks.push({ ...run.result.checks[0] }), 'check_ambiguous'],
    [run => run.result.checks.push({ id: 'invented', status: 'verified', actual: 'Claim' }), 'check_unknown'],
    [run => { run.result.checks[1].status = 'unverified'; }, 'check_incomplete'],
    [run => { run.result.checks[1].status = 'blocked'; }, 'check_incomplete'],
  ]) {
    const f = fixture(); change(f.runs[0]);
    assert.equal(f.project().complete, false);
    assert.ok(f.project().gaps.some(gap => gap.code === expected), expected);
    if (expected !== 'check_unknown') assert.ok(f.project().gaps.find(gap => gap.code === expected).requirementId);
  }
});

test('current supported findings are needed for every immutable checkpoint', () => {
  for (const change of [
    source => { source.assessment = null; },
    source => { source.assessment.stale = true; },
    source => { source.assessment.reviewerVersion = 'old'; },
    source => { delete source.assessment.findings; },
    source => { source.assessment.findings.pop(); },
    source => { source.assessment.findings.push(source.assessment.findings[0]); },
    source => { source.assessment.findings[0].verdict = 'needs_evidence'; },
    source => { source.assessment.findings[0].evidenceIds = []; },
    source => { source.assessment.verdict = 'contradicted'; },
  ]) {
    const f = fixture(); change(f.tasks[0].sources[0]);
    assert.equal(f.project().complete, false);
    assert.ok(f.project().gaps.some(gap => gap.code.startsWith('review_')));
  }
});

test('warnings on unused attachments do not negate a current validated review', () => {
  const f = fixture();
  f.tasks[0].sources[0].assessment.ruleFindings = [{ code: 'evidence_unattested', message: 'Unused capture metadata', requirementId: null }];
  assert.equal(f.project().complete, true);
});

test('a run on a task for another criterion cannot fill this criterion', () => {
  const f = fixture(); f.tasks[0].criterionIds = ['other'];
  assert.equal(f.project().complete, false);
  assert.ok(f.project().gaps.some(gap => gap.code === 'criterion_source_missing' && gap.sourceId === f.runs[0].id && gap.criterionId === 'nav'));
  f.tasks = [];
  assert.ok(f.project().gaps.some(gap => gap.code === 'run_unbound'));
});

test('changed definitions, removed cases and target mismatch retain selected case identity', () => {
  for (const [change, code] of [
    [f => { f.item.content.cases[0] = { ...f.item.content.cases[0], expected: 'Nytt krav' }; }, 'run_stale'],
    [f => { f.config.target = { ...f.config.target, revision: 'new' }; }, 'run_stale'],
    [f => { f.item.content.cases = []; }, 'case_missing'],
  ]) {
    const f = fixture(); change(f); const result = f.project();
    assert.equal(result.complete, false);
    assert.ok(result.gaps.some(gap => gap.code === code && gap.caseKey === f.config.caseKeys[0]), code);
  }
});

test('unknown target and invalid run intervals cannot be completed deliveries', () => {
  for (const change of [
    f => { f.config.target = null; },
    f => { f.config.target = { ...f.config.target, revision: '' }; },
    f => { f.runs[0].startedAt = 'unknown'; },
    f => { f.runs[0].finishedAt = null; },
    f => { f.runs[0].finishedAt = '2026-10-05T09:00:00Z'; },
  ]) { const f = fixture(); change(f); assert.equal(f.project().complete, false); }
});

test('latest compatible unfinished attempt replaces older success without inflating case totals', () => {
  const f = fixture();
  const retry = { ...f.runs[0], id: randomUUID(), startedAt: '2026-10-05T11:00:00Z', finishedAt: null, result: null };
  f.runs.push(retry);
  f.tasks[0].sources.push({ ...f.tasks[0].sources[0], sourceId: retry.id, status: 'running', assessment: null });
  const metrics = missionMetrics([f.item], f.runs, f.config, f.tasks);
  assert.equal(metrics.delivery.cases.length, 1);
  assert.equal(metrics.delivery.cases[0].runId, retry.id);
  assert.equal(metrics.delivery.complete, false);
  assert.deepEqual(metrics.metrics.at(-1).data.map(point => point.value), [1, 2]);
});

test('source expectations require every requested type on relevant tasks, not an executor status', () => {
  const f = fixture(); f.config.caseKeys = [];
  f.config.criteria[0].delivery = { kind: 'source', sourceTypes: ['research', 'repository'] };
  f.tasks[0].sources = [{ schemaVersion: 2, sourceType: 'research', sourceId: randomUUID(), status: 'completed', evidence: [{ id: 'page', unavailable: false }] }];
  assert.deepEqual(f.project().gaps.map(gap => [gap.code, gap.sourceType]), [['source_missing', 'repository']]);
  f.tasks[0].sources.push({ schemaVersion: 2, sourceType: 'repository', sourceId: randomUUID(), status: 'failed', target: f.config.target, evidence: [{ id: 'stderr', unavailable: false }] });
  assert.equal(f.project().complete, true);
  for (const change of [
    source => { source.status = 'running'; }, source => { source.status = 'cancelled'; },
    source => { source.schemaVersion = 1; }, source => { source.evidence[0].unavailable = true; },
  ]) { const copy = structuredClone(f.tasks); change(f.tasks[0].sources[1]); assert.equal(f.project().complete, false); f.tasks = copy; }
});

test('research-only deliveries need no fabricated test totals or target', () => {
  const f = fixture(); f.config.caseKeys = []; f.config.target = null;
  f.config.criteria[0].delivery = { kind: 'source', sourceTypes: ['research'] };
  f.tasks[0].sources = [{ schemaVersion: 2, sourceType: 'research', sourceId: randomUUID(), status: 'completed', evidence: [{ id: 'source', unavailable: false }] }];
  const output = missionMetrics([f.item], [], f.config, f.tasks);
  assert.equal(output.delivery.complete, true);
  assert.deepEqual(output.tests, []); assert.deepEqual(output.metrics, []); assert.deepEqual(output.gaps, []);
});

test('setup and repository deliveries expose unknown or mismatched required revisions', () => {
  for (const sourceType of ['setup', 'repository']) {
    const f = fixture(); f.config.caseKeys = [];
    f.config.criteria[0].delivery = { kind: 'source', sourceTypes: [sourceType] };
    f.tasks[0].sources = [{ schemaVersion: 2, sourceType, sourceId: randomUUID(), status: 'completed', target: { environment: 'VPS', url: 'http://127.0.0.1:3000', revision: 'old' }, evidence: [{ id: 'command', unavailable: false }] }];
    assert.equal(f.project().complete, false);
    assert.ok(f.project().gaps.some(gap => gap.code === 'target_mismatch' && gap.sourceType === sourceType));
    f.tasks[0].sources[0].target.revision = '';
    assert.ok(f.project().gaps.some(gap => gap.code === 'revision_unknown'));
    f.tasks[0].sources[0].target.revision = f.config.target.revision;
    assert.equal(f.project().complete, true);
  }
});

test('legacy missing expectations and unmapped selected cases are explicit unknown coverage', () => {
  const f = fixture(); delete f.config.criteria[0].delivery;
  const result = f.project();
  assert.equal(result.complete, false);
  assert.ok(result.gaps.some(gap => gap.code === 'expectation_unknown'));
  assert.ok(result.gaps.some(gap => gap.code === 'case_unmapped'));
});

test('manual green override never erases original incomplete QA or a disputed review', () => {
  const f = fixture();
  f.runs[0].reviews = [{ outcome: 'passed', reason: 'Manual override', createdAt: '2026-10-05T12:00:00Z' }];
  f.runs[0].result.outcome = 'inconclusive'; f.runs[0].result.unverified = 'Cookie avvisa inte testat';
  assert.equal(f.project().complete, false);
  f.runs[0].result.outcome = 'passed'; f.runs[0].result.unverified = '';
  f.tasks[0].sources[0].assessment.findings[0].verdict = 'contradicted';
  assert.equal(f.project().complete, false);
});

test('manual reservations or an opposite product outcome remain unresolved deliveries', () => {
  for (const [original, manual] of [['passed', 'inconclusive'], ['passed', 'blocked'], ['failed', 'interrupted'], ['failed', 'passed'], ['passed', 'failed']]) {
    const f = fixture(); f.runs[0].result.outcome = original;
    f.runs[0].reviews = [{ outcome: manual, reason: 'Requires independent follow-up', createdAt: '2026-10-05T12:00:00Z' }];
    assert.equal(f.project().complete, false);
    assert.ok(f.project().gaps.some(gap => gap.code === 'manual_review_unresolved'));
  }
  const f = fixture(); f.runs[0].reviews = [{ outcome: 'passed', reason: 'Confirms original finding', createdAt: '2026-10-05T12:00:00Z' }];
  assert.equal(f.project().complete, true);
});

test('typed remaining scope and optional suggestions cannot weaken delivery requirements', () => {
  const f = fixture();
  const original = { ...f.runs[0].result };
  delete original.unverified;
  f.runs[0].result = { ...original, schemaVersion: 2, remaining: [], suggestedFollowUps: ['Repeat with another browser outside this case.'] };
  assert.equal(f.project().complete, true);
  f.runs[0].result.checks[1].status = 'unverified';
  f.runs[0].result.outcome = 'inconclusive';
  assert.equal(f.project().complete, false, 'Empty remaining cannot hide unfinished original checks');
  assert.ok(f.project().gaps.some(gap => gap.code === 'result_scope_invalid'));
  f.runs[0].result.remaining = [{ checkId: f.runs[0].result.checks[1].id, reason: 'Not observed' }];
  assert.ok(f.project().gaps.some(gap => gap.code === 'result_incomplete'));
  f.runs[0].result.checks[1].status = 'mismatch';
  f.runs[0].result.remaining = []; f.runs[0].result.outcome = 'failed';
  f.runs[0].result.observations = [{ title: 'Observed bug', detail: 'Original expected behavior did not occur.', kind: 'defect' }];
  assert.equal(f.project().complete, true, 'Supported failure completes the requested QA delivery');
  f.runs[0].result.observations.push({ title: 'Missing requirement', detail: 'Original criterion remains unclear.', kind: 'requirement_gap' });
  assert.equal(f.project().complete, false);
});

function sourceSelection(f) {
  f.config.caseKeys = [];
  f.config.criteria[0].delivery = { kind: 'source', sourceTypes: ['test'], sourceRefs: f.runs.map(run => ({ type: 'test', id: run.id })) };
  return f;
}

test('explicit run reports preserve passed, supported failed and incomplete outcomes separately', () => {
  const f = sourceSelection(fixture(3));
  f.runs[1].result.outcome = 'failed'; f.runs[1].result.checks.at(-1).status = 'mismatch';
  f.tasks[0].sources[1].reportedOutcome = 'partial';
  f.runs[2].result.outcome = 'inconclusive'; f.runs[2].result.checks.at(-1).status = 'unverified';
  f.tasks[0].sources[2].assessment.verdict = 'needs_evidence';
  const before = JSON.stringify(f);
  const result = missionMetrics([f.item], f.runs, f.config, f.tasks);
  assert.equal(result.delivery.complete, false);
  assert.ok(result.delivery.gaps.some(gap => gap.sourceId === f.runs[2].id && gap.code === 'result_incomplete'));
  assert.ok(!result.delivery.gaps.some(gap => gap.sourceId === f.runs[1].id));
  assert.deepEqual(result.tests.map(test => test.originalOutcome), ['passed', 'failed', 'inconclusive']);
  assert.deepEqual(result.tests.map(test => test.runId), f.runs.map(run => run.id));
  assert.equal(result.metrics.flatMap(metric => metric.data).reduce((sum, point) => sum + point.value, 0), 3);
  assert.equal(JSON.stringify(f), before);
});

test('two explicitly selected runs of one case survive without adopting an unselected later run', () => {
  const f = fixture(), first = f.runs[0], second = { ...structuredClone(first), id: randomUUID(), startedAt: '2026-10-05T10:02:00Z', finishedAt: '2026-10-05T10:03:00Z' };
  f.runs.push(second); f.tasks[0].sources.push({ ...structuredClone(f.tasks[0].sources[0]), sourceId: second.id });
  sourceSelection(f);
  f.config.criteria.push({ ...structuredClone(f.config.criteria[0]), id: 'duplicate-reference' });
  f.tasks[0].criterionIds.push('duplicate-reference');
  const latest = { ...structuredClone(second), id: randomUUID(), startedAt: '2026-10-05T11:00:00Z' };
  const result = missionMetrics([f.item], [...f.runs, latest], f.config, f.tasks);
  assert.equal(result.delivery.complete, true);
  assert.deepEqual(result.tests.map(test => test.runId), [first.id, second.id]);
  assert.equal(new Set(result.tests.map(test => test.key)).size, 2);
  assert.equal(result.metrics[0].data.reduce((sum, point) => sum + point.value, 0), 2);
});

test('explicit source runs retain stale definitions, deleted plans and absent records as gaps', () => {
  const f = sourceSelection(fixture());
  f.item.version++;
  let result = missionMetrics([f.item], f.runs, f.config, f.tasks);
  assert.equal(result.delivery.complete, false); assert.equal(result.tests[0].status, 'stale');
  assert.equal(result.tests[0].originalOutcome, 'passed');
  assert.ok(result.delivery.gaps.some(gap => gap.code === 'run_stale'));
  result = missionMetrics([], f.runs, f.config, f.tasks);
  assert.equal(result.delivery.complete, false); assert.equal(result.tests[0].runId, f.runs[0].id);
  result = missionMetrics([f.item], [], f.config, f.tasks);
  assert.equal(result.tests[0].status, 'untested'); assert.equal(result.tests[0].runId, null);
  assert.ok(result.delivery.gaps.some(gap => gap.code === 'run_missing'));
});

test('explicit source reports use the same checkpoint, review and manual reservation rules as case reports', () => {
  for (const change of [
    f => { f.runs[0].result.checks.pop(); },
    f => { f.tasks[0].sources[0].assessment.stale = true; },
    f => { f.tasks[0].sources[0].assessment.findings.pop(); },
    f => { f.runs[0].reviews = [{ outcome: 'blocked', reason: 'Reservation', createdAt: '2026-10-05T12:00:00Z' }]; },
  ]) {
    const f = fixture(); change(f); const caseDelivery = f.project();
    sourceSelection(f); const sourceDelivery = f.project();
    assert.equal(caseDelivery.complete, false); assert.equal(sourceDelivery.complete, false);
    assert.deepEqual(new Set(sourceDelivery.gaps.map(gap => gap.code)), new Set(caseDelivery.gaps.map(gap => gap.code)));
  }
});

test('equal display labels never merge separate observation scopes in explicit run metrics', () => {
  const f = sourceSelection(fixture(2)); f.config.target = null;
  for (const [i, run] of f.runs.entries()) {
    run.target = { ...run.target, revision: '', scope: { kind: 'observation', id: randomUUID(), capturedAt: '2026-10-05T10:00:00.000Z' } };
    f.tasks[0].sources[i].target = run.target;
  }
  const result = missionMetrics([f.item], f.runs, f.config, f.tasks);
  assert.equal(result.tests[0].target, result.tests[1].target);
  assert.equal(result.metrics.length, 2);
  assert.ok(result.metrics.every(metric => metric.data.reduce((sum, point) => sum + point.value, 0) === 1));
});

test('a version-only plan edit makes selected-case delivery and statistics stale without relabelling the original outcome', () => {
  const f = fixture();
  f.item.version++;
  const result = missionMetrics([f.item], f.runs, f.config, f.tasks);
  assert.equal(result.delivery.complete, false);
  assert.ok(result.delivery.gaps.some(gap => gap.code === 'run_stale' && gap.caseKey === f.config.caseKeys[0]));
  assert.equal(result.tests.length, 1);
  assert.equal(result.tests[0].runId, f.runs[0].id);
  assert.equal(result.tests[0].status, 'stale');
  assert.equal(result.tests[0].originalOutcome, 'passed');
  const outcomes = result.metrics.find(metric => metric.id === 'test-outcomes-0');
  assert.equal(outcomes.data.find(point => point.label === 'Godkänt').value, 0);
  assert.equal(outcomes.data.find(point => point.label === 'Behöver testas om').value, 1);
});

test('overlapping exact source and case selection count the same run once and agree on its plan-version freshness', () => {
  const f = fixture();
  f.config.criteria.push({ id: 'saved', text: 'Review the exact saved run', delivery: { kind: 'source', sourceTypes: ['test'], sourceRefs: [{ type: 'test', id: f.runs[0].id }] } });
  f.tasks[0].criterionIds.push('saved');
  for (const stale of [false, true]) {
    if (stale) f.item.version++;
    const before = JSON.stringify(f);
    const result = missionMetrics([f.item], f.runs, f.config, f.tasks);
    assert.equal(result.delivery.complete, !stale);
    assert.deepEqual(result.delivery.criteria.map(criterion => criterion.complete), [!stale, !stale]);
    assert.equal(result.tests.length, 1, 'An explicit reference must not duplicate an already displayed exact run');
    assert.equal(result.tests[0].runId, f.runs[0].id);
    assert.equal(result.tests[0].status, stale ? 'stale' : 'passed');
    assert.equal(result.tests[0].originalOutcome, 'passed');
    assert.equal(result.metrics.filter(metric => metric.id !== 'test-attempts').flatMap(metric => metric.data).reduce((sum, point) => sum + point.value, 0), 1);
    assert.equal(JSON.stringify(f), before, 'Projection must not mutate the saved source or result');
  }
});
