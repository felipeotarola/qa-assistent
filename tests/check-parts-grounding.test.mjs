import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const load = path => import(pathToFileURL(resolve(path)).href);
const review = await load('shared/result-assessment.ts');
const { missionReportOutput } = await load('shared/mission-report-output.ts');
const { missionReportCheckRef } = await load('shared/mission-report-context.ts');
const { validateReport, assembleReport } = await load('shared/mission-report.ts');
const { DELIVERY_POLICY_VERSION } = await load('shared/mission-delivery.ts');
const { assessResult } = await load('agent/lib/result-reviewer.ts');
const { writeMissionReport } = await load('agent/lib/mission-reporter.ts');
const at = '2026-10-06T00:00:30Z';
const target = { url: 'https://unit.example.test/', revision: 'fixed', environment: 'isolated unit' };
function trace(action = 'click', toUrl = 'https://unit.example.test/second') {
  return { version: 1, browserJobId: 'job', callId: 'call', execution: { attemptId: 'attempt', dispatchId: 'dispatch' },
    action, startedAt: at, finishedAt: at, fromUrl: target.url, toUrl, httpStatus: 404, outcome: 'observed',
    observation: { linkObservation: { method: 'dom-css-visible-anchors', links: [{ label: 'First', href: target.url + 'first' }, { label: 'Second', href: target.url + 'second' }], truncated: false } },
    filledField: null };
}
function fixture(value = trace()) {
  const text = JSON.stringify(value), digest = createHash('sha256').update(text).digest('hex');
  const provenance = { version: 1, origin: 'tool', producer: 'browser-action', sourceType: 'test', sourceId: 'run', observedAt: at, sha256: digest };
  const evidence = { id: 'trace', itemId: 'item', version: 1, title: 'Observed action', kind: 'text', mime: 'application/json', size: text.length, blobPath: 'private-never-send',
    captureId: 'capture', runId: 'run', url: target.url, action: value.action, error: null, observedAt: at, sha256: digest, readStatus: 'read', evidencePolicyVersion: 2, origin: 'tool', provenance, hash: digest, unavailable: false };
  const source = { schemaVersion: 2, sourceType: 'test', sourceId: 'run', sourceRevision: 'frozen', attemptId: 'run', status: 'completed', target,
    startedAt: '2026-10-06T00:00:00Z', finishedAt: '2026-10-06T00:01:00Z',
    claims: [{ id: 'step-1', requirement: 'Both First and Second links are usable.', reportedStatus: 'verified', reportedActual: 'Both links were visible.' }], evidence: [evidence] };
  const snapshot = { schemaVersion: 2, missionId: 'mission', workspaceId: 'workspace', revision: 1,
    config: { title: 'Saved review', goal: 'Summarize exact saved results', scope: 'No execution', target, caseKeys: [], criteria: [{ id: 'c', text: 'Summarize the exact result.', delivery: { kind: 'source', sourceTypes: ['test'], sourceRefs: [{ type: 'test', id: 'run' }] } }] },
    tasks: [{ id: 'task', title: 'Saved QA', actor: 'main', criterionIds: ['c'], sources: [source] }],
    delivery: { schemaVersion: DELIVERY_POLICY_VERSION, complete: true, criteria: [{ criterionId: 'c', complete: true, gaps: [] }], cases: [], gaps: [] }, tests: [], metrics: [], gaps: [] };
  const input = { schemaVersion: 2, runId: 'run', workspaceId: 'workspace', planVersion: 1, startedAt: source.startedAt, finishedAt: source.finishedAt, target, environment: target.environment,
    requirements: [{ id: 'step-1', requirement: source.claims[0].requirement }], evidence: [evidence], ruleFindings: [],
    reportedResult: { outcome: 'passed', actual: source.claims[0].reportedActual, unverified: '', observations: [], evidenceItemIds: ['trace'], checks: [{ id: 'step-1', status: 'verified', actual: source.claims[0].reportedActual }] } };
  return { source, snapshot, input, evidence, text, reads: new Map([['trace', { id: 'trace', text, digest }]]) };
}
const part = (text, relation = 'supports', basis = 'state', evidenceIds = ['trace']) => ({ text, relation, basis, evidenceIds });
const missing = { kind: 'missing_observation', wantedEvidence: 'Observation of the remaining original property.', capability: 'review' };
const row = (parts, coverage = 'complete') => ({ parts, coverage });
function wire(f, assessment, text = assessment.parts?.map(part => part.text).join(' ') ?? assessment.text) { return { findings: [{ criterionId: 'c', verdict: 'needs_evidence', factualNotes: [] }], checkAssessments: [{ checkRef: missionReportCheckRef(f.source, 'step-1'), ...assessment, text }] }; }
function reviewWire(assessment, gap = null) { return { summary: 'Saved evidence reviewed.', findings: [{ requirementId: 'step-1', suggestedNextStep: '', gap, ...assessment }] }; }
const keyedReviewWire = (assessment, gap = null) => { const value = reviewWire(assessment, gap); return { ...value, findings: Object.fromEntries(value.findings.map(({ requirementId, ...finding }) => [requirementId, finding])) }; };
const map = (f, assessment, gap) => review.assessmentFromReportedChecks(reviewWire(assessment, gap), f.input.requirements, f.input);
async function helper() { return load('shared/review-observations.ts'); }
async function index(f) { const h = await helper(); f.input.readObservations = [h.readObservation(f.evidence, f.reads.get('trace'), 'run')].filter(Boolean); return f; }

test('flat reviewer support without cited subassessments is rejected', () => {
  const old = { summary: 'Visible links.', findings: [{ requirementId: 'step-1', reportRelation: 'substantiates_reported_check', explanation: 'Both links are visible.', evidenceIds: ['trace'], suggestedNextStep: '', gap: null }] };
  assert.equal(review.reportedCheckAssessmentSchema.safeParse(old).success, false);
});
test('flat writer support without cited subassessments is rejected', () => {
  const f = fixture(), value = wire(f, { relation: 'supports', text: 'Both links visible.', evidenceIds: ['trace'] });
  assert.equal(missionReportOutput(f.snapshot, f.reads).schema.safeParse(value).success, false);
});
test('two-link claim with one unresolved interaction cannot become whole support in either adapter', async () => {
  const f = await index(fixture()), parts = row([part('First action observed.', 'supports', 'performed_action'), part('Second interaction not established.', 'unresolved', 'performed_action')]);
  const reviewed = map(f, parts, missing);
  assert.equal(reviewed.verdict, 'needs_evidence');
  const draft = missionReportOutput(f.snapshot, f.reads).toDraft(wire(f, parts));
  assert.equal(draft.findings[0].observations[0].subject.relation, 'unresolved');
  validateReport(f.snapshot, draft, new Set(f.reads.keys()), f.reads);
  assert.equal(f.source.claims[0].requirement, 'Both First and Second links are usable.');
});
test('omission closes support; mixed contradictions stay visible; no phrase classifier changes a relation', async () => {
  const f = await index(fixture());
  assert.equal(map(f, row([part('One supported part.')], 'partial'), missing).verdict, 'needs_evidence');
  assert.equal(map(f, row([part('Visible content.'), part('Concrete contrary state.', 'contradicts')])).verdict, 'contradicted');
  assert.equal(map(f, row([part('The word failed is just text.')])).verdict, 'supported');
  assert.throws(() => map(f, row([part('Duplicate'), part('Duplicate')])), /Duplicate/);
});
test('page observation plus unknown access context remains unresolved and never implies public access', async () => {
  const f = await index(fixture(trace('open')));
  f.input.browserSessionContext = { version: 1, kind: 'human_returned_session', priorAuthentication: 'unknown' };
  f.source.claims[0].requirement = 'The page is publicly accessible without special access.';
  f.input.requirements[0].requirement = f.source.claims[0].requirement;
  const assessment = row([part('The page was observed.'), part('Access without prior authentication is not established.', 'unresolved')]);
  assert.equal(map(f, assessment, missing).verdict, 'needs_evidence');
  const output = missionReportOutput(f.snapshot, f.reads), draft = output.toDraft(wire(f, assessment));
  assert.equal(draft.findings[0].observations[0].subject.relation, 'unresolved');
  assert.equal(Object.hasOwn(output.readObservations[0], 'authentication'), false);
  assert.equal(Object.hasOwn(output.readObservations[0], 'publicAccess'), false);
  assert.equal(f.input.browserSessionContext.priorAuthentication, 'unknown');
});
test('screenshot/DOM state may support state, never a declared interaction or navigation', async () => {
  const f = fixture(trace('open')); f.evidence.mime = 'image/png'; f.evidence.provenance.producer = 'test-capture'; f.reads.set('trace', { id: 'trace', image: { data: 'cGl4ZWxz', mediaType: 'image/png' }, digest: f.evidence.sha256 });
  await index(f); assert.deepEqual(f.input.readObservations, []);
  assert.equal(map(f, row([part('Visible heading.')])).verdict, 'supported');
  for (const basis of ['performed_action', 'changed_destination']) {
    assert.throws(() => map(f, row([part('Claimed action.', 'supports', basis)])), /lacks a corresponding/);
    assert.equal(missionReportOutput(f.snapshot, f.reads).schema.safeParse(wire(f, row([part('Claimed action.', 'supports', basis)]))).success, false);
  }
});
test('direct open and click without changed destination are not link navigation; click itself is not inferred success', async () => {
  for (const action of ['open', 'click']) {
    const f = await index(fixture(trace(action, action === 'click' ? target.url : target.url + 'different')));
    assert.throws(() => map(f, row([part('Link navigated.', 'supports', 'changed_destination')])), /lacks a corresponding/);
    if (action === 'click') assert.equal(map(f, row([part('A click was observed; destination did not change.', 'supports', 'performed_action')])).verdict, 'supported');
    assert.equal(Object.hasOwn(f.input.readObservations[0], 'productSucceeded'), false);
  }
});
test('correctly reported 404 mismatch remains conclusive negative QA without a retest', async () => {
  const f = await index(fixture()); f.input.reportedResult.checks[0].status = 'mismatch'; f.input.reportedResult.outcome = 'failed';
  const assessment = map(f, row([part('Click destination responded 404.', 'supports', 'changed_destination')]));
  assert.equal(review.validateAssessment(f.input, assessment).verdict, 'supported');
  assert.deepEqual(review.reviewGaps({ reviewerVersion: review.REVIEWER_VERSION, assessment }), []);
  assert.equal(f.input.reportedResult.outcome, 'failed');
});
test('a failed action or unchanged destination may contradict a claimed successful navigation without replay', async () => {
  for (const value of [trace('click', target.url), { ...trace('click'), outcome: 'action_failed' }]) {
    const f = await index(fixture(value));
    const parts = row([part('The cited action record contradicts the claimed navigation.', 'contradicts', 'changed_destination')]);
    assert.equal(map(f, parts).verdict, 'contradicted');
    const draft = missionReportOutput(f.snapshot, f.reads).toDraft(wire(f, parts));
    assert.equal(draft.findings[0].observations[0].subject.relation, 'contradicts');
  }
});
test('truthfully reported failed action or unchanged URL supports negative QA through its own attempt/state observations', async () => {
  for (const value of [trace('click', target.url), { ...trace('click'), outcome: 'action_failed' }]) {
    const f = await index(fixture(value)); f.input.reportedResult.outcome = 'failed'; f.input.reportedResult.checks[0].status = 'mismatch';
    const parts = row([part('The own action was attempted.', 'supports', 'action_attempt'), part('The saved outcome matches the reported failure.')]);
    const result = map(f, parts);
    assert.equal(review.validateAssessment(f.input, result).verdict, 'supported');
    assert.deepEqual(review.reviewGaps({ reviewerVersion: review.REVIEWER_VERSION, assessment: result }), []);
    assert.equal(missionReportOutput(f.snapshot, f.reads).toDraft(wire(f, parts)).findings[0].observations[0].subject.relation, 'supports');
    const actual = await sdk(keyedReviewWire(parts), () => assessResult(f.input, [{ type: 'text', text: f.text }], AbortSignal.timeout(5000)));
    assert.equal(actual.calls, 1); assert.equal(actual.result.verdict, 'supported');
  }
});
test('direct URL response can support a direct URL requirement without inventing a click requirement', async () => {
  const f = await index(fixture(trace('open'))); f.input.requirements[0].requirement = 'Opening the specified URL returns HTTP 404.';
  const parts = row([part('The specified URL returned 404.', 'supports', 'state')]);
  assert.equal(map(f, parts).verdict, 'supported');
  assert.throws(() => map(f, row([part('A link changed the destination.', 'supports', 'changed_destination')])), /lacks a corresponding/);
});
test('index requires actual full digest-bound trusted own-run reads, not a metadata action or quoted JSON', async () => {
  const h = await helper();
  for (const mutate of [f => { f.reads.get('trace').digest = 'b'.repeat(64); }, f => { f.reads.get('trace').limited = true; }, f => { f.reads.get('trace').unavailable = true; },
    f => { f.evidence.provenance.sourceId = 'other'; }, f => { f.evidence.provenance.producer = 'agent-authored'; f.evidence.provenance.origin = 'agent'; },
    f => { f.reads.get('trace').text = 'Agent says click succeeded'; }, f => { f.evidence.evidencePolicyVersion = 1; }]) {
    const f = fixture(); mutate(f); assert.equal(h.readObservation(f.evidence, f.reads.get('trace'), 'run'), null);
  }
  const f = fixture(); const observation = h.readObservation(f.evidence, f.reads.get('trace'), 'run');
  assert.deepEqual(observation.domLinks.map(x => x.label), ['First', 'Second']); assert.equal(observation.httpStatus, 404);
  assert.equal(Object.hasOwn(observation, 'success'), false);
});
test('wrong-run citations cannot be borrowed; every conclusive part needs its own applicable citation', async () => {
  const f = await index(fixture());
  assert.throws(() => map(f, row([part('Other run.', 'supports', 'performed_action', ['foreign'])])), /foreign/);
  assert.throws(() => map(f, row([part('First cited.'), part('Uncited second.', 'supports', 'state', [])])), /independent/);
  f.evidence.runId = 'other'; assert.throws(() => map(f, row([part('Own run?')])), /independent/);
});
test('source-local report index excludes a foreign run and deduplicates shared criteria without merging its facts', () => {
  const f = fixture(), foreign = structuredClone(f.source); foreign.sourceId = 'other'; foreign.evidence[0].id = 'foreign'; foreign.evidence[0].provenance.sourceId = 'other';
  f.snapshot.tasks[0].sources.push(foreign); f.reads.set('foreign', { ...f.reads.get('trace'), id: 'foreign' });
  const output = missionReportOutput(f.snapshot, f.reads); assert.deepEqual(output.readObservations.map(x => x.runId), ['run']);
  assert.equal(output.schema.safeParse(wire(f, row([part('Other click.', 'supports', 'performed_action', ['foreign'])]))).success, false);
});
test('parts keep existing text capacity and immutable original long requirement, and historical stored assessments remain readable', () => {
  const f = fixture(); f.source.claims[0].requirement = 'Original '.repeat(800);
  const value = wire(f, row([part('Read observation.')])), output = missionReportOutput(f.snapshot, f.reads), draft = output.toDraft(value);
  const document = assembleReport(f.snapshot, validateReport(f.snapshot, draft, new Set(f.reads.keys()), f.reads), new Set(f.reads.keys()), f.reads);
  assert.equal(document.findings[0].observations[0].subject.requirement, f.source.claims[0].requirement);
  assert.equal(output.schema.safeParse(wire(f, row([part('x'.repeat(200)), part('y'.repeat(100))]))).success, false);
  const old = { verdict: 'supported', summary: 'Historical.', findings: [{ requirementId: 'step-1', verdict: 'supported', explanation: 'Old prose', evidenceIds: ['trace'], suggestedNextStep: '' }] };
  assert.deepEqual(review.assessmentSchema.parse(old), old);
});
test('observation-only material remains readable and has no synthetic check parts', () => {
  const f = fixture(); f.source.claims = []; const output = missionReportOutput(f.snapshot, f.reads);
  const value = { findings: [{ criterionId: 'c', verdict: 'needs_evidence', observations: [{ text: 'Source describes an observation.', evidenceIds: ['trace'] }] }] };
  assert.equal(output.toDraft(value).findings[0].observations.length, 1); assert.equal(Object.hasOwn(output.toDraft(value).findings[0].observations[0], 'subject'), false);
});
async function sdk(output, action) {
  const previousFetch = globalThis.fetch, previousKey = process.env.GRUNDEN_API_TOKEN; let calls = 0, request;
  process.env.GRUNDEN_API_TOKEN = 'synthetic';
  globalThis.fetch = async (_url, init) => { calls++; request = JSON.parse(init.body); return new Response(JSON.stringify({ id: 'synthetic', created: 0, model: 'fixture', object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } }), { headers: { 'content-type': 'application/json' } }); };
  try { return { result: await action(), calls, request }; } finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.GRUNDEN_API_TOKEN; else process.env.GRUNDEN_API_TOKEN = previousKey; }
}
test('actual reviewer SDK has one fixed-budget request with read observations + original tuple and maps parts to legacy draft', async () => {
  const f = await index(fixture()), assessment = row([part('First visible.'), part('Second usability unknown.', 'unresolved', 'performed_action')]); let usage;
  const actual = await sdk(keyedReviewWire(assessment, missing), () => assessResult(f.input, [{ type: 'text', text: f.text }], AbortSignal.timeout(5000), (_t, value) => { usage = value; }));
  assert.match(JSON.stringify(actual.request.response_format), /One original subclaim, retaining its material property or qualifier/);
  assert.match(JSON.stringify(actual.request.messages), /Behåll originalkravets betydelsebärande egenskaper och kvalificeringar/);
  assert.equal(actual.calls, 1); assert.equal(usage.providerCalls, 1); assert.equal(actual.request.model, 'glm-5.3'); assert.equal(actual.request.max_tokens, 8000); assert.equal(actual.request.reasoning_effort, 'high');
  const input = JSON.parse(actual.request.messages.at(-1).content[0].text); assert.equal(input.requirements[0].requirement, f.source.claims[0].requirement); assert.deepEqual(input.readObservations, f.input.readObservations);
  assert.equal(actual.result.findings[0].verdict, 'needs_evidence'); assert.equal(Object.hasOwn(actual.result.findings[0], 'parts'), false);
});
test('actual writer SDK has one call, source-local index and version-bound 16000-token cap; parts project to saved subject', async () => {
  const f = fixture(), value = wire(f, row([part('Visible links.'), part('Both interactions are not established.', 'unresolved', 'performed_action')]));
  const before = structuredClone(f.snapshot), readIds = []; let admissions = 0;
  const actual = await sdk(value, () => writeMissionReport(f.snapshot, async id => { readIds.push(id); return f.reads.get(id); }, AbortSignal.timeout(5000), { maxTokens: 100000, beforeModel: async () => { admissions++; } }));
  assert.deepEqual(readIds, ['trace']); assert.equal(admissions, 2); assert.deepEqual(f.snapshot, before);
  assert.match(JSON.stringify(actual.request.response_format), /One original subclaim, retaining its material property or qualifier/);
  assert.match(JSON.stringify(actual.request.messages), /Behåll originalkravets betydelsebärande egenskaper och kvalificeringar/);
  assert.equal(actual.calls, 1); assert.equal(actual.result.usage.provider.providerCalls, 1); assert.equal(actual.request.max_tokens, 16000); assert.equal(actual.request.model, 'glm-5.3'); assert.equal(actual.request.reasoning_effort, 'high');
  const input = JSON.parse(actual.request.messages.at(-1).content[0].text); assert.equal(input.readObservations[0].runId, 'run');
  assert.equal(actual.result.draft.findings[0].observations[0].subject.relation, 'unresolved');
});
test('capacity fails closed before any provider rather than truncating the observation index', async () => {
  const h = await helper(), f = await index(fixture()), original = structuredClone(f.input.readObservations);
  assert.throws(() => h.boundedObservationIndex(Array.from({ length: 10000 }, (_, i) => ({ ...original[0], evidenceId: String(i) }))), /bounded context/);
  assert.deepEqual(f.input.readObservations, original);
  const huge = fixture(); huge.source.claims = Array.from({ length: 33 }, (_, i) => ({ ...huge.source.claims[0], id: 'step-' + i }));
  const actual = await sdk({}, () => writeMissionReport(huge.snapshot, async id => huge.reads.get(id), AbortSignal.timeout(5000)));
  assert.equal(actual.calls, 0); assert.equal(actual.result.usage.provider.providerCalls, 0); assert.equal(actual.result.draft.findings[0].verdict, 'needs_evidence');
});


test('writer summary has native maxLength 240, retains longer parts and rejects missing or oversized stored text', async () => {
  const f = fixture(), details = row([part('a'.repeat(132)), part('b'.repeat(133), 'unresolved')]);
  assert.equal(details.parts.map(part => part.text).join(' ').length, 266, 'Reproduce the actual rejected total');
  const good = wire(f, details, 's'.repeat(240));
  const output = missionReportOutput(f.snapshot, f.reads);
  assert.equal(output.toDraft(good).findings[0].observations[0].text.length, 240);
  assert.equal(output.toDraft(good).findings[0].observations[0].subject.relation, 'unresolved');
  assert.deepEqual(good.checkAssessments[0].parts, details.parts, 'No truncation or dropped part');
  const actual = await sdk(good, () => writeMissionReport(f.snapshot, async id => f.reads.get(id), AbortSignal.timeout(5000)));
  assert.equal(actual.calls, 1);
  const input = JSON.parse(actual.request.messages.at(-1).content[0].text);
  assert.equal(input.checkTextBudget, 240);
  assert.equal(input.factualTextBudget, 4000);
  const rows = actual.request.response_format.json_schema.schema.properties.checkAssessments;
  assert.equal(rows.items.properties.text.maxLength, 240);
  assert.equal(rows.items.properties.text.minLength, 1);
  assert.ok(rows.items.required.includes('text'));
  assert.equal(rows.items.additionalProperties, false);
  assert.match(rows.description, /stored text summary of at most 240/);
  assert.match(rows.description, /4000/);
  assert.match(JSON.stringify(actual.request.messages), /trogen kort sammanfattning av samtliga delbedömningar/);
  assert.doesNotMatch(JSON.stringify(actual.request.messages), /Alla parts\[\]\.text för en kontrollpunkt/);
  assert.equal(actual.request.max_tokens, 16000);
  assert.equal(actual.request.model, 'glm-5.3');
  assert.equal(actual.request.reasoning_effort, 'high');
  assert.equal(actual.result.draft.findings[0].observations[0].text, 's'.repeat(240));
  const tooLong = wire(f, details, 's'.repeat(241));
  assert.equal(output.schema.safeParse(tooLong).success, false);
  await assert.rejects(sdk(tooLong, () => writeMissionReport(f.snapshot, async id => f.reads.get(id), AbortSignal.timeout(5000))));
  const missingText = structuredClone(good); delete missingText.checkAssessments[0].text;
  assert.equal(output.schema.safeParse(missingText).success, false);
  assert.equal(output.schema.safeParse(wire(f, details, '')).success, false);
  assert.equal(output.schema.safeParse(wire(f, row([part('a'.repeat(241))]), 'Short.')).success, false, 'Existing per-part bound stays');
});

test('writer summary cannot override parts relation, borrow citations or drop a second part from the saved evidence union', () => {
  const f = fixture(), second = structuredClone(f.evidence); second.id = 'trace-2';
  f.source.evidence.push(second); f.reads.set(second.id, { ...f.reads.get('trace'), id: second.id });
  const output = missionReportOutput(f.snapshot, f.reads);
  for (const relation of ['unresolved', 'contradicts']) {
    const value = wire(f, row([part('Observed state.'), part('Remaining property.', relation, 'state', ['trace-2'])]), 'Concise summary.');
    const observation = output.toDraft(value).findings[0].observations[0];
    assert.equal(observation.subject.relation, relation);
    assert.deepEqual(observation.evidenceIds, ['trace', 'trace-2']);
    assert.equal(observation.text, 'Concise summary.');
    const forged = structuredClone(value); forged.checkAssessments[0].relation = 'supports';
    assert.equal(output.schema.safeParse(forged).success, false);
    const foreign = structuredClone(value); foreign.checkAssessments[0].parts[1].evidenceIds = ['foreign'];
    assert.equal(output.schema.safeParse(foreign).success, false);
  }
  const partial = output.toDraft(wire(f, row([part('One observed property.')], 'partial'), 'Summary remains partial.'));
  assert.equal(partial.findings[0].observations[0].subject.relation, 'unresolved');
});
