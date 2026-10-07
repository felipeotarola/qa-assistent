import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { meteredModel } from '../agent/lib/model-usage.ts';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { REVIEWER_VERSION } from '../shared/result-assessment.ts';
import { validateReport } from '../shared/mission-report.ts';
import { DELIVERY_POLICY_VERSION } from '../shared/mission-delivery.ts';
// Synthetic legacy test descriptions map to the current model wire only.
// These fixtures test contracts; they do not certify a real model's semantics.
const partsRow = ({ relation, text, evidenceIds, ...identity }) => ({ ...identity, text, coverage: 'complete', parts: [{ text, evidenceIds, relation, basis: 'other' }] });


const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { writeMissionReport } = await import('../agent/lib/mission-reporter.ts');
hooks.deregister();

const pixels = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1EAAAAASUVORK5CYII=';
const fullText = 'FULL_INDEPENDENT_CONTENT_SENTINEL: button click remained on the prior page. '.repeat(50);
const imageDigest = createHash('sha256').update(Buffer.from(pixels, 'base64')).digest('hex');
const textDigest = createHash('sha256').update(fullText).digest('hex');
const draft = { summary: 'A synthetic negative outcome is reported.', findings: [{ criterionId: 'navigation', verdict: 'supported', conclusion: 'The saved negative observation is under review.', evidenceIds: ['trace', 'image'], nextStep: '' }], limitations: [] };
const target = { environment: 'test', url: 'https://fixture.example.test/', revision: 'fixture-revision' };
const observedAt = '2026-10-06T10:00:01Z';
const snapshot = { schemaVersion: 2, config: { target, goal: 'Inspect saved navigation evidence', criteria: [{ id: 'navigation', text: 'Check the original navigation click', delivery: { kind: 'source', sourceTypes: ['test'], sourceRefs: [{ type: 'test', id: 'run' }] } }] },
  delivery: { schemaVersion: DELIVERY_POLICY_VERSION, complete: true, criteria: [{ criterionId: 'navigation', complete: true, gaps: [] }], cases: [], gaps: [] },
  tasks: [{ id: 'execution', criterionIds: ['navigation'], sources: [{ schemaVersion: 2, sourceType: 'test', sourceId: 'run', attemptId: 'run', target, startedAt: '2026-10-06T10:00:00Z', finishedAt: '2026-10-06T10:01:00Z', status: 'completed', summary: 'Synthetic executor claim', limitations: [],
    claims: [{ id: 'step-1', requirement: 'Click original navigation link', reportedStatus: 'mismatch', reportedActual: 'FULL_ORIGINAL_NEGATIVE_CLAIM' }],
    assessment: { reviewerVersion: REVIEWER_VERSION, stale: false, verdict: 'supported', findings: [{ requirementId: 'step-1', verdict: 'supported', explanation: 'FULL_REVIEW_EXPLANATION', evidenceIds: ['trace', 'image'] }] },
    evidence: ['trace', 'image', 'unread'].map(id => ({ id, title: `Metadata for ${id}`, kind: id === 'image' ? 'image' : 'text', hash: `hash-${id}`, excerpt: 'UNREAD_EXCERPT_NEVER_CONSTITUTES_READING', origin: 'tool', evidencePolicyVersion: 2, observedAt, provenance: { version: 1, origin: 'tool', producer: id === 'image' ? 'test-capture' : 'browser-action', sourceType: 'test', sourceId: 'run', observedAt, sha256: id === 'image' ? imageDigest : textDigest } })) }] }] };

// The provider returns only the current wire; legacy ReportDraft remains an
// internal validator fixture, never accepted as new physical model output.
const checkRef = JSON.stringify(['test', 'run', null, 'run', 'step-1']);
const writerWire = draft => ({ checkAssessments: draft.findings[0].evidenceIds.length ? [partsRow({ checkRef, relation: 'supports', text: draft.findings[0].conclusion, evidenceIds: [...draft.findings[0].evidenceIds] })] : [],
  findings: draft.findings.map(({ criterionId, verdict }) => ({ criterionId, verdict, factualNotes: [] })) });
const expectedFindings = draft => draft.findings.map(({criterionId,verdict,conclusion,evidenceIds}, index) => ({criterionId,verdict,observations: index === 0 && evidenceIds.length ? [{text:conclusion,evidenceIds:[...evidenceIds],subject:{checkRef,relation:'supports'}}] : []}));

function response(message, usage = { prompt_tokens: 10, completion_tokens: 5 }, finish = 'stop') {
  return new Response(JSON.stringify({ id: 'synthetic', created: 0, model: 'fixture', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }], usage }), { headers: { 'content-type': 'application/json' } });
}
test('actual SDK reporter deterministically reads full text and pixels before its single writer, with unchanged criteria', async () => {
  const previousFetch = globalThis.fetch, previousKey = process.env.GRUNDEN_API_TOKEN;
  const requests = [], reads = []; let admissions = 0, measured;
  process.env.GRUNDEN_API_TOKEN = 'synthetic-fixture-key';
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.grunden.ai/v1/chat/completions');
    const body = JSON.parse(options.body); requests.push(body);
    assert.equal(requests.length, 1, 'No reader model, extra transport or SDK retries');
    return response({ role: 'assistant', content: JSON.stringify(writerWire(draft)) });
  };
  try {
    const result = await writeMissionReport(snapshot, async id => { reads.push(id); return id === 'trace' ? { id, text: fullText, digest: textDigest, origin: 'tool' } : { id, image: { data: pixels, mediaType: 'image/png' }, digest: imageDigest, origin: 'tool' }; }, AbortSignal.timeout(5000), {
      maxTokens: 100000, maxToolCalls: 2, beforeModel: async () => { admissions++; }, onUsage: value => { measured = value; },
    });
    assert.deepEqual(reads.sort(), ['image', 'trace']); assert.deepEqual(result.draft.findings.map(({ criterionId, verdict, observations }) => ({ criterionId, verdict, observations })), expectedFindings(draft));
    assert.equal(admissions, 3); assert.equal(measured.providerCalls, 1); assert.equal(measured.totalTokens, 15);
    assert.equal(result.usage.steps, 1); assert.equal(result.usage.toolCalls, 2);
    const writer = requests[0], content = writer.messages.at(-1).content;
    const parts = content.filter(part => part.type === 'text').map(part => part.text);
    const writerContext = JSON.parse(parts[0]);
    assert.deepEqual(writerContext.criteria, snapshot.config.criteria);
    assert.deepEqual(writerContext.findingConstraints[0].allowedVerdicts, ['supported', 'needs_evidence', 'contradicted']);
    assert.equal(writerContext.sources[0].reportedClaims.basis, 'executor_claims_not_observation_bytes');
    assert.deepEqual(writerContext.sources[0].reportedClaims.items, snapshot.tasks[0].sources[0].claims);
    assert.equal(writerContext.sources[0].assessment, undefined);
    assert.equal(writerContext.sources[0].unreadEvidenceCount, undefined);
    assert.deepEqual(writerContext.evidenceSelection.readEvidenceIds, ['trace', 'image']);
    assert.ok(parts.some(part => { try { return JSON.parse(part).text === fullText; } catch { return false; } }));
    assert.ok(content.some(part => part.type === 'image_url' && part.image_url.url.endsWith(pixels)));
    assert.ok(!JSON.stringify(writer).includes('UNREAD_EXCERPT_NEVER_CONSTITUTES_READING'));
  } finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.GRUNDEN_API_TOKEN; else process.env.GRUNDEN_API_TOKEN = previousKey; }
});

test('lost admission between deterministic reads prevents the next read and every provider call', async () => {
  const previousFetch = globalThis.fetch, previousKey = process.env.GRUNDEN_API_TOKEN;
  let requests = 0, admissions = 0, measured, toolCalls; const reads = [];
  process.env.GRUNDEN_API_TOKEN = 'synthetic-fixture-key';
  globalThis.fetch = async () => { requests++; throw new Error('Must not invoke provider'); };
  try {
    await assert.rejects(writeMissionReport(snapshot, async id => { reads.push(id); return { id, text: fullText }; }, AbortSignal.timeout(5000), {
      beforeModel: async () => { if (++admissions === 2) throw new Error('Lost report lease'); },
      onUsage: (value, calls) => { measured = value; toolCalls = calls; },
    }), /Lost report lease/);
    assert.deepEqual(reads, ['trace']); assert.equal(requests, 0); assert.equal(toolCalls, 1);
    assert.equal(measured.providerCalls, 0); assert.equal(measured.totalTokens, 0);
  } finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.GRUNDEN_API_TOKEN; else process.env.GRUNDEN_API_TOKEN = previousKey; }
});

test('limited and unavailable reads remain recorded outside model context and cannot be offered as citations', async () => {
  const previousFetch = globalThis.fetch, previousKey = process.env.GRUNDEN_API_TOKEN;
  let request; const reads = [];
  process.env.GRUNDEN_API_TOKEN = 'synthetic-fixture-key';
  const incomplete = { ...draft, findings: [{ ...draft.findings[0], verdict: 'needs_evidence', evidenceIds: [] }] };
  globalThis.fetch = async (_url, options) => { request = JSON.parse(options.body); return response({ role: 'assistant', content: JSON.stringify(writerWire(incomplete)) }); };
  try {
    const result = await writeMissionReport(snapshot, async id => { reads.push(id); return id === 'trace' ? { id, limited: true, text: 'Partial source' } : { id, unavailable: true, reason: 'Missing bytes' }; }, AbortSignal.timeout(5000), { maxToolCalls: 2 });
    assert.deepEqual(result.draft.findings.map(({ criterionId, verdict, observations }) => ({ criterionId, verdict, observations })), expectedFindings(incomplete)); assert.deepEqual(reads, ['trace', 'image']);
    const context = JSON.parse(request.messages.at(-1).content[0].text);
    assert.deepEqual(context.evidenceSelection.readEvidenceIds, []);
    assert.equal(context.evidenceSelection.incompleteReadIds, undefined);
    assert.deepEqual(context.sources, []);
    assert.deepEqual(context.criteria, snapshot.config.criteria);
    assert.equal(request.response_format.json_schema.schema.properties.findings.items.properties.factualNotes.maxItems, 0);
  } finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.GRUNDEN_API_TOKEN; else process.env.GRUNDEN_API_TOKEN = previousKey; }
});

test('a wrong read identity fails closed before the writer, preserving the attempted-read count', async () => {
  const previousFetch = globalThis.fetch, previousKey = process.env.GRUNDEN_API_TOKEN;
  let requests = 0, toolCalls;
  process.env.GRUNDEN_API_TOKEN = 'synthetic-fixture-key';
  globalThis.fetch = async () => { requests++; throw new Error('Must not invoke provider'); };
  try {
    await assert.rejects(writeMissionReport(snapshot, async () => ({ id: 'another-source', text: fullText }), AbortSignal.timeout(5000), { onUsage: (_value, calls) => { toolCalls = calls; } }), /different identity/);
    assert.equal(requests, 0); assert.equal(toolCalls, 1);
  } finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.GRUNDEN_API_TOKEN; else process.env.GRUNDEN_API_TOKEN = previousKey; }
});

test('zero read allowance preserves all criteria and rejects a conclusive response without rewriting it', async () => {
  const previousFetch = globalThis.fetch, previousKey = process.env.GRUNDEN_API_TOKEN;
  let request, reads = 0, measured, calls;
  process.env.GRUNDEN_API_TOKEN = 'synthetic-fixture-key';
  const unsupported = { ...draft, findings: [{ ...draft.findings[0], evidenceIds: [] }] };
  globalThis.fetch = async (_url, options) => { request = JSON.parse(options.body); return response({ role: 'assistant', content: JSON.stringify(writerWire(unsupported)) }); };
  try {
    await assert.rejects(writeMissionReport(snapshot, async () => { reads++; throw new Error('No allowance'); }, AbortSignal.timeout(5000), { maxToolCalls: 0, onUsage: (value, count) => { measured = value; calls = count; } }));
    assert.equal(reads, 0); assert.equal(calls, 0); assert.equal(measured.providerCalls, 1); assert.equal(measured.totalTokens, 15);
    const context = JSON.parse(request.messages.at(-1).content[0].text);
    assert.deepEqual(context.criteria, snapshot.config.criteria);
    assert.equal(context.evidenceSelection.omittedCandidateCount, undefined);
    assert.deepEqual(context.sources, []);
    assert.deepEqual(context.findingConstraints[0].allowedVerdicts, ['needs_evidence']);
    assert.equal(unsupported.findings[0].verdict, 'supported', 'The invalid model response is rejected, never relabelled');
    assert.throws(() => validateReport(snapshot, unsupported, new Set()), /requires read evidence/);
  } finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.GRUNDEN_API_TOKEN; else process.env.GRUNDEN_API_TOKEN = previousKey; }
});

test('actual SDK receives per-criterion verdict constraints and returns a valid partial report without rewriting a proven negative', async () => {
  const previousFetch = globalThis.fetch, previousKey = process.env.GRUNDEN_API_TOKEN;
  const input = structuredClone(snapshot);
  input.config.criteria.push({ ...structuredClone(input.config.criteria[0]), id: 'incomplete', text: 'Another requested delivery remains incomplete' });
  input.tasks[0].criterionIds.push('incomplete');
  input.delivery.complete = false;
  input.delivery.criteria.push({ criterionId: 'incomplete', complete: false, gaps: [{ code: 'check_missing', message: 'An original checkpoint was not performed' }] });
  const partial = { ...draft, findings: [...draft.findings, { ...draft.findings[0], criterionId: 'incomplete', verdict: 'needs_evidence', conclusion: 'The original negative remains proven, but another checkpoint was not performed.' }] };
  let request, transports = 0;
  const reads = new Map();
  process.env.GRUNDEN_API_TOKEN = 'synthetic-fixture-key';
  globalThis.fetch = async (_url, options) => { transports++; request = JSON.parse(options.body); return response({ role: 'assistant', content: JSON.stringify(writerWire(partial)) }); };
  try {
    const result = await writeMissionReport(input, async id => {
      const value = id === 'image' ? { id, image: { data: pixels, mediaType: 'image/png' }, digest: imageDigest } : { id, text: fullText, digest: textDigest };
      reads.set(id, value); return value;
    }, AbortSignal.timeout(5000), { maxToolCalls: 2 });
    assert.equal(transports, 1); assert.deepEqual(result.draft.findings.map(({ criterionId, verdict, observations }) => ({ criterionId, verdict, observations })), expectedFindings(partial));
    const context = JSON.parse(request.messages.at(-1).content[0].text);
    assert.deepEqual(context.findingConstraints.map(c => c.allowedVerdicts), [['supported', 'needs_evidence', 'contradicted'], ['needs_evidence', 'contradicted']]);
    const variants = request.response_format.json_schema.schema.properties.findings.items.oneOf;
    assert.equal(variants.length, 2);
    assert.deepEqual(variants[1].properties.verdict.enum, ['needs_evidence', 'contradicted']);
    assert.doesNotThrow(() => validateReport(input, result.draft, new Set(reads.keys()), reads));
    assert.equal(result.draft.findings[0].observations[0].text, draft.findings[0].conclusion);
  } finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.GRUNDEN_API_TOKEN; else process.env.GRUNDEN_API_TOKEN = previousKey; }
});

test('actual SDK rejects supported for incomplete delivery after one paid call and preserves usage', async () => {
  const previousFetch = globalThis.fetch, previousKey = process.env.GRUNDEN_API_TOKEN;
  const input = structuredClone(snapshot); input.delivery.complete = false; input.delivery.criteria[0].complete = false;
  let request, transports = 0, measured, calls;
  process.env.GRUNDEN_API_TOKEN = 'synthetic-fixture-key';
  globalThis.fetch = async (_url, options) => { transports++; request = JSON.parse(options.body); return response({ role: 'assistant', content: JSON.stringify(writerWire(draft)) }); };
  try {
    await assert.rejects(writeMissionReport(input, async id => ({ id, text: fullText, digest: id === 'image' ? imageDigest : textDigest }), AbortSignal.timeout(5000), {
      maxToolCalls: 2, onUsage: (value, count) => { measured = value; calls = count; },
    }));
    assert.equal(transports, 1); assert.equal(calls, 2); assert.equal(measured.providerCalls, 1); assert.equal(measured.totalTokens, 15);
    assert.deepEqual(JSON.parse(request.messages.at(-1).content[0].text).findingConstraints[0].allowedVerdicts, ['needs_evidence', 'contradicted']);
    assert.equal(draft.findings[0].verdict, 'supported', 'Rejected response is not silently converted');
  } finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.GRUNDEN_API_TOKEN; else process.env.GRUNDEN_API_TOKEN = previousKey; }
});

test('reporter rejection preserves successful reads and unknown provider usage without a second model call', async () => {
  const previousFetch = globalThis.fetch, previousKey = process.env.GRUNDEN_API_TOKEN;
  let requests = 0, measured, toolCalls;
  process.env.GRUNDEN_API_TOKEN = 'synthetic-fixture-key';
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ error: { message: 'Synthetic rate limit' } }), { status: 429, headers: { 'content-type': 'application/json' } }); };
  try {
    await assert.rejects(writeMissionReport(snapshot, async id => ({ id, text: fullText }), AbortSignal.timeout(5000), {
      maxToolCalls: 2, onUsage: (value, calls) => { measured = value; toolCalls = calls; },
    }), error => error.statusCode === 429);
    assert.equal(requests, 1); assert.equal(toolCalls, 2); assert.equal(measured.providerCalls, 1);
    assert.equal(measured.unknownCalls, 1); assert.equal(measured.totalTokens, null);
  } finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.GRUNDEN_API_TOKEN; else process.env.GRUNDEN_API_TOKEN = previousKey; }
});

test('429 without a wire usage receipt stays one unknown invocation and cannot be replaced by a second transport', async () => {
  let transports = 0;
  const provider = createOpenAICompatible({ name: 'synthetic', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'fixture', fetch: async () => { transports++; return new Response(JSON.stringify({ error: { message: 'Synthetic rate limit' } }), { status: 429, headers: { 'content-type': 'application/json' } }); } });
  const meter = meteredModel(provider('fixture'), undefined, { maxTokens: 100000 });
  await assert.rejects(generateText({ model: meter.model, prompt: 'Synthetic', maxRetries: 0 }), error => error.statusCode === 429);
  assert.equal(transports, 1); assert.equal(meter.usage().providerCalls, 1); assert.equal(meter.usage().unknownCalls, 1); assert.equal(meter.usage().totalTokens, null);
  await assert.rejects(generateText({ model: meter.model, prompt: 'Synthetic retry', maxRetries: 0 }), /previous usage unknown/);
  assert.equal(transports, 1); assert.equal(meter.usage().providerCalls, 1);
});
