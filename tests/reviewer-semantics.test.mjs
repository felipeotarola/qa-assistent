import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { reportedCheckAssessmentSchema, assessmentFromReportedChecks, assessmentSchema, validateAssessment, reviewGaps, REVIEWER_VERSION, REVIEW_HASH_VERSION } from '../shared/result-assessment.ts';

import * as reviewSchema from '../shared/result-assessment.ts';
const { reportedCheckAssessmentSchemaFor, assessmentFromKeyedChecks } = reviewSchema;

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { assessResult } = await import('../agent/lib/result-reviewer.ts');
hooks.deregister();

const source = () => ({ schemaVersion: 2, runId: 'run', workspaceId: 'workspace', planVersion: 1,
  startedAt: '2026-10-06T10:00:00Z', finishedAt: '2026-10-06T10:01:00Z', environment: 'test',
  target: { url: 'https://fixture.test/', revision: 'fixture', environment: 'test' },
  requirements: [{ id: 'step-1', requirement: 'Navigation opens the returns page.' }],
  reportedResult: { outcome: 'failed', actual: 'Click opened HTTP 404.', unverified: '', observations: [], evidenceItemIds: ['trace'],
    checks: [{ id: 'step-1', status: 'mismatch', actual: 'Click opened HTTP 404.' }] },
  evidence: [{ id: 'trace', itemId: 'item', version: 1, kind: 'text', mime: 'text/plain', size: 64, title: 'Observed click', blobPath: 'private-path-never-sent',
    captureId: 'capture', runId: 'run', url: 'https://fixture.test/returns', action: 'click', error: null, sha256: 'a'.repeat(64), observedAt: '2026-10-06T10:00:30Z', readStatus: 'read', evidencePolicyVersion: 2, origin: 'tool',
    provenance: { version: 1, origin: 'tool', producer: 'browser-action', sourceType: 'test', sourceId: 'run', observedAt: '2026-10-06T10:00:30Z', sha256: 'a'.repeat(64) } }], ruleFindings: [],
});
const relation = (reportRelation, overrides = {}) => {
  const old = { requirementId: 'step-1', explanation: 'Saved click and 404 match the reported observation.', evidenceIds: ['trace'], suggestedNextStep: '', gap: null, ...overrides };
  const { explanation, evidenceIds, ...rest } = old;
  return { ...rest, coverage: 'complete', parts: [{ text: explanation, evidenceIds, basis: 'other', relation: { substantiates_reported_check: 'supports', contradicts_reported_check: 'contradicts', insufficient_evidence: 'unresolved' }[reportRelation] ?? reportRelation }] };
};
const output = (...findings) => ({ summary: 'The executor reported the observed result.', findings });
const missing = () => relation('insufficient_evidence', { evidenceIds: [], explanation: 'No observation is readable.', gap: { kind: 'missing_observation', wantedEvidence: 'Independent evidence for the original observation.', capability: 'browser' } });
const map = (value, input = source()) => assessmentFromReportedChecks(value, input.requirements);
const keyed = value => ({ ...value, findings: Object.fromEntries(value.findings.map(({ requirementId, ...finding }) => [requirementId, finding])) });
const resolveSchema = (schema, value) => value.$ref ? resolveSchema(schema, value.$ref.slice(2).split('/').reduce((node, key) => node[key], schema)) : value;

function observedInput(action = 'open', outcome = 'observed', changed = true) {
  const input = source();
  input.readObservations = [{ evidenceId: 'trace', runId: input.runId, action, outcome,
    fromUrl: input.target.url, toUrl: changed ? input.target.url + 'next' : input.target.url, httpStatus: 404 }];
  return input;
}
function basisOutput(basis, relationName = 'supports', evidenceIds = ['trace']) {
  const value = keyed(output(relation(relationName, relationName === 'unresolved' ? { gap: missing().gap } : {})));
  Object.assign(value.findings['step-1'].parts[0], { basis, evidenceIds });
  return value;
}
const actionBases = ['action_attempt', 'performed_action', 'changed_destination'];

test('native observation forms expose only independently observed action capabilities, not product success', () => {
  for (const [input, enabled] of [[source(), []], [observedInput(), []], [observedInput('click', 'action_failed'), ['action_attempt']],
    [observedInput('click', 'observed', false), ['action_attempt', 'performed_action']], [observedInput('click'), actionBases]]) {
    const before = structuredClone(input), schema = reportedCheckAssessmentSchemaFor(input.requirements, input);
    for (const basis of ['state', 'other', ...actionBases]) {
      assert.equal(schema.safeParse(basisOutput(basis)).success, ['state', 'other', ...enabled].includes(basis), basis);
      assert.equal(schema.safeParse(basisOutput(basis, 'unresolved')).success, true, 'Missing observation stays expressible, never normalized');
      assert.equal(schema.safeParse(basisOutput(basis, 'contradicts')).success, true, 'Counterproof need not exhibit the claimed success');
    }
    assert.deepEqual(input, before);
  }
  assert.equal(reportedCheckAssessmentSchemaFor(source().requirements).safeParse(basisOutput('performed_action')).success, false);
});

test('native observation forms cannot be enabled by unread, foreign, untrusted or missing index entries', () => {
  const mutators = [input => { input.readObservations = []; }, input => { input.readObservations[0].runId = 'foreign'; },
    input => { input.readObservations[0].evidenceId = 'unknown'; }, input => { input.readObservations[0].outcome = 'unknown'; },
    input => { input.evidence[0].readStatus = 'limited'; }, input => { input.evidence[0].readStatus = 'unavailable'; },
    input => { input.evidence[0].runId = 'foreign'; }, input => { input.evidence[0].provenance.sourceId = 'foreign'; },
    input => { input.evidence[0].provenance.origin = 'agent'; }, input => { input.evidence[0].sha256 = 'b'.repeat(64); }];
  for (const mutate of mutators) {
    const input = observedInput('click'); mutate(input);
    const schema = reportedCheckAssessmentSchemaFor(input.requirements, input);
    for (const basis of actionBases) assert.equal(schema.safeParse(basisOutput(basis)).success, false);
  }
});

test('native observation forms do not replace the exact cited-part, coverage or gap validators', () => {
  const input = observedInput('open'), click = structuredClone(input.evidence[0]); click.id = 'other-trace';
  input.evidence.push(click);
  input.readObservations.push({ ...input.readObservations[0], evidenceId: click.id, action: 'click' });
  const wrong = basisOutput('changed_destination');
  assert.equal(reportedCheckAssessmentSchemaFor(input.requirements, input).safeParse(wrong).success, true, 'Run has that form');
  assert.throws(() => assessmentFromKeyedChecks(wrong, input.requirements, input), /lacks a corresponding read action observation/, 'The cited open cannot borrow the other click');
  const good = basisOutput('changed_destination', 'supports', [click.id]);
  assert.equal(validateAssessment(input, assessmentFromKeyedChecks(good, input.requirements, input)).verdict, 'supported');
  assert.equal(input.reportedResult.outcome, 'failed', 'A proven negative product result is valid QA');
  const absent = basisOutput('performed_action', 'supports', []);
  assert.throws(() => assessmentFromKeyedChecks(absent, input.requirements, input), /independent evidence/);
  const noGap = basisOutput('performed_action', 'unresolved'); noGap.findings['step-1'].gap = null;
  assert.throws(() => assessmentFromKeyedChecks(noGap, input.requirements, input), /unresolved evidence gap/);
  const before = structuredClone(wrong); assert.throws(() => assessmentFromKeyedChecks(wrong, input.requirements, input)); assert.deepEqual(wrong, before);
});

test('native observation forms reach actual SDK JSON schema and reject unavailable supports without another call', async () => {
  const input = observedInput(); input.requirements[0].requirement = 'Inspect the form; do not click, fill or submit it.';
  const original = structuredClone(input), actual = await sdk(basisOutput('state'), input);
  const schema = actual.request.response_format.json_schema.schema;
  const finding = resolveSchema(schema, schema.properties.findings.properties['step-1']);
  const part = resolveSchema(schema, resolveSchema(schema, finding.properties.parts).items);
  const branches = part.anyOf.map(branch => resolveSchema(schema, branch));
  const supported = branches.find(branch => branch.properties.relation.const === 'supports');
  assert.deepEqual(supported.properties.basis.enum, ['state', 'other']);
  assert.equal(supported.additionalProperties, false);
  assert.deepEqual(supported.required.sort(), ['basis', 'evidenceIds', 'relation', 'text']);
  assert.equal(actual.calls, 1); assert.equal(actual.admissions, 1); assert.equal(actual.request.max_tokens, 8000); assert.equal(actual.request.reasoning_effort, 'high');
  assert.deepEqual(JSON.parse(actual.request.messages.at(-1).content[0].text).requirements[0], { ...input.requirements[0], reportedCheck: input.reportedResult.checks[0] && { status: input.reportedResult.checks[0].status, actual: input.reportedResult.checks[0].actual } });
  assert.deepEqual(input, original);
  await assert.rejects(sdk(basisOutput('performed_action'), input), error => error.name === 'AI_NoObjectGeneratedError' && error.testCalls === 1 && error.testAdmissions === 1);
  const unresolved = await sdk(basisOutput('performed_action', 'unresolved'), input);
  assert.equal(unresolved.result.verdict, 'needs_evidence'); assert.equal(unresolved.calls, 1);
});

test('native observation forms retain failed-action negative QA, unchanged URL counterproof and direct-open state in actual SDK', async () => {
  for (const [input, value, verdict] of [
    [observedInput('click', 'action_failed'), basisOutput('action_attempt'), 'supported'],
    [observedInput('click', 'observed', false), basisOutput('changed_destination', 'contradicts'), 'contradicted'],
    [observedInput(), basisOutput('state'), 'supported'],
  ]) {
    const before = structuredClone(input), actual = await sdk(value, input);
    assert.equal(actual.result.verdict, verdict); assert.equal(actual.calls, 1); assert.equal(actual.admissions, 1);
    assert.deepEqual(input, before); assert.equal(actual.request.model, 'glm-5.3');
  }
});

test('exact-key schema requires every original check and rejects unknown or model-owned identities', () => {
  const requirements = [{ id: 'expected' }, { id: 'step-1' }], schema = reportedCheckAssessmentSchemaFor(requirements);
  const value = keyed(output(relation('substantiates_reported_check'), { ...missing(), requirementId: 'expected' }));
  const result = assessmentFromKeyedChecks(value, requirements);
  assert.deepEqual(result.findings.map(row => row.requirementId), ['expected', 'step-1'], 'Code uses original order, not model key order');
  assert.equal(result.verdict, 'needs_evidence');
  for (const mutate of [v => { delete v.findings.expected; }, v => { v.findings.foreign = v.findings['step-1']; },
    v => { v.findings['step-1'].requirementId = 'expected'; }, v => { delete v.findings['step-1'].gap; }]) {
    const bad = structuredClone(value); mutate(bad); assert.equal(schema.safeParse(bad).success, false);
    assert.throws(() => assessmentFromKeyedChecks(bad, requirements));
  }
  assert.equal(schema.safeParse(output(relation('substantiates_reported_check'))).success, false, 'No current array fallback');
  const before = structuredClone(value); assessmentFromKeyedChecks(value, requirements); assert.deepEqual(value, before);
});

test('exact-key adapter still reaches existing gap, part-evidence, provenance and original-check validators', () => {
  const input = source(), good = keyed(output(relation('substantiates_reported_check')));
  assert.equal(validateAssessment(input, assessmentFromKeyedChecks(good, input.requirements, input)).verdict, 'supported');
  assert.equal(input.reportedResult.outcome, 'failed', 'Correct negative outcome is preserved');
  const noGap = keyed(output({ ...missing(), gap: null }));
  assert.throws(() => assessmentFromKeyedChecks(noGap, input.requirements, input), /unresolved evidence gap/);
  const mixed = keyed(output(relation('contradicts_reported_check'), { ...missing(), requirementId: 'expected' }));
  assert.throws(() => assessmentFromKeyedChecks(mixed, [...input.requirements, { id: 'expected' }], input), /Only an unresolved/);
  for (const change of [v => { v.evidence[0].readStatus = 'limited'; }, v => { v.evidence[0].runId = 'foreign'; },
    v => { v.evidence[0].provenance.origin = 'agent'; }, v => { v.reportedResult.checks[0].status = 'unverified'; }]) {
    const badInput = structuredClone(input); change(badInput);
    assert.throws(() => validateAssessment(badInput, assessmentFromKeyedChecks(good, badInput.requirements, badInput)));
  }
  const unknownCitation = structuredClone(good); unknownCitation.findings['step-1'].parts[0].evidenceIds = ['unknown'];
  assert.throws(() => assessmentFromKeyedChecks(unknownCitation, input.requirements, input), /unread|unknown/);
});

test('exact-key invalid original IDs reject before provider or admission; native missing/extra keys reject after one call', async () => {
  const oldFetch = globalThis.fetch, oldKey = process.env.GRUNDEN_API_TOKEN; let calls = 0, admissions = 0;
  process.env.GRUNDEN_API_TOKEN = 'synthetic';
  globalThis.fetch = async () => { calls++; throw new Error('No provider expected for invalid input'); };
  try {
    for (const requirements of [[], [{ id: 'step-1' }, { id: 'step-1' }], [{ id: '' }], [{ id: ' ' }], [{ id: 'x'.repeat(81) }],
      [{ id: null }], [{ id: '__proto__' }], Array.from({ length: 203 }, (_, i) => ({ id: `step-${i}` }))]) {
      await assert.rejects(assessResult({ ...source(), requirements }, [], AbortSignal.timeout(5000), undefined, async () => { admissions++; }));
    }
    assert.equal(calls, 0); assert.equal(admissions, 0);
  } finally { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.GRUNDEN_API_TOKEN; else process.env.GRUNDEN_API_TOKEN = oldKey; }
  for (const findings of [{}, { 'step-1': keyed(output(missing())).findings['step-1'], foreign: keyed(output(missing())).findings['step-1'] }]) {
    await assert.rejects(sdk({ summary: 'No invented coverage.', findings }), error => error.name === 'AI_NoObjectGeneratedError' && error.testCalls === 1 && error.testAdmissions === 1);
  }
});

test('exact-key installed SDK advertises required strict IDs with nullable gaps and bounded reusable schema at 202 checks', async t => {
  const input = source(); input.requirements = Array.from({ length: 202 }, (_, i) => ({ id: `check-${i}-` + 'x'.repeat(65), requirement: `Original ${i}` }));
  input.reportedResult.checks = input.requirements.map(row => ({ id: row.id, status: 'unverified', actual: 'Not established.' }));
  const original = structuredClone(input);
  const wire = { summary: 'All original checks remain unresolved.', findings: Object.fromEntries(input.requirements.map(row => {
    const finding = missing(); delete finding.requirementId; return [row.id, finding];
  })) };
  const actual = await sdk(wire, input), schema = actual.request.response_format.json_schema.schema, findings = schema.properties.findings;
  assert.equal(actual.calls, 1); assert.equal(actual.admissions, 1); assert.equal(actual.request.max_tokens, 8000); assert.equal(actual.request.reasoning_effort, 'high');
  assert.deepEqual(findings.required, input.requirements.map(row => row.id)); assert.equal(findings.additionalProperties, false);
  assert.equal(Object.keys(findings.properties).length, 202);
  assert.equal(new Set(Object.values(findings.properties).map(value => value.$ref)).size, 1, 'All values share the typed schema');
  assert.ok(Object.values(findings.properties).every(value => typeof value.$ref === 'string'));
  const row = resolveSchema(schema, Object.values(findings.properties)[0]);
  assert.equal(row.additionalProperties, false); assert.ok(row.required.includes('gap')); assert.equal(Object.hasOwn(row.properties, 'requirementId'), false);
  assert.ok(resolveSchema(schema, row.properties.gap).anyOf.some(value => value.type === 'null'));
  assert.ok(JSON.stringify(schema).length < 50000, 'Maximum valid check count and long IDs retain bounded schema size');
  assert.deepEqual(actual.result.findings.map(row => row.requirementId), input.requirements.map(row => row.id));
  const submitted = JSON.parse(actual.request.messages.at(-1).content[0].text);
  assert.deepEqual(submitted.requirements.map(({ id, requirement }) => ({ id, requirement })), input.requirements);
  assert.deepEqual(input, original);
  t.diagnostic(JSON.stringify({ checkCount: 202, schemaBytes: Buffer.byteLength(JSON.stringify(schema)), requestBytes: Buffer.byteLength(JSON.stringify(actual.request)), providerCalls: actual.calls, maxOutputTokens: actual.request.max_tokens }));
});

test('a correctly reported failed product observation maps to supported, without changing the original failure', () => {
  const input = source(), original = structuredClone(input);
  const value = map(output(relation('substantiates_reported_check')), input);
  assert.equal(validateAssessment(input, value).verdict, 'supported');
  assert.equal(value.findings[0].verdict, 'supported'); assert.deepEqual(reviewGaps({ reviewerVersion: REVIEWER_VERSION, assessment: value }), []);
  assert.deepEqual(input, original); assert.equal(input.reportedResult.outcome, 'failed');
});

test('an erroneous passed report contradicted by a 404 remains contradicted, not an automatically supported failure', () => {
  const input = source(); input.reportedResult.outcome = 'passed'; input.reportedResult.checks[0] = { id: 'step-1', status: 'verified', actual: 'The page worked.' };
  const value = map(output(relation('contradicts_reported_check', { explanation: 'The actual 404 contradicts the claim that the page worked.' })), input);
  assert.equal(validateAssessment(input, value).verdict, 'contradicted');
  assert.deepEqual(reviewGaps({ reviewerVersion: REVIEWER_VERSION, assessment: value }), []);
  // Mapping follows the typed relationship, never outcome, explanatory prose or a fixture oracle.
  input.reportedResult.outcome = 'failed'; input.reportedResult.checks[0].status = 'mismatch';
  assert.equal(validateAssessment(input, map(output(relation('contradicts_reported_check')), input)).verdict, 'contradicted');
});

test('missing evidence remains needs_evidence and retains only its original typed gap', () => {
  const input = source(); input.evidence = [];
  const value = map(output(missing()), input);
  assert.equal(validateAssessment(input, value).verdict, 'needs_evidence');
  assert.equal(reviewGaps({ reviewerVersion: REVIEWER_VERSION, assessment: value }).length, 1);
  assert.throws(() => validateAssessment(input, map(output(relation('substantiates_reported_check')))), /unread or unknown/);
});

test('model schema has explicit observation relations, no product verdict or aggregate guessing', () => {
  const schema = z.toJSONSchema(reportedCheckAssessmentSchema), finding = schema.properties.findings.items;
  assert.deepEqual(Object.keys(schema.properties).sort(), ['findings', 'summary']);
  assert.equal(Object.hasOwn(finding.properties, 'verdict'), false);
  assert.deepEqual(finding.properties.parts.items.properties.relation.enum, ['supports', 'contradicts', 'unresolved']);
  assert.ok(finding.required.includes('gap')); assert.equal(finding.additionalProperties, false);
  for (const value of ['passed', 'failed', 'supported', 'contradicted', 'supports_requirement', 'missing']) assert.equal(reportedCheckAssessmentSchema.safeParse(output(relation(value))).success, false);
  assert.equal(reportedCheckAssessmentSchema.safeParse({ ...output(relation('substantiates_reported_check')), verdict: 'supported' }).success, false);
});

test('aggregate derives only from typed findings and the existing gap rules still apply', () => {
  const input = source(); input.requirements.push({ id: 'step-2', requirement: 'Second original point' });
  const missingSecond = { ...missing(), requirementId: 'step-2' };
  assert.equal(map(output(relation('substantiates_reported_check'), missingSecond), input).verdict, 'needs_evidence');
  assert.throws(() => map(output(relation('contradicts_reported_check'), missingSecond), input), /Only an unresolved/);
  assert.equal(map(output(relation('contradicts_reported_check'), { ...missingSecond, gap: null }), input).verdict, 'contradicted');
  assert.throws(() => map(output(relation('substantiates_reported_check', { gap: missing().gap }))), /Only an unresolved/);
  assert.throws(() => map(output({ ...missing(), gap: { ...missing().gap, kind: 'unclear_requirement' } })), /Capability/);
});

test('adapter requires exactly the original check identities before any downstream validator', () => {
  assert.throws(() => map(output(relation('substantiates_reported_check', { requirementId: 'invented' }))), /original requirements/);
  assert.throws(() => map(output(relation('substantiates_reported_check'), relation('substantiates_reported_check'))), /Duplicate/);
  const input = source(); input.requirements.push({ id: 'step-2' });
  assert.throws(() => map(output(relation('substantiates_reported_check')), input), /original requirements/);
});

test('current mapping never bypasses unread, foreign-run, provenance or unperformed-check guards', () => {
  for (const mutate of [input => { input.evidence[0].readStatus = 'limited'; }, input => { input.evidence[0].runId = 'other'; },
    input => { input.evidence[0].provenance.origin = 'agent'; }, input => { input.reportedResult.checks[0].status = 'unverified'; }]) {
    const input = source(); mutate(input);
    assert.throws(() => validateAssessment(input, map(output(relation('substantiates_reported_check')), input)));
  }
});

test('historical verdict and prose remain readable without reinterpretation or continuation authority', () => {
  assert.equal(REVIEWER_VERSION, '19'); assert.equal(REVIEW_HASH_VERSION, 2);
  const old = { verdict: 'contradicted', summary: 'Utförarens rapportering stöds.', findings: [{ requirementId: 'step-1', verdict: 'contradicted', explanation: 'Correctly reported failed.', evidenceIds: ['trace'], suggestedNextStep: '', gap: null }] };
  assert.deepEqual(assessmentSchema.parse(old), old); assert.deepEqual(reviewGaps({ reviewerVersion: '6', assessment: old }), []);
  assert.throws(() => map(old), /coverage|parts|Unrecognized/);
  const typed = output(relation('contradicts_reported_check', { explanation: 'Utförarens rapportering stöds.' }));
  assert.equal(map(typed).verdict, 'contradicted', 'No prose heuristic flips a model decision');
});

async function sdk(mockOutput, input = source(), attachments = [{ type: 'text', text: 'SYNTHETIC INDEPENDENT TRACE: click -> HTTP 404.' }]) {
  const oldFetch = globalThis.fetch, oldKey = process.env.GRUNDEN_API_TOKEN; let request, calls = 0, usage, admissions = 0;
  process.env.GRUNDEN_API_TOKEN = 'synthetic-test-key';
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.grunden.ai/v1/chat/completions'); calls++; request = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: 'synthetic', created: 0, model: 'fixture', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(Array.isArray(mockOutput.findings) ? keyed(mockOutput) : mockOutput) }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await assessResult(input, attachments, AbortSignal.timeout(5000), (_tokens, measured) => { usage = measured; }, async () => { admissions++; });
    return { result, request, calls, usage, admissions };
  } catch (error) { error.testCalls = calls; error.testAdmissions = admissions; throw error; } finally { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.GRUNDEN_API_TOKEN; else process.env.GRUNDEN_API_TOKEN = oldKey; }
}

test('actual SDK submits explicit per-check observations and maps typed output once with the fixed Klara model and unchanged limits', async () => {
  const input = source();
  input.basis = { kind: 'explicit_requirement', quote: 'Broader task includes a separate workflow outside this selected case.', source: { itemId: 'e9357d50-a7f1-4dcb-9348-0c49db23a7b8', version: 9 } };
  const original = structuredClone(input);
  const { result, request, calls, usage, admissions } = await sdk(output(relation('substantiates_reported_check')), input);
  assert.equal(result.verdict, 'supported'); assert.equal(validateAssessment(input, result).verdict, 'supported');
  assert.equal(calls, 1); assert.equal(admissions, 1); assert.equal(usage.providerCalls, 1); assert.equal(usage.totalTokens, 18);
  assert.equal(request.model, 'glm-5.3'); assert.equal(request.max_tokens, 8000); assert.equal(request.reasoning_effort, 'high');
  const native = request.response_format.json_schema.schema;
  assert.equal(resolveSchema(native, resolveSchema(native, native.properties.findings.properties['step-1']).properties.parts).type, 'array');
  const content = request.messages.at(-1).content, publicInput = JSON.parse(content[0].text);
  assert.deepEqual(publicInput.requirements, input.requirements.map(requirement => ({ ...requirement, reportedCheck: { status: 'mismatch', actual: 'Click opened HTTP 404.' } })));
  assert.deepEqual(publicInput.basis, { kind: 'explicit_requirement' });
  assert.equal(JSON.stringify(request).includes(input.basis.quote), false);
  assert.equal(JSON.stringify(request).includes(input.basis.source.itemId), false);
  assert.match(JSON.stringify(request.messages), /requirements är det uttömmande bedömningsurvalet/);
  const exploratory = structuredClone(input); exploratory.basis.kind = 'exploratory';
  const exploratoryResult = await sdk(output(relation('substantiates_reported_check')), exploratory);
  assert.deepEqual(JSON.parse(exploratoryResult.request.messages.at(-1).content[0].text).basis, { kind: 'exploratory' });
  assert.equal(exploratoryResult.calls, 1); assert.equal(exploratoryResult.admissions, 1);
  assert.equal(exploratory.basis.quote, input.basis.quote);
  assert.deepEqual(publicInput.reportedResult, input.reportedResult); assert.ok(JSON.stringify(content).includes('SYNTHETIC INDEPENDENT TRACE'));
  assert.ok(!JSON.stringify(request).includes('private-path-never-sent')); assert.deepEqual(input, original);
});

test('actual SDK rejects the old ambiguous model wire format rather than coercing it', async () => {
  await assert.rejects(sdk({ verdict: 'supported', summary: 'Old output', findings: [{ requirementId: 'step-1', verdict: 'supported', explanation: 'Old', evidenceIds: ['trace'], suggestedNextStep: '', gap: null }] }));
  for (const old of ['supports_reported_observation', 'contradicts_reported_observation', 'missing_evidence']) {
    assert.equal(reportedCheckAssessmentSchema.safeParse(output(relation(old))).success, false);
    await assert.rejects(sdk(output(relation(old))));
  }
});

test('absent or ambiguous original observation is explicitly null at the model boundary', async () => {
  for (const checks of [[], [source().reportedResult.checks[0], source().reportedResult.checks[0]]]) {
    const input = source(); input.reportedResult.checks = checks;
    const { request, result } = await sdk(output(missing()), input);
    assert.equal(JSON.parse(request.messages.at(-1).content[0].text).requirements[0].reportedCheck, null);
    assert.equal(result.verdict, 'needs_evidence');
  }
});

test('actual SDK retains all original subconditions when reported actual omits a link; synthetic missing output is not upgraded', async () => {
  const input = source(); input.requirements[0].requirement = 'Home points to /, Help points to /help and Contact points to /contact.';
  input.reportedResult.outcome = 'passed'; input.reportedResult.checks[0] = { id: 'step-1', status: 'verified', actual: 'Help and Contact targets matched.' };
  const actual = await sdk(output(missing()), input, [{ type: 'text', text: 'SYNTHETIC: Help /help and Contact /contact observed. No Home destination recorded.' }]);
  const submitted = JSON.parse(actual.request.messages.at(-1).content[0].text);
  assert.equal(submitted.requirements[0].requirement, input.requirements[0].requirement);
  assert.equal(submitted.requirements[0].reportedCheck.actual, input.reportedResult.checks[0].actual);
  assert.equal(actual.result.verdict, 'needs_evidence'); assert.equal(actual.calls, 1);
  const instructions = actual.request.messages.find(message => message.role === 'system').content;
  assert.match(instructions, /En kortare actual-text begränsar inte det ursprungliga kravet/);
  assert.match(instructions, /annan körnings observation ersätter inte saknat bevis/);
  // This tests the real SDK wire contract, not a real model's semantic judgment.
});

test('actual SDK sends DOM href evidence as observations while preserving an explicit click requirement', async () => {
  const input = source(); input.requirements[0].requirement = 'Click Home and verify the resulting page.';
  const attachment = { type: 'text', text: JSON.stringify({ observation: { linkObservation: { method: 'dom-css-visible-anchors', links: [{ label: 'Home', href: 'https://fixture.test/' }], truncated: false, limitation: 'No click proof' } } }) };
  const actual = await sdk(output(missing()), input, [attachment]);
  assert.equal(actual.request.messages.at(-1).content[1].text, attachment.text);
  assert.equal(JSON.parse(actual.request.messages.at(-1).content[0].text).requirements[0].requirement, 'Click Home and verify the resulting page.');
  assert.equal(actual.result.verdict, 'needs_evidence');
  assert.match(actual.request.messages.find(message => message.role === 'system').content, /bevisar inte att länken klickats/);
});

test('preserved failed real review remains failed history; its omitted subcondition reaches the actual SDK unchanged', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/reviewer-missing-link.json', import.meta.url), 'utf8'));
  assert.equal(fixture.sourceArtifactSha256, 'bdcbf84af3b35fefd692c9dad23e55b9d057ff18a0e7e344c5c92e8c56e89421');
  assert.equal(fixture.originalResult, 'failed'); assert.equal(fixture.recertified, false);
  assert.equal(fixture.assessment.verdict, 'supported'); // historical incorrect judgment is not rewritten
  assert.match(fixture.expected, /'Hem' → \//);
  assert.deepEqual(fixture.traces.map(trace => trace.action), ['open', 'click', 'back', 'click']);
  assert.ok(fixture.traces.every(trace => !Object.hasOwn(trace.observation, 'linkObservation')));
  assert.equal(fixture.traces.some(trace => trace.action === 'click' && new URL(trace.toUrl).pathname === '/'), false);
  const input = source(), originalCheck = fixture.reportedResult.checks.find(check => check.id === 'expected');
  input.requirements[0].requirement = fixture.expected;
  input.reportedResult.checks[0] = { ...originalCheck, id: 'step-1' };
  const actual = await sdk(output(missing()), input, [{ type: 'text', text: JSON.stringify(fixture.traces) }]);
  const submitted = JSON.parse(actual.request.messages.at(-1).content[0].text);
  assert.equal(submitted.requirements[0].requirement, fixture.expected);
  assert.deepEqual(submitted.requirements[0].reportedCheck, { status: originalCheck.status, actual: originalCheck.actual });
  assert.equal(actual.result.verdict, 'needs_evidence');
  // Model response is synthetic; this is not a recertification or live-model eval.
});

test('full-check truth table preserves requirements, negative outcomes and explicit uncertainty without inferring from prose', () => {
  const rows = [
    { status: 'verified', actual: 'Controls are visible; refs were returned.', reportRelation: 'insufficient_evidence', verdict: 'needs_evidence' },
    { status: 'mismatch', actual: 'Update was performed but the required status stayed Pending.', reportRelation: 'substantiates_reported_check', verdict: 'supported' },
    { status: 'verified', actual: 'Update completed.', reportRelation: 'insufficient_evidence', verdict: 'needs_evidence' },
    { status: 'verified', actual: 'Update was performed.', reportRelation: 'contradicts_reported_check', verdict: 'contradicted' },
  ];
  for (const row of rows) {
    const input = source(); input.requirements[0].requirement = 'The named controls are visible and usable; Update changes the status.';
    input.reportedResult.checks[0] = { id: 'step-1', status: row.status, actual: row.actual };
    input.reportedResult.outcome = row.status === 'mismatch' ? 'failed' : 'passed';
    const original = structuredClone(input), finding = row.reportRelation === 'insufficient_evidence'
      ? { ...missing(), parts: [{ ...missing().parts[0], text: 'The complete original claim lacks evidence.' }] } : relation(row.reportRelation);
    const result = validateAssessment(input, map(output(finding), input));
    assert.equal(result.verdict, row.verdict); assert.deepEqual(input, original);
    if (row.verdict !== 'needs_evidence') assert.deepEqual(reviewGaps({ reviewerVersion: REVIEWER_VERSION, assessment: result }), []);
    // This proves typed mapping, not that the model will choose the right row.
  }
});

test('saved open-only full-check failure reaches SDK without narrowing its requirement or relabelling its history', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/reviewer-full-check.json', import.meta.url), 'utf8'));
  assert.equal(fixture.recertified, false);
  assert.equal(fixture.provenance.originalInputHash, 'db0c9717d7a7d9cc7da69281dd3dc319775b484591f63632127ee980b975ebf2');
  assert.equal(fixture.originalAssessment.verdict, 'supported');
  assert.equal(fixture.reportObservation.subject.relation, 'supports');
  assert.equal(fixture.trace.action, 'open'); assert.equal(fixture.trace.filledField, undefined);
  const input = structuredClone(fixture.input), original = structuredClone(input);
  const findings = input.requirements.map(requirement => ({ ...missing(), requirementId: requirement.id,
    gap: { kind: 'missing_observation', wantedEvidence: 'Independent support for the complete original claim.', capability: 'browser' } }));
  const actual = await sdk(output(...findings), input, [{ type: 'text', text: JSON.stringify(fixture.trace) }]);
  const submitted = JSON.parse(actual.request.messages.at(-1).content[0].text);
  for (const requirement of input.requirements) {
    const check = input.reportedResult.checks.find(check => check.id === requirement.id);
    assert.deepEqual(submitted.requirements.find(row => row.id === requirement.id), { ...requirement, reportedCheck: { status: check.status, actual: check.actual } });
  }
  assert.deepEqual(submitted.reportedResult, fixture.originalResult);
  assert.equal(actual.result.findings.find(finding => finding.requirementId === 'step-2').verdict, 'needs_evidence');
  assert.equal(actual.calls, 1); assert.deepEqual(input, original);
  assert.equal(actual.request.max_tokens, 8000); assert.equal(actual.request.reasoning_effort, 'high');
  // Synthetic transport neither changes the historical review nor proves new
  // model semantics. The exact two real attachments are separately frozen.
});

test('a visibility-only claim is not forced to demand a click; typed relations never impose an unrequested test method', async () => {
  const input = source(); input.requirements[0].requirement = 'The navigation controls are visible.';
  input.reportedResult.outcome = 'passed'; input.reportedResult.checks[0] = { id: 'step-1', status: 'verified', actual: 'The named controls were visible in the observed page.' };
  input.evidence[0].action = 'open';
  const actual = await sdk(output(relation('substantiates_reported_check')), input);
  assert.equal(validateAssessment(input, actual.result).verdict, 'supported');
  assert.deepEqual(JSON.parse(actual.request.messages.at(-1).content[0].text).requirements[0], { ...input.requirements[0], reportedCheck: { status: 'verified', actual: input.reportedResult.checks[0].actual } });
});

test('session scope SDK keeps content and conditional expected distinct from authentication claims', async () => {
  const input = source();
  input.browserSessionContext = { version: 1, kind: 'human_returned_session', priorAuthentication: 'unknown' };
  input.requirements = [
    { id: 'preconditions', requirement: 'Inga särskilda förutsättningar.' },
    { id: 'expected', requirement: 'Profilsidan kan öppnas och visar kontouppgifterna. Om åtkomst nekas redovisas det nödvändiga åtkomstbehovet.' },
  ];
  input.reportedResult.outcome = 'passed';
  input.reportedResult.checks = [
    { id: 'preconditions', status: 'verified', actual: 'Inga särskilda förutsättningar krävdes.' },
    { id: 'expected', status: 'verified', actual: 'Kontouppgifterna visades; inget åtkomstbehov behövde redovisas i detta körningstillstånd. Anonym åtkomst påstås inte.' },
  ];
  input.evidence[0].action = 'open';
  const original = structuredClone(input), attachment = { type: 'text', text: 'SYNTHETIC OWN OPEN: HTTP 200; rendered account fields. Prior authentication and account identity not observed.' };
  const contextGap = { kind: 'environment_prerequisite', wantedEvidence: 'Support for the stated session prerequisite.', capability: 'none' };
  const partial = output(
    relation('unresolved', { requirementId: 'preconditions', evidenceIds: [], explanation: 'The broad no-prerequisite claim lacks session evidence.', gap: contextGap }),
    relation('supports', { requirementId: 'expected', explanation: 'Own open observation shows the requested content in this state; the denied-access branch did not occur.' }),
  );
  const actual = await sdk(partial, input, [attachment]);
  assert.equal(validateAssessment(input, actual.result).verdict, 'needs_evidence');
  assert.deepEqual(actual.result.findings.map(finding => [finding.requirementId, finding.verdict]), [['preconditions', 'needs_evidence'], ['expected', 'supported']]);
  const content = actual.request.messages.at(-1).content, submitted = JSON.parse(content[0].text);
  assert.deepEqual(submitted.requirements, input.requirements.map((requirement, index) => ({ ...requirement, reportedCheck: { status: input.reportedResult.checks[index].status, actual: input.reportedResult.checks[index].actual } })));
  assert.deepEqual(submitted.browserSessionContext, input.browserSessionContext);
  assert.deepEqual(submitted.reportedResult, input.reportedResult); assert.equal(content[1].text, attachment.text);
  assert.deepEqual(submitted.evidence.map(item => item.id), ['trace']); assert.deepEqual(input, original);
  assert.equal(actual.request.model, 'glm-5.3'); assert.equal(actual.request.max_tokens, 8000); assert.equal(actual.request.reasoning_effort, 'high');
  assert.equal(actual.calls, 1); assert.equal(actual.admissions, 1); assert.equal(actual.usage.providerCalls, 1);
  const instructions = actual.request.messages.find(message => message.role === 'system').content;
  assert.match(instructions, /Egna oberoende observationer av synligt innehåll i aktuell session kan styrka just innehållskravet/);
  assert.match(instructions, /Okänd autentisering begränsar bara påståenden eller krav om anonymitet, inloggningsmetod, kontoidentitet, ren session eller sessionskontinuitet/);
  assert.match(instructions, /inte som att båda alternativa utfall måste inträffa/);
  assert.match(instructions, /Är villkoret okänt ska osäkerheten anges, inte en gren antas/);
  // This is a synthetic SDK response, not evidence of a corrected model judgment.
});

test('session scope SDK retains explicit session claims and the denied conditional branch without automatic upgrades', async () => {
  const input = source();
  input.browserSessionContext = { version: 1, kind: 'human_returned_session', priorAuthentication: 'unknown' };
  input.requirements = [
    { id: 'step-1', requirement: 'Testet börjar i en ren, anonym session; användaren loggar sedan in med lösenord och samma session ska behållas; kontot ska tillhöra den angivna användaren.' },
    { id: 'expected', requirement: 'Vyn visar kontouppgifter. Om åtkomst nekas redovisas hindret i stället för att åtkomsten anges som verifierad.' },
  ];
  input.reportedResult.outcome = 'failed';
  input.reportedResult.checks = [
    { id: 'step-1', status: 'verified', actual: 'Sessionens egenskaper antogs.' },
    { id: 'expected', status: 'mismatch', actual: 'HTTP 403 hindrade åtkomst; kontouppgifterna kunde inte verifieras.' },
  ];
  const original = structuredClone(input);
  const actual = await sdk(output(missing(), relation('supports', { requirementId: 'expected', explanation: 'Own HTTP 403 supports the reported denied branch, not successful account access.' })), input,
    [{ type: 'text', text: 'SYNTHETIC OWN OPEN: HTTP 403. No evidence of clean session, login method, continuity or account identity.' }]);
  assert.deepEqual(actual.result.findings.map(finding => [finding.requirementId, finding.verdict]), [['step-1', 'needs_evidence'], ['expected', 'supported']]);
  assert.equal(validateAssessment(input, actual.result).verdict, 'needs_evidence');
  assert.equal(JSON.parse(actual.request.messages.at(-1).content[0].text).requirements[0].requirement, original.requirements[0].requirement);
  assert.deepEqual(input, original); assert.equal(actual.calls, 1);
  for (const mutate of [value => { value.evidence[0].readStatus = 'limited'; }, value => { value.evidence[0].runId = 'foreign'; }]) {
    const invalid = structuredClone(input); mutate(invalid);
    assert.throws(() => validateAssessment(invalid, actual.result));
  }
});
