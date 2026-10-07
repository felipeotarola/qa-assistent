import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as vue from 'vue';
import { parse, compileScript } from 'vue/compiler-sfc';
import { renderToString } from 'vue/server-renderer';
import { assessmentLabels, REVIEWER_VERSION } from '../shared/result-assessment.ts';
import { qualityLabels } from '../shared/quality.ts';
import { missionReportOutput } from '../shared/mission-report-output.ts';
import { missionReportWriterContext } from '../shared/mission-report-context.ts';
import { validateReport, assembleReport, reportText, reportObservationText, MISSION_REPORT_VERSION, hasCurrentReportPolicy } from '../shared/mission-report.ts';
import { sharedReportDocument, safeReportUrl } from '../shared/report-sharing.ts';
import { DELIVERY_POLICY_VERSION } from '../shared/mission-delivery.ts';
import { writeMissionReport } from '../agent/lib/mission-reporter.ts';
// Synthetic legacy test descriptions map to the current model wire only.
// These fixtures test contracts; they do not certify a real model's semantics.
const partsRow = ({ relation, text, evidenceIds, ...identity }) => ({ ...identity, text, coverage: 'complete', parts: [{ text, evidenceIds, relation, basis: 'other' }] });


function fixture() {
  const text = 'The Update action was performed; the displayed status remained Pending instead of becoming Complete.';
  const digest = createHash('sha256').update(text).digest('hex');
  const target = { environment: 'isolated unit', url: 'https://unit.example.test/', revision: 'fixed' };
  const source = { schemaVersion: 2, sourceType: 'test', sourceId: 'saved-run', sourceRevision: 'source-version', attemptId: 'saved-run', status: 'completed', target,
    startedAt: '2026-10-06T00:00:00Z', finishedAt: '2026-10-06T00:01:00Z',
    claims: [{ id: 'step-1', requirement: 'Click Update; status becomes Complete.', reportedStatus: 'mismatch', reportedActual: text }],
    evidence: [{ id: 'proof', kind: 'text', title: 'Saved action', hash: digest, origin: 'tool', evidencePolicyVersion: 2,
      observedAt: '2026-10-06T00:00:30Z', provenance: { version: 1, origin: 'tool', producer: 'browser-action', sourceType: 'test', sourceId: 'saved-run', observedAt: '2026-10-06T00:00:30Z', sha256: digest } }],
  };
  const snapshot = { schemaVersion: 2, missionId: 'mission', workspaceId: 'workspace', revision: 4, inputFingerprint: 'immutable-input',
    config: { title: 'Saved QA', goal: 'Summarize the saved action results.', scope: 'No new execution', target, caseKeys: [], criteria: [{ id: 'c', text: 'Review the exact saved result and state what it establishes.', delivery: { kind: 'source', sourceTypes: ['test'], sourceRefs: [{ type: 'test', id: 'saved-run' }] } }] },
    tasks: [{ id: 'task', title: 'Review saved result', actor: 'main', parentId: null, dependsOn: [], criterionIds: ['c'], sources: [source] }],
    delivery: { schemaVersion: DELIVERY_POLICY_VERSION, complete: true, criteria: [{ criterionId: 'c', complete: true, gaps: [] }], cases: [], gaps: [] },
    tests: [{ key: 'source:saved-run', runId: 'saved-run', originalOutcome: 'failed', status: 'failed' }], metrics: [], gaps: [],
  };
  return { snapshot, source, reads: new Map([['proof', { id: 'proof', text, digest }]]) };
}
async function invoke(f, output) {
  const previousFetch = globalThis.fetch, previousKey = process.env.GRUNDEN_API_TOKEN, previousPacing = process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS;
  process.env.GRUNDEN_API_TOKEN = 'synthetic-report-judgement-key'; process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS = '0';
  const requests = [], readIds = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.grunden.ai/v1/chat/completions'); requests.push(JSON.parse(options.body));
    assert.equal(requests.length, 1, 'Only one synthetic transport call, no real network or provider retry');
    return new Response(JSON.stringify({ id: 'synthetic', created: 0, model: 'fixture', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 9 } }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await writeMissionReport(f.snapshot, async id => { readIds.push(id); assert.ok(f.reads.has(id)); return f.reads.get(id); }, AbortSignal.timeout(5000));
    return { result, requests, readIds };
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of [['GRUNDEN_API_TOKEN', previousKey], ['GRUNDEN_MIN_REQUEST_INTERVAL_MS', previousPacing]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
}

const reference = f => missionReportWriterContext(f.snapshot, new Set(f.reads.keys())).sources[0].checkRefs['step-1'];
const wire = (f, relation = 'supports', verdict = 'supported', text = f.reads.get('proof').text) => ({ checkAssessments: [partsRow({ checkRef: reference(f), relation, text, evidenceIds: ['proof'] })], findings: [{ criterionId: 'c', verdict, factualNotes: [] }] });

test('the exact source, version, attempt and original check bind a reference; input remains immutable', () => {
  const f = fixture(), before = structuredClone(f.snapshot), ref = reference(f);
  assert.deepEqual(JSON.parse(ref), ['test', 'saved-run', 'source-version', 'saved-run', 'step-1']);
  const context = missionReportWriterContext(f.snapshot, new Set(f.reads.keys()));
  assert.deepEqual(context.sources[0].reportedClaims.items, f.source.claims);
  const original = missionReportOutput(f.snapshot, f.reads);
  for (const mutation of [
    g => { g.source.sourceId = 'other-run'; },
    g => { g.source.sourceRevision = 'other-version'; },
    g => { g.source.attemptId = 'other-attempt'; },
    g => { g.source.claims[0].id = 'other-check'; },
  ]) {
    const g = fixture(); mutation(g);
    const altered = wire(f); altered.checkAssessments[0].checkRef = reference(g);
    assert.equal(original.schema.safeParse(altered).success, false);
  }
  assert.deepEqual(f.snapshot, before);
});

test('even under one criterion, check assessments cannot borrow another source or an unread citation', () => {
  const f = fixture(), second = structuredClone(f.source);
  second.sourceId = 'other-run'; second.sourceRevision = 'other-version'; second.attemptId = 'other-run';
  second.evidence[0] = { ...second.evidence[0], id: 'other-proof', provenance: { ...second.evidence[0].provenance, sourceId: 'other-run' } };
  f.snapshot.tasks[0].sources.push(second);
  f.reads.set('other-proof', { ...f.reads.get('proof'), id: 'other-proof' });
  const output = missionReportOutput(f.snapshot, f.reads);
  for (const id of ['other-proof', 'unread']) {
    const invalid = wire(f); invalid.checkAssessments[0].parts[0].evidenceIds = [id];
    assert.equal(output.schema.safeParse(invalid).success, false);
    assert.throws(() => output.toDraft(invalid));
    const forged = output.toDraft(wire(f));
    forged.findings[0].evidenceIds = [id]; forged.findings[0].observations[0].evidenceIds = [id];
    assert.throws(() => validateReport(f.snapshot, forged, new Set(f.reads.keys()), f.reads));
  }
  assert.doesNotThrow(() => output.toDraft(wire(f)));
});

test('a source check is not transferred to another criterion by citing its still-readable bytes', () => {
  const f = fixture();
  f.snapshot.config.criteria.push({ id: 'other', text: 'Other scope', delivery: { kind: 'source', sourceTypes: ['material'] } });
  const output = missionReportOutput(f.snapshot, f.reads), value = wire(f);
  value.findings.push({ ...value.findings[0], criterionId: 'other', verdict: 'needs_evidence' });
  assert.equal(output.schema.safeParse(value).success, false);
});

test('the adapter retains a typed subject and assembly inserts the unchanged original requirement', () => {
  const f = fixture(), output = missionReportOutput(f.snapshot, f.reads), value = wire(f);
  const draft = output.toDraft(value);
  assert.deepEqual(Object.keys(draft.findings[0].observations[0]).sort(), ['evidenceIds', 'subject', 'text']);
  assert.deepEqual(draft.findings[0].observations[0].subject, { checkRef: reference(f), relation: 'supports' });
  assert.equal(draft.findings[0].observations[0].text, f.reads.get('proof').text);
  const valid = validateReport(f.snapshot, draft, new Set(f.reads.keys()), f.reads);
  const document = assembleReport(f.snapshot, valid, new Set(f.reads.keys()), f.reads);
  assert.equal(document.partial, false);
  assert.equal(document.tests[0].status, 'failed');
  assert.equal(document.tests[0].originalOutcome, 'failed');
  assert.ok(reportText(document).includes(f.source.claims[0].requirement));
  assert.ok(reportText(document).includes('Pending'));
  assert.deepEqual(document.findings[0].observations[0].subject, { requirement: f.source.claims[0].requirement, relation: 'supports' });
  assert.equal(document.findings[0].observations[0].subject.checkRef, undefined);
});

test('unsupported source text is not promoted by a supports relation and a genuine contrary observation is not silently rewritten', () => {
  const f = fixture();
  const contrary = missionReportOutput(f.snapshot, f.reads).toDraft(wire(f, 'contradicts', 'contradicted'));
  assert.equal(validateReport(f.snapshot, contrary, new Set(f.reads.keys()), f.reads).findings[0].verdict, 'contradicted');
  f.source.evidence[0].origin = 'agent'; f.source.evidence[0].provenance.origin = 'agent';
  const restricted = missionReportOutput(f.snapshot, f.reads);
  assert.deepEqual(restricted.criteria[0].allowedVerdicts, ['needs_evidence']);
  assert.equal(restricted.schema.safeParse(wire(f)).success, false);
  for (const relation of ['supports', 'contradicts']) {
    assert.equal(restricted.schema.safeParse(wire(f, relation, 'needs_evidence')).success, false);
    const forged = restricted.toDraft(wire(f, 'unresolved', 'needs_evidence'));
    forged.findings[0].observations[0].subject.relation = relation;
    assert.throws(() => validateReport(f.snapshot, forged, new Set(f.reads.keys()), f.reads), /independent evidence/);
  }
  const needs = restricted.toDraft(wire(f, 'unresolved', 'needs_evidence'));
  assert.equal(assembleReport(f.snapshot, validateReport(f.snapshot, needs, new Set(f.reads.keys()), f.reads), new Set(f.reads.keys()), f.reads).partial, true);
});

test('explicit attribute requirements and unknown action element remain separate original subjects, never automatically satisfied', () => {
  for (const requirement of ['The href attribute equals /archive.', 'The named Home control was clicked.']) {
    const f = fixture(); f.source.claims[0].requirement = requirement;
    const value = wire(f, 'unresolved', 'needs_evidence', 'A click reached the saved destination; this record does not identify the clicked element or the attribute value.');
    const draft = missionReportOutput(f.snapshot, f.reads).toDraft(value);
    const document = assembleReport(f.snapshot, draft, new Set(f.reads.keys()), f.reads);
    const rendered = reportObservationText(document.findings[0].observations[0]);
    assert.ok(rendered.startsWith(`Originalkrav: ${requirement}\n`));
    assert.equal(draft.findings[0].verdict, 'needs_evidence');
    assert.ok(rendered.includes('inte fastställt'));
  }
});

test('ordinary material without checks keeps evidence-only observations and unchanged text, without fabricated check subjects', () => {
  const f = fixture(); delete f.source.claims;
  f.source.sourceType = 'material'; f.source.sourceId = 'note';
  f.source.evidence[0].origin = 'agent'; f.source.evidence[0].provenance.origin = 'agent';
  f.source.evidence[0].provenance.sourceType = 'material'; f.source.evidence[0].provenance.sourceId = 'note';
  f.snapshot.config.criteria[0].delivery = { kind: 'source', sourceTypes: ['material'], sourceRefs: [{ type: 'material', id: 'note' }] };
  const output = missionReportOutput(f.snapshot, f.reads);
  assert.deepEqual(output.criteria[0].checkRefs, []);
  const text = 'The note claims an href check; this is a quoted claim, not proof.';
  const value = { findings: [{ criterionId: 'c', verdict: 'needs_evidence', observations: [{ text, evidenceIds: ['proof'] }] }] };
  assert.equal(output.toDraft(value).findings[0].observations[0].text, text);
  assert.equal(output.schema.safeParse({ findings: [{ ...value.findings[0], observations: [{ ...value.findings[0].observations[0], checkRef: 'invented', relation: 'supports' }] }] }).success, false);
});

test('conflicting frozen requirement, actual, status, target or evidence metadata fail closed', () => {
  for (const change of [
    source => { source.claims[0].requirement = 'Different'; },
    source => { source.claims[0].reportedActual = 'Different'; },
    source => { source.claims[0].reportedStatus = 'verified'; },
    source => { source.target.revision = 'different'; },
    source => { source.evidence[0].hash = 'different'; },
  ]) {
    const f = fixture(), conflict = structuredClone(f.source); change(conflict);
    f.snapshot.tasks[0].sources.push(conflict);
    assert.throws(() => missionReportOutput(f.snapshot, f.reads), /Conflicting report check identity/);
  }
  const f = fixture(); f.source.claims.push({ ...f.source.claims[0], reportedStatus: 'verified' });
  assert.throws(() => missionReportOutput(f.snapshot, f.reads), /Conflicting report check identity/);
});

test('a long original requirement plus the full existing 240-character observation remains usable and exact', () => {
  const f = fixture(); f.source.claims[0].requirement = 'Original long requirement. '.repeat(250);
  const original = structuredClone(f.snapshot), text = 'x'.repeat(240);
  const output = missionReportOutput(f.snapshot, f.reads), draft = output.toDraft(wire(f, 'supports', 'supported', text));
  const document = assembleReport(f.snapshot, validateReport(f.snapshot, draft, new Set(f.reads.keys()), f.reads), new Set(f.reads.keys()), f.reads);
  assert.equal(document.partial, false);
  assert.equal(document.findings[0].observations[0].subject.requirement, f.source.claims[0].requirement);
  assert.equal(document.findings[0].observations[0].text.length, 240);
  assert.ok(reportText(document).includes(f.source.claims[0].requirement));
  assert.deepEqual(f.snapshot, original);
  assert.equal(output.schema.safeParse(wire(f, 'supports', 'supported', 'x'.repeat(241))).success, false);
});

test('backend rejects forged or replaced subjects, wrong scope and read-ID-only metadata', () => {
  const f = fixture(), draft = missionReportOutput(f.snapshot, f.reads).toDraft(wire(f));
  for (const change of [
    subject => { subject.checkRef = 'wrong-source'; },
    subject => { subject.requirement = 'Forged requirement'; },
    subject => { subject.reportedActual = 'Forged claim'; },
    subject => { subject.relation = 'supported'; },
  ]) {
    const invalid = structuredClone(draft); change(invalid.findings[0].observations[0].subject);
    assert.throws(() => validateReport(f.snapshot, invalid, new Set(f.reads.keys()), f.reads));
    assert.throws(() => assembleReport(f.snapshot, invalid, new Set(f.reads.keys()), f.reads));
  }
  assert.throws(() => validateReport(f.snapshot, draft, new Set(f.reads.keys())), /fully read/);
  const limited = new Map([['proof', { ...f.reads.get('proof'), limited: true }]]);
  assert.throws(() => validateReport(f.snapshot, draft, new Set(f.reads.keys()), limited), /fully read/);
});

test('requirement redaction, shared allowlisting and old observation formatting remain consistent', () => {
  const f = fixture(); f.source.claims[0].requirement = 'Read <script> at http://127.0.0.1/private using secret-value.';
  const draft = missionReportOutput(f.snapshot, f.reads).toDraft(wire(f));
  const redacted = [];
  const document = assembleReport(f.snapshot, draft, new Set(f.reads.keys()), f.reads, value => {
    redacted.push(value); return value.replaceAll('secret-value', '[REDACTED]');
  });
  assert.deepEqual(redacted, [f.reads.get('proof').text, f.source.claims[0].requirement]);
  assert.ok(!JSON.stringify(document).includes('secret-value'));
  const publicSource = structuredClone(document);
  publicSource.findings[0].observations[0].subject.checkRef = 'private-check';
  publicSource.findings[0].observations[0].subject.privateClaim = 'private-payload';
  const publicDocument = sharedReportDocument(publicSource, ['proof']);
  assert.deepEqual(Object.keys(publicDocument.findings[0].observations[0].subject).sort(), ['relation', 'requirement']);
  assert.ok(!JSON.stringify(publicDocument).includes('private-check'));
  assert.ok(!JSON.stringify(publicDocument).includes('private-payload'));
  assert.ok(!reportText(publicDocument).includes('127.0.0.1'));
  assert.ok(reportText(publicDocument).includes('[REDACTED]'));
  const old = { text: 'Original observation <script>', evidenceIds: ['proof'], originLabel: 'Klara' };
  assert.equal(reportObservationText(old), old.text);
  document.findings[0].observations = [old];
  assert.equal(sharedReportDocument(document, []).findings[0].observations[0].subject, undefined);
});

test('provider schema requires exact assessment count, exact findings and no unsupported no-read result', () => {
  const f = fixture(), output = missionReportOutput(f.snapshot, f.reads), schema = z.toJSONSchema(output.schema);
  assert.ok(JSON.stringify(schema).length < 6000);
  const value = wire(f); value.checkAssessments = Array.from({ length: 9 }, () => value.checkAssessments[0]);
  assert.equal(output.schema.safeParse(value).success, false);
  f.reads.clear(); const empty = missionReportOutput(f.snapshot, f.reads);
  assert.deepEqual(empty.criteria[0].checkRefs, []);
  assert.ok(empty.schema.safeParse({ checkAssessments: [], findings: [{ criterionId: 'c', verdict: 'needs_evidence', factualNotes: [] }] }).success);
  assert.equal(empty.schema.safeParse({ checkAssessments: [], findings: [{ criterionId: 'c', verdict: 'supported', factualNotes: [] }] }).success, false);
});

test('installed SDK sees exact references/full bytes and the adapter returns a complete supported negative report after one call', async () => {
  const f = fixture(), value = wire(f), { result, requests, readIds } = await invoke(f, value);
  assert.equal(requests.length, 1);
  const parts = requests[0].messages.at(-1).content.filter(p => p.type === 'text').map(p => p.text);
  const context = JSON.parse(parts[0]);
  assert.equal(context.sources[0].checkRefs['step-1'], reference(f));
  assert.deepEqual(context.findingConstraints[0].checkRefs, [reference(f)]);
  assert.ok(parts.some(part => { try { return JSON.parse(part).text === f.reads.get('proof').text; } catch { return false; } }));
  assert.equal(result.usage.provider.providerCalls, 1);
  assert.equal(result.usage.totalTokens, 39);
  assert.deepEqual(readIds, ['proof']);
  const report = assembleReport(f.snapshot, validateReport(f.snapshot, result.draft, new Set(readIds), f.reads), new Set(readIds), f.reads);
  assert.equal(report.partial, false);
  assert.equal(report.tests[0].originalOutcome, 'failed');
  assert.ok(reportObservationText(report.findings[0].observations[0]).includes('Originalkrav: Click Update;'));
});

test('installed SDK rejects an unknown check subject without retrying or discarding measured usage', async () => {
  const f = fixture(), invalid = wire(f); invalid.checkAssessments[0].checkRef = 'invented';
  let calls = 0, measured, readCount;
  const previousFetch = globalThis.fetch, previousKey = process.env.GRUNDEN_API_TOKEN, previousPacing = process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS;
  process.env.GRUNDEN_API_TOKEN = 'synthetic-check-subject'; process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS = '0';
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ id: 'synthetic', created: 0, model: 'fixture', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(invalid) }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 9 } }), { headers: { 'content-type': 'application/json' } }); };
  try {
    await assert.rejects(writeMissionReport(f.snapshot, async id => f.reads.get(id), AbortSignal.timeout(5000), { onUsage: (usage, reads) => { measured = usage; readCount = reads; } }));
    assert.equal(calls, 1); assert.equal(measured.providerCalls, 1); assert.equal(measured.totalTokens, 39); assert.equal(readCount, 1);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of [['GRUNDEN_API_TOKEN', previousKey], ['GRUNDEN_MIN_REQUEST_INTERVAL_MS', previousPacing]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('new check-subject contract rejects the old judgement cache while preserving evidence-policy versions', () => {
  const f = fixture(); assert.ok(MISSION_REPORT_VERSION.includes(':judgement-8:'));
  assert.ok(hasCurrentReportPolicy(MISSION_REPORT_VERSION, f.snapshot));
  assert.equal(hasCurrentReportPolicy(MISSION_REPORT_VERSION.replace(':judgement-8:', ':judgement-7:'), f.snapshot), false);
});


test('the existing report component renders the full subject safely and keeps old observations unchanged', async () => {
  const filename = new URL('../app/components/MissionReportDocument.vue', import.meta.url);
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname });
  const script = compileScript(descriptor, { id: 'report-check-subject', inlineTemplate: true });
  const code = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const dependencies = {
    '#shared/mission-report': { reportObservationText },
    '#shared/result-assessment': { assessmentLabels },
    '#shared/quality': { qualityLabels },
    '#shared/report-sharing': { safeReportUrl },
  };
  const exports = {};
  vm.runInNewContext(code, { exports, ...vue, require: name => {
    if (name === 'vue') return vue;
    if (name in dependencies) return dependencies[name];
    throw new Error('Unexpected component dependency: ' + name);
  } });
  const f = fixture(); f.source.claims[0].requirement = '<script>requirement</script> ' + 'Original '.repeat(350);
  const draft = missionReportOutput(f.snapshot, f.reads).toDraft(wire(f));
  const document = assembleReport(f.snapshot, draft, new Set(f.reads.keys()), f.reads);
  const render = async doc => {
    const app = vue.createSSRApp(exports.default, { document: doc });
    for (const name of ['UBadge', 'UButton', 'ClientOnly', 'WorkspaceDiagram', 'WorkspaceChart']) app.component(name, { setup() { return () => null; } });
    return renderToString(app);
  };
  const html = await render(document);
  assert.ok(html.includes('Originalkrav: &lt;script&gt;requirement&lt;/script&gt; ' + 'Original '.repeat(350)));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('Klaras bedömning av utförarens rapportering'));
  assert.ok(html.includes('Pending'));
  assert.ok(!html.includes(reference(f)));
  const old = structuredClone(document); delete old.findings[0].observations[0].subject;
  const oldHtml = await render(old);
  assert.ok(oldHtml.includes(f.reads.get('proof').text));
  assert.ok(!oldHtml.includes('Originalkrav:'));
});


test('installed SDK accepts a legitimate long requirement without using the observation text budget for it', async () => {
  const f = fixture(); f.source.claims[0].requirement = 'Exact saved requirement. '.repeat(250);
  const { result, requests } = await invoke(f, wire(f));
  const context = JSON.parse(requests[0].messages.at(-1).content[0].text);
  assert.equal(context.sources[0].reportedClaims.items[0].requirement, f.source.claims[0].requirement);
  const document = assembleReport(f.snapshot, result.draft, new Set(f.reads.keys()), f.reads);
  assert.equal(document.findings[0].observations[0].subject.requirement, f.source.claims[0].requirement);
  assert.equal(result.usage.provider.providerCalls, 1);
  assert.equal(document.partial, false);
});

test('installed SDK receives no writable ref for a saved current review, still reads its proof once, and cannot replace the copied negative', async () => {
  const f = fixture(), runId = '20000000-0000-4000-8000-000000000001';
  f.source.sourceId = runId; f.source.attemptId = runId; f.source.sourceRevision = 'a'.repeat(64);
  f.source.evidence[0].provenance.sourceId = runId; f.snapshot.config.criteria[0].delivery.sourceRefs[0].id = runId;
  f.source.assessment = { id: '20000000-0000-4000-8000-000000000002', status: 'completed', finishedAt: '2026-10-06T00:02:00Z', stale: false, reviewerVersion: REVIEWER_VERSION,
    sourceHash: 'b'.repeat(64), inputHash: 'c'.repeat(64), summary: 'The negative result is substantiated.', verdict: 'supported',
    findings: [{ requirementId: 'step-1', verdict: 'supported', explanation: '<script>saved</script> The recorded action left Pending visible.', evidenceIds: ['proof'], suggestedNextStep: '', gap: null }] };
  const before = structuredClone(f.snapshot), value = wire(f); value.checkAssessments = [];
  const { result, requests, readIds } = await invoke(f, value), context = JSON.parse(requests[0].messages.at(-1).content[0].text);
  assert.deepEqual(context.requiredCheckRefs, []); assert.deepEqual(context.findingConstraints[0].checkRefs, []); assert.equal(context.savedChecks.length, 1);
  assert.equal(context.savedChecks[0].reportedStatus, 'mismatch'); assert.equal(context.savedChecks[0].verdict, 'supported');
  assert.deepEqual(readIds, ['proof']); assert.equal(result.usage.provider.providerCalls, 1); assert.equal(requests[0].model, 'glm-5.3');
  assert.equal(requests[0].max_tokens, 16000); assert.equal(requests[0].reasoning_effort, 'high');
  const document = assembleReport(f.snapshot, result.draft, new Set(readIds), f.reads, text => text.replaceAll('Pending', '[MASKED]'));
  const observation = document.findings[0].observations[0];
  assert.equal(observation.savedReview.reportedStatus, 'mismatch'); assert.ok(observation.savedReview.reportedActual.includes('[MASKED]'));
  assert.equal(observation.savedReview.finding.explanation, f.source.assessment.findings[0].explanation.replaceAll('Pending', '[MASKED]'));
  assert.ok(!reportObservationText(observation).includes('Läst observation')); assert.ok(reportText(document).includes('Sparad granskning'));
  assert.equal(sharedReportDocument(document, ['proof']).findings[0].observations[0].savedReview.binding, undefined);
  assert.deepEqual(f.snapshot, before);
  const wrong = wire(f, 'supports', 'supported', 'This is a different check claim.');
  await assert.rejects(invoke(f, wrong));
});
