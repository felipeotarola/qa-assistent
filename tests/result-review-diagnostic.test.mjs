import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NoObjectGeneratedError, NoOutputGeneratedError, Output, TypeValidationError } from 'ai';
import { z } from 'zod';
import { reviewFailureDiagnostic } from '../server/utils/result-review-diagnostic.ts';

const secret = 'SYNTHETIC_PRIVATE_CONTENT_DO_NOT_LOG';
const context = finishReason => ({ finishReason,
  response: { id: secret, modelId: secret, timestamp: new Date(0), headers: { authorization: secret }, body: { reasoning: secret } },
  usage: { inputTokens: 12, outputTokens: 8000, totalTokens: 8012 },
});

async function parseFailure(text, finishReason) {
  try {
    await Output.object({ schema: z.object({ approved: z.boolean() }).strict() })
      .parseCompleteOutput({ text }, context(finishReason));
    assert.fail('Expected the installed SDK to reject the synthetic output');
  } catch (error) {
    assert.ok(NoObjectGeneratedError.isInstance(error));
    assert.ok(error.text.includes(secret));
    return error;
  }
}

test('installed SDK JSON parse error retains only category and normalized length reason', async () => {
  const error = await parseFailure(`{"approved": "${secret}`, 'length');
  const diagnostic = reviewFailureDiagnostic(error);
  assert.deepEqual(diagnostic, { version: 1, type: 'AI_NoObjectGeneratedError', category: 'output_json_invalid', finishReason: 'length' });
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  assert.equal(error.usage.outputTokens, 8000, 'The original measurement remains unchanged');
});

test('installed SDK schema rejection is distinct from JSON syntax failure and preserves stop', async () => {
  const error = await parseFailure(JSON.stringify({ approved: secret }), 'stop');
  assert.deepEqual(reviewFailureDiagnostic(error), {
    version: 1, type: 'AI_NoObjectGeneratedError', category: 'output_schema_invalid', finishReason: 'stop',
    validationIssues: [], validationOmitted: true,
  });
});

test('only the six installed SDK finish reasons are exposed; missing or raw provider reasons stay null', () => {
  for (const finishReason of ['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other', undefined, null, 'unknown', secret, { raw: secret }]) {
    const error = new NoObjectGeneratedError({ ...context(finishReason), text: secret, message: secret, cause: new Error(secret) });
    assert.deepEqual(reviewFailureDiagnostic(error), { version: 1, type: 'AI_NoObjectGeneratedError', category: 'output_unclassified',
      finishReason: ['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other'].includes(finishReason) ? finishReason : null });
  }
});

test('no-output SDK error does not infer a finish reason from its nested cause', () => {
  const cause = new NoObjectGeneratedError({ ...context('length'), text: secret });
  assert.deepEqual(reviewFailureDiagnostic(new NoOutputGeneratedError({ message: secret, cause })), {
    version: 1, type: 'AI_NoOutputGeneratedError', category: 'output_missing', finishReason: null,
  });
});

test('arbitrary errors, fake SDK names and thrown values cannot leak names, messages or nested output', () => {
  const error = new Error(secret, { cause: { message: secret, response: secret, reasoning: secret } });
  error.name = secret;
  for (const value of [error, new Error(secret), { name: 'AI_NoObjectGeneratedError', finishReason: 'length', message: secret }, secret, null, undefined]) {
    assert.deepEqual(reviewFailureDiagnostic(value), { version: 1, type: value instanceof Error ? 'Error' : 'unknown', category: 'unexpected', finishReason: null });
  }
});

test('diagnostics never access sensitive SDK fields or arbitrary error names', () => {
  const error = new NoObjectGeneratedError({ ...context('length'), text: secret });
  for (const field of ['text', 'message', 'name', 'response', 'usage', 'stack']) {
    Object.defineProperty(error, field, { get() { throw new Error(`Sensitive field accessed: ${field}`); } });
  }
  assert.deepEqual(reviewFailureDiagnostic(error), {
    version: 1, type: 'AI_NoObjectGeneratedError', category: 'output_unclassified', finishReason: 'length',
  });
});

test('a hostile getter cannot mask the original failure or escape the safe projection', () => {
  const error = new NoObjectGeneratedError({ ...context('length'), text: secret });
  Object.defineProperty(error, 'finishReason', { get() { throw new Error(secret); } });
  for (const value of [error, new Proxy({}, { get() { throw new Error(secret); } })]) {
    assert.deepEqual(reviewFailureDiagnostic(value), { version: 1, type: 'unknown', category: 'unexpected', finishReason: null });
  }
});

function validation(diagnostic) {
  return diagnostic.validationIssues ? { issues: diagnostic.validationIssues.map(value => JSON.parse(value)), omitted: diagnostic.validationOmitted } : undefined;
}
async function schemaFailure(schema, value) {
  try { await Output.object({ schema }).parseCompleteOutput({ text: JSON.stringify(value) }, context('stop')); }
  catch (error) { assert.ok(NoObjectGeneratedError.isInstance(error)); assert.ok(TypeValidationError.isInstance(error.cause)); return error; }
  assert.fail('Synthetic response must fail the unchanged SDK schema');
}
function withIssues(issues) {
  const cause = new TypeValidationError({ value: secret, cause: new z.ZodError([]) });
  // Install hostile fixtures only after SDK error construction; that constructor
  // legitimately formats its cause, unlike the diagnostic under test.
  Object.defineProperty(cause, 'cause', { value: new z.ZodError(issues), configurable: true });
  return new NoObjectGeneratedError({ ...context('stop'), text: secret, cause });
}
test('real SDK/Zod reports exact nested field/index/code/maximum without response content', async () => {
  const schema = z.object({ checkAssessments: z.array(z.object({ text: z.string().max(4), evidenceIds: z.array(z.string()).min(1) }).strict()) }).strict();
  const error = await schemaFailure(schema, { checkAssessments: [{ text: secret, evidenceIds: [] }] });
  const diagnostic = reviewFailureDiagnostic(error);
  assert.deepEqual(validation(diagnostic), { issues: [
    { code: 'too_big', path: ['checkAssessments', 0, 'text'], maximum: 4 },
    { code: 'too_small', path: ['checkAssessments', 0, 'evidenceIds'], minimum: 1 },
  ], omitted: false });
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  assert.equal(error.text.includes(secret), true, 'Original error and strict rejection remain available to the caller');
});
test('custom exact-source failures expose only their schema path, never the custom message or value', async () => {
  const schema = z.object({ findings: z.array(z.object({ criterionId: z.string() })) }).superRefine((_value, ctx) => {
    ctx.addIssue({ code: 'custom', path: ['findings', 0], message: secret });
  });
  const error = await schemaFailure(schema, { findings: [{ criterionId: secret }] });
  assert.deepEqual(validation(reviewFailureDiagnostic(error)), { issues: [{ code: 'custom', path: ['findings', 0] }], omitted: false });
});
test('unknown response keys and enum options do not leak through strict-object errors', async () => {
  const error = await schemaFailure(z.object({ findings: z.array(z.object({ verdict: z.enum(['supported', 'needs_evidence']) }).strict()) }).strict(),
    { findings: [{ verdict: secret, [secret]: secret }] });
  const diagnostic = reviewFailureDiagnostic(error);
  assert.deepEqual(validation(diagnostic), { issues: [
    { code: 'invalid_value', path: ['findings', 0, 'verdict'] },
    { code: 'unrecognized_keys', path: ['findings', 0] },
  ], omitted: false });
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
});
test('dynamic keys, unknown codes, invalid/long paths and excessive issue counts are explicitly omitted', () => {
  const rows = [
    { code: 'custom', path: [secret], message: secret },
    { code: secret, path: ['findings'], message: secret },
    { code: 'custom', path: ['findings', -1], message: secret },
    { code: 'custom', path: ['findings', 10001], message: secret },
    { code: 'custom', path: Array(9).fill('findings'), message: secret },
    { code: 'custom', path: ['findings', 0], message: secret },
    ...Array.from({ length: 10 }, () => ({ code: 'custom', path: [], message: secret })),
  ];
  const diagnostic = reviewFailureDiagnostic(withIssues(rows));
  assert.deepEqual(validation(diagnostic), { issues: [
    { code: 'custom', path: ['findings', 0] }, { code: 'custom', path: [] }, { code: 'custom', path: [] },
  ], omitted: true });
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
});
test('diagnostic projection reads no hostile getters in issues or nested paths/bounds', () => {
  let accessed = 0;
  const getter = { get() { accessed++; throw Error(secret); }, enumerable: true };
  const row = { code: 'too_big', path: ['checkAssessments', 0, 'text'], maximum: 240, message: secret };
  for (const key of ['message', 'input', 'received', 'keys', 'options']) Object.defineProperty(row, key, getter);
  const unsafePath = ['findings', 0]; Object.defineProperty(unsafePath, '1', getter);
  const unsafeBound = { code: 'too_big', path: ['summary'] }; Object.defineProperty(unsafeBound, 'maximum', getter);
  const rows = [row, { code: 'custom', path: unsafePath }, unsafeBound, {}];
  Object.defineProperty(rows, '3', getter);
  const diagnostic = reviewFailureDiagnostic(withIssues(rows));
  assert.deepEqual(validation(diagnostic), { issues: [
    { code: 'too_big', path: ['checkAssessments', 0, 'text'], maximum: 240 },
    { code: 'too_big', path: ['summary'] },
  ], omitted: true });
  assert.equal(accessed, 0);
});
test('non-Zod fake issue objects and hostile cause access leave the original category intact', () => {
  let accessed = 0;
  const cause = new TypeValidationError({ value: secret, cause: { issues: [{ code: 'custom', path: ['findings'] }] } });
  const error = new NoObjectGeneratedError({ ...context('stop'), text: secret, cause });
  assert.equal(validation(reviewFailureDiagnostic(error)), undefined);
  Object.defineProperty(cause, 'cause', { get() { accessed++; throw Error(secret); } });
  assert.deepEqual(reviewFailureDiagnostic(error), { version: 1, type: 'AI_NoObjectGeneratedError', category: 'output_schema_invalid', finishReason: 'stop' });
  assert.equal(accessed, 0);
});
test('bounds outside the finite nonnegative safe integer range are not copied', () => {
  for (const maximum of [secret, Infinity, NaN, -1, 1.2, 1000001, 1n]) {
    const diagnostic = reviewFailureDiagnostic(withIssues([{ code: 'too_big', path: ['findings'], maximum, message: secret }]));
    assert.deepEqual(validation(diagnostic), { issues: [{ code: 'too_big', path: ['findings'] }], omitted: false });
    assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  }
});

test('existing console warning depth exposes exact safe paths without changing callers', async () => {
  const error = await schemaFailure(z.object({ checkAssessments: z.array(z.object({ text: z.string().max(4) })) }), { checkAssessments: [{ text: secret }] });
  const logged = inspect({ id: 'synthetic-report', structuredOutputDiagnostic: reviewFailureDiagnostic(error) });
  assert.ok(logged.includes('checkAssessments')); assert.ok(logged.includes('maximum')); assert.ok(logged.includes('too_big'));
  assert.equal(logged.includes('[Array]'), false); assert.equal(logged.includes('[Object]'), false); assert.equal(logged.includes(secret), false);
});

const validatorCases = [
  ['assessment_requirement_coverage', 'Assessment must cover exactly the original requirements', 'result-assessment'],
  ['assessment_unread_evidence', 'Assessment references unread or unknown evidence', 'result-assessment'],
  ['assessment_evidence_missing', 'Conclusive finding needs evidence', 'result-assessment'],
  ['assessment_independent_evidence_missing', 'Conclusive finding needs independent evidence from this run', 'result-assessment'],
  ['assessment_unresolved_requirement', 'Unresolved requirement prevents supported finding', 'result-assessment'],
  ['assessment_browser_gap_requirement', 'An unclear requirement cannot authorize a browser supplement', 'result-assessment'],
  ['assessment_browser_gap_context', 'Unresolved evidence context cannot authorize a browser supplement', 'result-assessment'],
  ['assessment_summary_conflict', 'Assessment summary contradicts its findings', 'result-assessment'],
  ['subclaim_duplicate', 'Duplicate subclaim', 'review-observations'],
  ['subclaim_unread_evidence', 'Subclaim cites unread or foreign evidence', 'review-observations'],
  ['subclaim_independent_evidence_missing', 'Conclusive subclaim requires applicable independent evidence', 'review-observations'],
  ['subclaim_action_observation_missing', 'Declared action observation lacks a corresponding read action observation', 'review-observations'],
  ['read_observation_identity_conflict', 'Conflicting read observation identity', 'review-observations'],
  ['read_observation_context_capacity', 'Read observation index exceeds bounded context budget', 'review-observations'],
  ['report_check_capacity', 'Report check capacity exceeded', 'mission-report-output'],
  ['report_criterion_coverage', 'Report must cover every original criterion', 'mission-report-output'],
];
function contractDiagnostic(error, code) {
  assert.deepEqual(reviewFailureDiagnostic(error), { version: 1, type: 'Error', category: 'unexpected', finishReason: null, validatorCode: code });
}
function caught(fn) { try { fn(); } catch (error) { return error; } assert.fail('Validator must still reject'); }

test('exact current validator constants produce fixed codes without copying error content or changing the rejection', () => {
  for (const [code, message, module] of validatorCases) {
    assert.ok(readFileSync(resolve(`shared/${module}.ts`), 'utf8').includes(`'${message}'`), 'Only a current literal validator message is allowlisted');
    const error = new Error(message, { cause: { private: secret } });
    const before = Object.getOwnPropertyDescriptors(error);
    contractDiagnostic(error, code);
    assert.deepEqual(Object.getOwnPropertyDescriptors(error), before);
    assert.equal(JSON.stringify(reviewFailureDiagnostic(error)).includes(message), false);
    assert.equal(JSON.stringify(reviewFailureDiagnostic(error)).includes(secret), false);
  }
});

test('actual current reviewer and observation validators keep rejecting and expose their distinct safe codes', async () => {
  const { assessmentFromReportedChecks } = await import(pathToFileURL(resolve('shared/result-assessment.ts')).href);
  const { partsEvidenceIssue, boundedObservationIndex } = await import(pathToFileURL(resolve('shared/review-observations.ts')).href);
  const part = { text: 'Observed original property', basis: 'state', relation: 'supports', evidenceIds: ['read'] };
  const wire = { summary: 'Bounded synthetic review', findings: [{ requirementId: 'step-1', coverage: 'complete', parts: [part], gap: null, suggestedNextStep: '' }] };
  contractDiagnostic(caught(() => assessmentFromReportedChecks(wire, [{ id: 'step-2' }])), 'assessment_requirement_coverage');
  const rows = [
    [{ coverage: 'complete', parts: [part, part] }, new Set(['read']), new Set(['read']), 'subclaim_duplicate'],
    [{ coverage: 'complete', parts: [part] }, new Set(), new Set(), 'subclaim_unread_evidence'],
    [{ coverage: 'complete', parts: [part] }, new Set(['read']), new Set(), 'subclaim_independent_evidence_missing'],
    [{ coverage: 'complete', parts: [{ ...part, basis: 'performed_action' }] }, new Set(['read']), new Set(['read']), 'subclaim_action_observation_missing'],
  ];
  for (const [row, allowed, independent, code] of rows) {
    const issue = partsEvidenceIssue(row, allowed, independent, []);
    assert.equal(typeof issue, 'string'); contractDiagnostic(new Error(issue), code);
  }
  contractDiagnostic(caught(() => assessmentFromReportedChecks(wire, [{ id: 'step-1' }], { evidence: [], readObservations: [] })), 'subclaim_unread_evidence');
  contractDiagnostic(caught(() => boundedObservationIndex([{ evidenceId: 'same', runId: 'first' }, { evidenceId: 'same', runId: 'second' }])), 'read_observation_identity_conflict');
  contractDiagnostic(caught(() => boundedObservationIndex([{ evidenceId: 'large', runId: 'x'.repeat(180001) }])), 'read_observation_context_capacity');
});

test('near matches, inherited messages, subclasses and non-string values never become validator codes', () => {
  const message = validatorCases[0][1];
  class ProviderError extends Error {}
  const inherited = new Error();
  // Inherited data is rejected without relying on any provider naming convention.
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Error.prototype), { message }));
  const boxed = new Error(); Object.defineProperty(boxed, 'message', { value: Object(message) });
  for (const value of [new Error(`${message}: ${secret}`), new Error(` ${message}`), new Error(`${message}\n`),
    new Error(message.toLowerCase()), new Error(secret.repeat(1000)), new ProviderError(message), inherited, boxed,
    { message }, { name: 'Error', message }, message]) {
    const diagnostic = reviewFailureDiagnostic(value);
    assert.equal(diagnostic.validatorCode, undefined);
    assert.equal(JSON.stringify(diagnostic).includes(secret), false);
    assert.equal(JSON.stringify(diagnostic).includes(message), false);
  }
});

test('matching native messages read no getters or arbitrary names, causes, stack or coercions', () => {
  let reads = 0;
  const getter = { get() { reads++; throw Error(secret); }, configurable: true };
  const known = new Error(validatorCases[0][1]);
  for (const field of ['name', 'stack', 'cause', 'response', 'usage', 'text']) Object.defineProperty(known, field, getter);
  contractDiagnostic(known, 'assessment_requirement_coverage');
  const unknown = new Error(); Object.defineProperty(unknown, 'message', getter);
  assert.equal(reviewFailureDiagnostic(unknown).validatorCode, undefined);
  const coercion = new Error(); Object.defineProperty(coercion, 'message', { value: { toString() { reads++; throw Error(secret); } } });
  assert.equal(reviewFailureDiagnostic(coercion).validatorCode, undefined);
  assert.equal(reads, 0);
});

test('SDK causes and provider text containing a validator literal stay on the original SDK diagnostic path', () => {
  const message = validatorCases[0][1];
  const error = new NoObjectGeneratedError({ ...context('stop'), text: message, message, cause: new Error(message) });
  assert.deepEqual(reviewFailureDiagnostic(error), { version: 1, type: 'AI_NoObjectGeneratedError', category: 'output_unclassified', finishReason: 'stop' });
  const wrapped = new Error(secret, { cause: new Error(message) });
  assert.equal(reviewFailureDiagnostic(wrapped).validatorCode, undefined, 'No nested cause adoption');
  assert.equal(JSON.stringify(reviewFailureDiagnostic(error)).includes(message), false);
});
