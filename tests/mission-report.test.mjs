import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { missionActionSchema, missionBindingSchema, missionConfigSchema, redactReportText, workStatus } from '../shared/mission.ts';
import { missionMetrics } from '../shared/mission-metrics.ts';
import { validateReport, assembleReport, reportText } from '../shared/mission-report.ts';
import { sharedReportDocument, safeReportUrl, shareActionSchema } from '../shared/report-sharing.ts';

const target = { environment: 'QA', url: 'https://example.com', revision: 'a' };
const digest = 'a'.repeat(64);
const reads = new Map([['e1', { id: 'e1', digest }]]);
test('gateway-encoded mission inputs preserve identical validation and canonical values', () => {
  const config = { ...fixture().config, target: null };
  const create = { action: 'create', requestId: randomUUID(), config };
  assert.deepEqual(missionActionSchema.parse({ ...create, config: JSON.stringify(config) }), missionActionSchema.parse(create));
  const task = { actor: 'main', title: 'Read source', criterionIds: ['nav'], dependsOn: [] };
  const input = { action: 'task', requestId: randomUUID(), missionId: randomUUID(), task };
  assert.deepEqual(missionActionSchema.parse({ ...input, task: JSON.stringify(task) }), missionActionSchema.parse(input));
  const binding = { missionId: randomUUID(), taskId: randomUUID() };
  assert.deepEqual(missionBindingSchema.parse(JSON.stringify(binding)), binding);
  for (const config of ['{', 'null', '[]', '{}', JSON.stringify({ ...create.config, criteria: [] }), ' '.repeat(200001)]) {
    assert.equal(missionActionSchema.safeParse({ ...create, config }).success, false);
  }
  assert.equal(missionBindingSchema.safeParse(JSON.stringify({ ...binding, taskId: 'invented' })).success, false);
});
function fixture() {
  const c = { id: randomUUID(), title: 'Navigation', type: 'browser', preconditions: '', steps: 'Klicka Inspiration', expected: 'Länken öppnar sidan' };
  const item = { id: randomUUID(), title: 'Plan', version: 1, content: { kind: 'test_plan', cases: [c] } };
  const config = { title: 'Uppdrag', goal: 'Kontrollera navigering', scope: 'Huvudmeny', criteria: [{ id: 'nav', text: 'Navigeringslänken fungerar', delivery: { kind: 'test_cases', caseKeys: [`${item.id}:${c.id}`] } }], target, caseKeys: [`${item.id}:${c.id}`], automaticReports: false };
  const run = { id: randomUUID(), itemId: item.id, caseId: c.id, planVersion: 1, snapshot: c, target, startedAt: '2026-10-04T10:00:00Z', finishedAt: '2026-10-04T10:01:00Z', result: { outcome: 'passed', actual: 'Länken öppnades', unverified: '', observations: [], evidenceItemIds: [] } };
  const evidence = { id: 'e1', itemId: randomUUID(), version: 1, title: 'Logg', kind: 'image', url: null, origin: 'tool', evidencePolicyVersion: 2, provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: run.id, observedAt: run.finishedAt, sha256: digest }, hash: 'digest', excerpt: 'Klick timeout, direkt URL lyckades', observedAt: run.finishedAt, unavailable: false };
  const tasks = [{ id: 'task-1', title: 'Klicka menyn', actor: 'browser', criterionIds: ['nav'], parentId: null, dependsOn: [], sources: [{ schemaVersion: 2, target, sourceType: 'test', sourceId: run.id, status: 'completed', evidence: [evidence], assessment: null, startedAt: run.startedAt, finishedAt: run.finishedAt }] }];
  const snapshot = { schemaVersion: 2, missionId: 'm', workspaceId: 'w', revision: 3, config, status: 'closed', capturedAt: run.finishedAt, tasks, tests: [], metrics: [], gaps: [], delivery: { schemaVersion: 1, complete: true, criteria: [{ criterionId: 'nav', complete: true, gaps: [] }], cases: [{ caseKey: config.caseKeys[0], runId: run.id, complete: true, gaps: [] }], gaps: [] } };
  const draft = { summary: 'Navigeringen saknar verifiering.', findings: [{ criterionId: 'nav', verdict: 'needs_evidence', conclusion: 'Direkt URL bevisar inte klick', evidenceIds: ['e1'], nextStep: 'Kontrollera klicket' }], limitations: [] };
  return { c, item, config, run, tasks, snapshot, draft };
}
test('reruns count as attempts, latest unfinished attempt replaces an older pass', () => {
  const f = fixture(), retry = { ...f.run, id: randomUUID(), startedAt: '2026-10-04T11:00:00Z', result: null, finishedAt: null };
  const output = missionMetrics([f.item], [f.run, retry], f.config, f.tasks);
  assert.equal(output.tests[0].status, 'running');
  assert.deepEqual(output.metrics.at(-1).data.map(d => d.value), [1, 2]);
});

test('repository report labels use saved source identities without merging different commits', () => {
  const { snapshot, draft } = fixture();
  snapshot.config.target = null;
  const source = snapshot.tasks[0].sources[0];
  source.sourceType = 'repository';
  source.target = { environment: 'repository', url: 'https://github.com/example/library', revision: 'a'.repeat(40) };
  snapshot.tasks[0].sources.push({ ...source, sourceId: randomUUID() });
  const label = assembleReport(snapshot, draft, new Set()).target;
  assert.equal(label, `Repository · https://github.com/example/library · ${'a'.repeat(40)}`);
  snapshot.tasks[0].sources.push({ ...source, sourceId: randomUUID(), target: { ...source.target, revision: 'b'.repeat(40) } });
  assert.equal(assembleReport(snapshot, draft, new Set()).target, 'Flera repositorymål eller versioner (2)');
  snapshot.config.target = target;
  assert.equal(assembleReport(snapshot, draft, new Set()).target, 'QA · https://example.com · a');
  snapshot.config.target = null;
  snapshot.tasks[0].sources.push({ ...source, sourceType: 'test', target });
  assert.equal(assembleReport(snapshot, draft, new Set()).target, 'Testobjekt ej angivet');
  snapshot.tasks[0].sources.at(-1).target = null;
  assert.equal(assembleReport(snapshot, draft, new Set()).target, 'Testobjekt ej angivet');
  snapshot.tasks[0].sources.at(-1).sourceType = 'repository';
  assert.equal(assembleReport(snapshot, draft, new Set()).target, 'Testobjekt ej angivet');
  snapshot.tasks[0].sources.at(-1).sourceType = 'material';
  assert.equal(assembleReport(snapshot, draft, new Set()).target, 'Flera repositorymål eller versioner (2)');
  snapshot.config.target = null; snapshot.tasks[0].sources = [];
  assert.equal(assembleReport(snapshot, draft, new Set()).target, 'Testobjekt ej angivet');
});

test('report task status preserves orchestration failure even when its source execution completed', () => {
  const { snapshot, draft } = fixture();
  const task = snapshot.tasks[0];
  task.title = 'Klara granskar testresultaten';
  task.state = 'failed';
  task.sources[0].reportedOutcome = 'partial';
  const before = JSON.stringify(snapshot);
  const report = assembleReport(snapshot, draft, new Set());
  assert.equal(report.tasks[0].status, 'failed');
  assert.equal(report.tasks[0].reportedOutcome, 'partial');
  assert.match(reportText(report), /Klara granskar testresultaten: failed/);
  assert.equal(JSON.stringify(snapshot), before);
});

test('task state is separate from source outcome; missing historical state retains the source projection', () => {
  const { snapshot, draft } = fixture();
  const task = snapshot.tasks[0];
  for (const state of ['pending', 'ready', 'waiting', 'running', 'blocked', 'failed', 'cancelled', 'completed']) {
    task.state = state;
    assert.equal(assembleReport(snapshot, draft, new Set()).tasks[0].status, state);
  }
  for (const state of [undefined, null]) {
    task.state = state;
    assert.equal(assembleReport(snapshot, draft, new Set()).tasks[0].status, 'completed');
  }
  task.state = 'not-a-state';
  assert.equal(assembleReport(snapshot, draft, new Set()).tasks[0].status, 'unknown');
});

test('a later pass cannot silently remove previous failed or incomplete observations from the report', () => {
  const f = fixture(), previous = { ...f.run, id: randomUUID(), startedAt: '2026-10-04T09:00:00Z', finishedAt: '2026-10-04T09:01:00Z', result: { ...f.run.result, outcome: 'failed' } };
  const before = JSON.stringify(previous);
  Object.assign(f.snapshot, missionMetrics([f.item], [previous, f.run], f.config, f.tasks));
  const report = assembleReport(f.snapshot, f.draft, new Set());
  assert.ok(report.limitations.some(text => text.includes(previous.id) && text.includes('rapporterat utfall failed') && text.includes('unreviewed')));
  assert.equal(report.tests[0].runId, f.run.id); assert.equal(JSON.stringify(previous), before);
});

test('report-only finding must read independent evidence for every exact selected source', () => {
  const f = fixture(), first = f.tasks[0].sources[0], secondId = randomUUID();
  const second = { ...first, sourceId: secondId, evidence: [{ ...first.evidence[0], id: 'e2', provenance: { ...first.evidence[0].provenance, sourceId: secondId } }] };
  f.tasks[0].sources.push(second);
  f.config.caseKeys = [];
  f.config.criteria[0].delivery = { kind: 'source', sourceTypes: ['test'], sourceRefs: [{ type: 'test', id: first.sourceId }, { type: 'test', id: secondId }] };
  f.draft.findings[0].verdict = 'supported';
  assert.throws(() => validateReport(f.snapshot, f.draft, new Set(['e1']), reads), /every requested source$/);
  f.draft.findings[0].evidenceIds.push('e2');
  assert.doesNotThrow(() => validateReport(f.snapshot, f.draft, new Set(['e1', 'e2']), new Map([...reads, ['e2', { id: 'e2', digest }]])));
});
test('mixed targets and unknown versions keep separate denominators', () => {
  const f = fixture(), other = { ...f.run, id: randomUUID(), target: { ...target, revision: 'b' }, result: { ...f.run.result, outcome: 'failed' } }, unknown = { ...f.run, id: randomUUID(), target: null };
  const output = missionMetrics([f.item], [f.run, other, unknown], f.config, f.tasks);
  assert.equal(output.tests.length, 3); assert.equal(new Set(output.tests.map(t => t.target)).size, 3);
  assert.deepEqual(output.tests.map(t => t.status), ['passed', 'failed', 'passed']);
  assert.ok(output.gaps.some(g => g.includes('okänd')));
});
test('never-started and removed selected cases are included, unrelated runs are excluded', () => {
  const f = fixture(); f.config.caseKeys.push(`${randomUUID()}:${randomUUID()}`);
  const output = missionMetrics([f.item], [{ ...f.run, caseId: randomUUID() }], f.config, f.tasks);
  assert.equal(output.tests.length, 2); assert.ok(output.tests.every(t => t.status === 'untested'));
  assert.equal(output.metrics.at(-1).data[1].value, 0);
});
test('changed definitions and manual judgements remain distinct from original results', () => {
  const f = fixture(); f.run.reviews = [{ outcome: 'inconclusive', reason: 'Automationsfelet är inte reproducerat', createdAt: '2026-10-04', userId: 'tester' }];
  const output = missionMetrics([f.item], [f.run], f.config, f.tasks);
  assert.equal(output.tests[0].status, 'inconclusive'); assert.equal(output.tests[0].originalOutcome, 'passed'); assert.match(output.tests[0].manualReview, /Automationsfelet/);
  f.item.content.cases[0] = { ...f.c, expected: 'Ett annat krav' };
  assert.equal(missionMetrics([f.item], [f.run], f.config, f.tasks).tests[0].status, 'stale');
});
test('research without selected tests invents no totals', () => {
  const f = fixture(); f.config.caseKeys = [];
  const output = missionMetrics([f.item], [f.run], f.config, f.tasks);
  assert.deepEqual(output.metrics, []); assert.deepEqual(output.tests, []);
});
test('all criteria require explicit coverage and only read applicable citations are allowed', () => {
  const f = fixture(); assert.equal(validateReport(f.snapshot, f.draft, new Set(['e1'])).findings.length, 1);
  assert.throws(() => validateReport(f.snapshot, f.draft, new Set()));
  assert.throws(() => validateReport(f.snapshot, { ...f.draft, findings: [] }, new Set(['e1'])));
  assert.throws(() => validateReport(f.snapshot, { ...f.draft, findings: [f.draft.findings[0], f.draft.findings[0]] }, new Set(['e1'])));
  f.tasks[0].criterionIds = ['other']; assert.throws(() => validateReport(f.snapshot, f.draft, new Set(['e1'])));
});
test('supported failures are allowed but unsupported conclusions are not', () => {
  const f = fixture(); f.draft.findings[0] = { ...f.draft.findings[0], verdict: 'supported', conclusion: 'Underlaget bekräftar rapporterad HTTP 500.' };
  assert.equal(validateReport(f.snapshot, f.draft, new Set(['e1']), reads).findings[0].verdict, 'supported');
  f.draft.findings[0].evidenceIds = []; assert.throws(() => validateReport(f.snapshot, f.draft, new Set()));
});
test('report and export use the frozen metrics without mutating source data', () => {
  const f = fixture(); Object.assign(f.snapshot, missionMetrics([f.item], [f.run], f.config, f.tasks));
  f.draft.findings[0].observations = [{ text: f.draft.findings[0].conclusion, evidenceIds: ['e1'] }];
  const before = JSON.stringify(f.snapshot); const report = assembleReport(f.snapshot, f.draft, new Set(['e1']), reads);
  assert.equal(JSON.stringify(f.snapshot), before); assert.deepEqual(report.metrics, f.snapshot.metrics);
  assert.match(reportText(report), /Registrerade försök: 1/); assert.match(reportText(report), /Direkt URL bevisar inte klick/);
  assert.equal(report.partial, true); f.snapshot.status = 'active'; assert.equal(assembleReport(f.snapshot, f.draft, new Set()).partial, true);
});

test('report completeness follows delivered scope and findings, not mission closure', () => {
  const f = fixture(); f.snapshot.status = 'active'; f.draft.findings[0].verdict = 'supported';
  assert.equal(assembleReport(f.snapshot, f.draft, new Set(['e1'])).partial, false);
  f.snapshot.delivery.complete = false; f.snapshot.delivery.criteria[0].complete = false;
  f.snapshot.status = 'closed';
  assert.throws(() => validateReport(f.snapshot, f.draft, new Set(['e1']), reads), /delivery/);
  f.draft.findings[0].verdict = 'contradicted';
  assert.equal(validateReport(f.snapshot, f.draft, new Set(['e1']), reads).findings[0].verdict, 'contradicted');
  assert.equal(assembleReport(f.snapshot, f.draft, new Set(['e1'])).partial, true);
  delete f.snapshot.delivery;
  assert.equal(assembleReport(f.snapshot, f.draft, new Set(['e1'])).partial, true);
  f.draft.findings[0].verdict = 'supported';
  assert.throws(() => validateReport(f.snapshot, f.draft, new Set(['e1']), reads), /independent evidence/);
});
test('public projection excludes internal item references and unselected attachments', () => {
  const f = fixture(), report = assembleReport(f.snapshot, f.draft, new Set(['e1']));
  const publicDoc = sharedReportDocument(report, []);
  assert.equal(publicDoc.evidence[0].itemId, null); assert.equal(publicDoc.evidence[0].kind, 'unshared');
  assert.notEqual(report.evidence[0].itemId, null); assert.equal(sharedReportDocument(report, ['e1']).evidence[0].kind, 'image');
  for (const url of ['javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com?token=secret']) assert.equal(safeReportUrl(url), null);
});
test('credentials are redacted in JSON, environment assignments and bearer logs', () => {
  for (const input of ['NEXT_PUBLIC_SUPABASE_ANON_KEY=secret-value', '"API_TOKEN":"secret-value"', 'Authorization: Bearer secret-value', 'password=secret-value', 'https://user:secret-value@example.com']) assert.ok(!redactReportText(input).includes('secret-value'), input);
});
test('scope contracts reject duplicate criteria and invalid PINs', () => {
  const f = fixture(); f.config.criteria.push(f.config.criteria[0]); assert.equal(missionConfigSchema.safeParse(f.config).success, false);
  assert.equal(shareActionSchema.safeParse({ action: 'create', mode: 'pin', pin: '12', evidenceIds: [], expiresAt: null }).success, false);
  assert.equal(workStatus('needs_configuration'), 'failed'); assert.equal(workStatus('installing'), 'running'); assert.equal(workStatus('review'), 'completed');
});

test('executor narratives can be cited as claims but never serve as independent proof', () => {
  const f=fixture(); f.snapshot.tasks[0].sources[0].evidence[0].origin='agent';
  const read=new Set(['e1']);
  assert.equal(validateReport(f.snapshot,f.draft,read).findings[0].verdict,'needs_evidence');
  f.draft.findings[0].verdict='supported';
  assert.throws(()=>validateReport(f.snapshot,f.draft,read),/independent/);
});

test('shared projection hides internal target URLs inside text and chart labels', () => {
 const f=fixture(), doc=assembleReport(f.snapshot,f.draft,new Set(['e1']));
 doc.target='VPS http://127.0.0.1:3000/'; doc.summary='Kontroll via http://10.1.2.3:3000 gav 500.';
 const shared=sharedReportDocument(doc,[]);
 assert.ok(!JSON.stringify(shared).includes('127.0.0.1')); assert.ok(!shared.summary.includes('10.1.2.3'));
 for(const url of ['http://localhost:3000','http://192.168.1.1','http://169.254.169.254','http://[::1]/']) assert.equal(safeReportUrl(url),null);
});
