import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditEvidenceCompletion, evidenceConclusionProfile, evidencePrompt, fingerprint, EVIDENCE_PROTOCOL } from './helpers/evidence-acceptance.mjs';

const v1 = 'syna-evidence-acceptance-v1', v2 = 'syna-evidence-acceptance-v2', v3 = 'syna-evidence-acceptance-v3';
const empty = () => Object.fromEntries(['missions', 'tasks', 'attempts', 'jobs', 'runs', 'reviews', 'reports', 'claims', 'events', 'captures', 'items', 'repositories', 'setups'].map(key => [key, []]));
function fixture() {
  const before = empty();
  before.runs = ['click', 'direct'].map((id, index) => ({ id, item_id: `plan-${id}`, case_id: 'case', plan_version: 1, snapshot: { title: id }, runtime: 'autonomy-test:unit',
    target: { environment: 'QA', revision: 'A', url: 'https://unit.example.test/' }, result: { outcome: index ? 'passed' : 'failed' }, started_at: '2026-10-06T00:00:00Z', finished_at: '2026-10-06T00:01:00Z' }));
  before.captures = before.runs.map((run, index) => ({ id: `capture-${run.id}`, run_id: run.id, item_id: `proof-${run.id}`, version: 1, deleted_at: null, error: null,
    content: { kind: 'file', mime: 'text/plain', size: 25 }, provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: run.id, observedAt: '2026-10-06T00:00:30Z', sha256: String(index + 1).repeat(64) } }));
  before.items = [{ id: 'note', title: 'Saved agent note', version: 1, deleted_at: null, content: { kind: 'text', text: 'The full flow works.' }, provenance: { version: 1, origin: 'agent', producer: 'agent-authored', observedAt: null } }];
  const selection = [...before.runs.map(run => ({ type: 'test', id: run.id, label: `Saved ${run.id}` })), { type: 'material', id: 'note', label: 'Saved agent note' }];
  const originals = [...before.captures.map(item => ({ ...item, id: item.item_id })), before.items[0]];
  const evidence = originals.map(item => ({ id: `item:${item.id}`, itemId: item.id, version: item.version, origin: item.provenance.origin, provenance: item.provenance,
    hash: fingerprint({ content: item.content, provenance: item.provenance, evidencePolicyVersion: 2 }), evidencePolicyVersion: 2, kind: 'text', unavailable: false }));
  const after = structuredClone(before);
  after.missions.push({ id: 'mission', thread_id: 'thread', lifecycle: 'closed', intent: 'report_only' });
  after.tasks.push({ id: 'task', mission_id: 'mission', spec: { kind: 'report' } });
  after.items.push({ id: 'report-item', deleted_at: null });
  const sources = selection.map((ref, index) => ({ sourceType: ref.type, sourceId: ref.id, reportedOutcome: index === 0 ? 'partial' : index === 1 ? 'achieved' : 'unknown', evidence: [evidence[index]] }));
  after.reports.push({ id: 'report', mission_id: 'mission', status: 'completed', item_id: 'report-item', input: { config: { target: null }, tasks: [{ sources }] },
    read_receipts: evidence.map(ref => ({ id: ref.id, version: ref.version, hash: ref.hash, digest: ref.provenance.sha256 ?? ref.hash, readAt: '2026-10-06T00:02:00Z', limited: false })),
    document: { partial: false, evidence: evidence.map(ref => ({ id: ref.id, itemId: ref.itemId, version: ref.version, read: true })),
      findings: [{ verdict: 'supported', observations: [{ text: 'The note asserts the flow works; it does not independently establish that assertion.', evidenceIds: ['item:note'], originLabel: 'Agentpåstående; inte oberoende verifiering' }] }] },
  });
  return { before, after, trial: { selection }, manifest: { protocol: v3, taskId: 'REP-07', variant: 'normal' } };
}
const audit = f => auditEvidenceCompletion(f.manifest, f.trial, f.before, f.after, 'thread');

test('v3 summary has full exact reads and visible claim provenance but never grants the semantic or overall gate', () => {
  const f = fixture(), before = JSON.stringify(f), result = audit(f);
  assert.equal(result.conclusionProfile, 'summary_with_disclosed_uncertainty'); assert.equal(result.summaryReads.length, 3);
  assert.deepEqual(result.summaryReads.map(read => read.origin), ['tool', 'tool', 'agent']);
  assert.equal(result.semanticProse, 'pending'); assert.match(result.semanticRequirement, /Independent byte\/prose review/);
  assert.equal(result.gate, undefined); assert.equal(result.automatedGate, undefined); assert.equal(JSON.stringify(f), before);
});

test('old v1/v2 failure and prompt bytes stay unchanged; v3 has the same natural prompt as v2', () => {
  const f = fixture(); assert.equal(EVIDENCE_PROTOCOL, v3);
  for (const protocol of [v1, v2]) { f.manifest.protocol = protocol; assert.throws(() => audit(f), /partial report/); }
  const v2Prompt = evidencePrompt({ ...f.manifest, protocol: v2 }, f.trial);
  assert.equal(evidencePrompt({ ...f.manifest, protocol: v3 }, f.trial), v2Prompt);
  assert.match(v2Prompt, /spara en rapport/); assert.doesNotMatch(v2Prompt, /supported|needs_evidence|sourceId|report_only/);
  assert.notEqual(evidencePrompt({ ...f.manifest, protocol: v1 }, f.trial), v2Prompt);
});

test('REP05, REP06, GAP report-only and fault protocols retain their original incomplete-scope checks', () => {
  for (const [taskId, variant, protocol] of [['REP-05', 'normal', v3], ['REP-06', 'normal', v3], ['GAP-13', 'report-only', v3], ['REP-07', 'wrong-run-provenance', 'syna-report-fault-acceptance-v2']]) {
    const f = fixture(); f.manifest = { taskId, variant, protocol };
    assert.equal(evidenceConclusionProfile(f.manifest), 'incomplete_original_scope'); assert.throws(() => audit(f), /partial report/);
    f.after.reports[0].document.partial = true; assert.throws(() => audit(f), /Missing evidence/);
    f.after.reports[0].document.findings[0].verdict = 'needs_evidence'; assert.equal(audit(f).semanticProse, 'pending');
  }
});

test('a missing, limited, unavailable, duplicate or wrong-version/digest read cannot pass the summary profile', () => {
  const changes = [
    f => f.after.reports[0].read_receipts.pop(),
    f => { f.after.reports[0].read_receipts[2].limited = true; },
    f => { f.after.reports[0].read_receipts[2].unavailable = true; },
    f => { f.after.reports[0].read_receipts[2].version = 2; },
    f => { f.after.reports[0].read_receipts[2].digest = 'f'.repeat(64); },
    f => { f.after.reports[0].read_receipts[2].hash = 'f'.repeat(64); },
    f => f.after.reports[0].read_receipts.push({ ...f.after.reports[0].read_receipts[2] }),
    f => { f.after.reports[0].document.evidence[2].read = false; },
  ];
  for (const change of changes) { const f = fixture(); change(f); assert.throws(() => audit(f), /full exact original read/); }
});

test('promoted agent origin, wrong-run proof and absent visible origin labels are rejected', () => {
  for (const change of [
    f => { f.after.reports[0].input.tasks[0].sources[2].evidence[0].origin = 'tool'; },
    f => { f.after.reports[0].input.tasks[0].sources[2].evidence[0].provenance = { ...f.after.reports[0].input.tasks[0].sources[2].evidence[0].provenance, origin: 'tool', producer: 'research-page' }; },
    f => { f.after.reports[0].input.tasks[0].sources[0].evidence[0].provenance = { ...f.after.reports[0].input.tasks[0].sources[0].evidence[0].provenance, sourceId: 'direct' }; },
    f => { f.after.reports[0].document.findings[0].observations[0].originLabel = 'Läst oberoende verktygsunderlag'; },
    f => { f.after.reports[0].document.findings[0].observations = []; },
  ]) { const f = fixture(); change(f); assert.throws(() => audit(f)); }
});

test('exact selected sources, original negative outcome and no new execution stay mandatory', () => {
  for (const change of [
    f => f.after.reports[0].input.tasks[0].sources.pop(),
    f => { f.after.reports[0].input.tasks[0].sources[0].sourceId = 'newer'; },
    f => { f.after.runs[0].result.outcome = 'passed'; },
    f => { f.after.reports[0].input.tasks[0].sources[0].reportedOutcome = 'achieved'; },
    f => f.after.jobs.push({ id: 'new-job' }),
    f => f.after.claims.push({ id: 'claim', mission_id: 'mission' }),
  ]) { const f = fixture(); change(f); assert.throws(() => audit(f)); }
});

test('a model-authored false inference never becomes an oracle semantic approval', () => {
  const f = fixture(); f.after.reports[0].document.findings[0].verdict = 'contradicted';
  f.after.reports[0].document.findings[0].observations[0].text = 'No verification happened, therefore the claimed product cannot work.';
  const result = audit(f); assert.equal(result.semanticProse, 'pending'); assert.equal(result.gate, undefined);
  assert.match(result.semanticRequirement, /unverified login/);
});
