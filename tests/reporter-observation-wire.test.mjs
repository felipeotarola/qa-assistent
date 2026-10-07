import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateReport, assembleReport } from '../shared/mission-report.ts';
import { reportProviderIdentity } from './helpers/report-fault-provider.mjs';
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

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1EAAAAASUVORK5CYII=';
const text = 'ACTUAL_READ_BYTES [REDACTED] returned HTTP 404. '.repeat(25);
const digest = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const target = { environment: 'QA', url: 'https://unit.example.test/', revision: 'A' };
  const source = { schemaVersion: 2, sourceType: 'test', sourceId: 'run', status: 'completed', target, startedAt: '2026-10-06T00:00:00Z', finishedAt: '2026-10-06T00:01:00Z',
    summary: 'WRONG_UNREAD_DIAGNOSIS', limitations: ['OLD_FALSE_AVAILABILITY_TEXT'],
    claims: [{ id: 'step-1', requirement: 'Observe navigation destination', reportedStatus: 'mismatch', reportedActual: 'EXECUTOR_CLAIM_NOT_READ_BYTES' }],
    evidence: ['trace', 'image'].map(id => ({ id, kind: id === 'trace' ? 'text' : 'image', title: id, excerpt: 'METADATA_EXCERPT_NOT_READ', origin: 'tool', evidencePolicyVersion: 2,
      observedAt: '2026-10-06T00:00:30Z', provenance: { version: 1, origin: 'tool', producer: id === 'trace' ? 'browser-action' : 'test-capture', sourceType: 'test', sourceId: 'run', observedAt: '2026-10-06T00:00:30Z', sha256: digest(id === 'trace' ? text : Buffer.from(image, 'base64')) } })) };
  const criterion = { id: 'c', text: 'Inspect original navigation', delivery: { kind: 'source', sourceTypes: ['test'], sourceRefs: [{ type: 'test', id: 'run' }] } };
  const snapshot = { schemaVersion: 2, missionId: 'mission', workspaceId: 'workspace', revision: 7, inputFingerprint: 'a'.repeat(64), config: { title: 'QA report', goal: 'Inspect saved results', scope: 'Saved runs', target, criteria: [criterion, { ...criterion, id: 'partial' }] }, tasks: [{ id: 't', title: 'Execution', actor: 'browser', criterionIds: ['c', 'partial'], sources: [source] }],
    delivery: { schemaVersion: 3, complete: false, criteria: [{ criterionId: 'c', complete: true, gaps: [] }, { criterionId: 'partial', complete: false, gaps: [{ code: 'check_missing' }] }], cases: [] }, tests: [], metrics: [], gaps: [] };
  const reads = new Map([['trace', { id: 'trace', text, digest: digest(text) }], ['image', { id: 'image', image: { data: image, mediaType: 'image/png' }, digest: digest(Buffer.from(image, 'base64')) }]]);
  return { snapshot, reads };
}
const currentWire = { checkAssessments: [partsRow({ checkRef: JSON.stringify(['test','run',null,null,'step-1']), relation:'unresolved', text: 'The saved navigation returned HTTP 404.', evidenceIds: ['trace','image'] })], findings: [
  { criterionId: 'c', verdict: 'supported', factualNotes: [] },
  { criterionId: 'partial', verdict: 'needs_evidence', factualNotes: [] },
] };

function response(value) { return new Response(JSON.stringify({ id: 'fixture', model: 'fixture', object: 'chat.completion', created: 0, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 7 } }), { headers: { 'content-type': 'application/json' } }); }
async function transport(run, value = currentWire) {
  const previous = { fetch: globalThis.fetch, key: process.env.GRUNDEN_API_TOKEN, pacing: process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS };
  const requests = []; process.env.GRUNDEN_API_TOKEN = 'synthetic-private-test'; process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS = '0';
  globalThis.fetch = async (url, options) => { assert.equal(String(url), 'https://api.grunden.ai/v1/chat/completions'); requests.push(JSON.parse(options.body)); assert.equal(requests.length, 1); return response(value); };
  try { return await run(requests); }
  finally {
    globalThis.fetch = previous.fetch;
    for (const [name, old] of [['GRUNDEN_API_TOKEN', previous.key], ['GRUNDEN_MIN_REQUEST_INTERVAL_MS', previous.pacing]]) { if (old === undefined) delete process.env[name]; else process.env[name] = old; }
  }
}
test('installed SDK accepts the separate assessment contract after full byte reads, meters once and preserves original criteria', async () => transport(async requests => {
  const f = fixture(), readIds = [], admissions = []; let usage;
  const result = await writeMissionReport(f.snapshot, async id => { readIds.push(id); return f.reads.get(id); }, AbortSignal.timeout(5000), { maxToolCalls: 2, beforeModel: async () => { admissions.push(readIds.length); }, onUsage: value => { usage = value; } });
  assert.deepEqual(readIds.sort(), ['image', 'trace']); assert.equal(admissions.length, 3); assert.equal(requests.length, 1);
  assert.equal(usage.providerCalls, 1); assert.equal(usage.totalTokens, 27); assert.equal(result.usage.toolCalls, 2);
  const content = requests[0].messages.at(-1).content, context = JSON.parse(content[0].text);
  assert.deepEqual(context.criteria, f.snapshot.config.criteria);
  assert.equal(context.schemaVersion, 2); assert.equal(context.missionId, 'mission'); assert.equal(context.workspaceId, 'workspace'); assert.equal(context.revision, 7); assert.equal(context.inputFingerprint, 'a'.repeat(64));
  assert.deepEqual(context.evidenceSelection, { basis: 'metadata_selection_only', readEvidenceIds: ['trace', 'image'] });
  const boundRequest = reportProviderIdentity(JSON.stringify(requests[0]));
  assert.equal(boundRequest?.missionId, 'mission'); assert.equal(boundRequest?.workspaceId, 'workspace'); assert.equal(boundRequest?.revision, 7); assert.equal(boundRequest?.inputFingerprint, 'a'.repeat(64));
  assert.deepEqual(boundRequest?.evidence.map(item => item.id).sort(), ['image', 'trace']);
  assert.equal(context.sources[0].reportedClaims.basis, 'executor_claims_not_observation_bytes');
  assert.equal(context.sources[0].reportedClaims.items[0].reportedActual, 'EXECUTOR_CLAIM_NOT_READ_BYTES');
  assert.equal(context.sources[0].summary, undefined); assert.equal(context.sources[0].assessment, undefined);
  assert.ok(!JSON.stringify(requests).includes('WRONG_UNREAD_DIAGNOSIS')); assert.ok(!JSON.stringify(requests).includes('OLD_FALSE_AVAILABILITY_TEXT')); assert.ok(!JSON.stringify(requests).includes('METADATA_EXCERPT_NOT_READ'));
  assert.ok(content.some(part => part.type === 'text' && part.text.includes('ACTUAL_READ_BYTES'))); assert.ok(content.some(part => part.type === 'image_url' && part.image_url.url.endsWith(image)));
  const schema = requests[0].response_format.json_schema.schema; assert.deepEqual(Object.keys(schema.properties), ['findings', 'checkAssessments']);
  assert.equal(schema.properties.findings.items.oneOf.length, 2); assert.deepEqual(schema.properties.findings.items.oneOf[1].properties.verdict.enum, ['needs_evidence', 'contradicted']);
  assert.deepEqual(result.draft.findings[0].evidenceIds, ['trace', 'image']);
  assert.doesNotThrow(() => validateReport(f.snapshot, result.draft, new Set(f.reads.keys()), f.reads));
  const report = assembleReport(f.snapshot, result.draft, new Set(f.reads.keys()), f.reads);
  assert.equal(report.partial, true); assert.match(report.findings[0].observations[0].text, /HTTP 404/);
}));
test('old free-summary/conclusion writer format is rejected after one paid synthetic call', async () => transport(async requests => {
  const f = fixture(); let usage;
  await assert.rejects(writeMissionReport(f.snapshot, async id => f.reads.get(id), AbortSignal.timeout(5000), { maxToolCalls: 2, onUsage: value => { usage = value; } }));
  assert.equal(requests.length, 1); assert.equal(usage.providerCalls, 1); assert.equal(usage.totalTokens, 27);
}, { summary: 'Old free false availability', limitations: [], findings: [{ criterionId: 'c', verdict: 'supported', conclusion: 'Old format', evidenceIds: ['trace'], nextStep: 'Shrink scope' }, { criterionId: 'partial', verdict: 'needs_evidence', conclusion: 'Old format', evidenceIds: [], nextStep: '' }] }));
test('unavailable and limited reads do not leak partial bytes or diagnoses into the writer observation context', async () => transport(async requests => {
  const f = fixture(); const result = await writeMissionReport(f.snapshot, async id => id === 'trace' ? { id, text: 'PARTIAL_NOT_OBSERVATION', limited: true } : { id, unavailable: true, reason: 'PRIVATE_FAILURE_REASON' }, AbortSignal.timeout(5000), { maxToolCalls: 2 });
  const body = JSON.stringify(requests[0]); assert.ok(!body.includes('PARTIAL_NOT_OBSERVATION')); assert.ok(!body.includes('PRIVATE_FAILURE_REASON'));
  const context = JSON.parse(requests[0].messages.at(-1).content[0].text); assert.deepEqual(context.sources, []);
  assert.deepEqual(context.evidenceSelection, { basis: 'metadata_selection_only', readEvidenceIds: [] });
  assert.deepEqual(result.draft.findings.map(finding => finding.observations), [[], []]);
}, { checkAssessments: [], findings: [{ criterionId: 'c', verdict: 'needs_evidence', factualNotes: [] }, { criterionId: 'partial', verdict: 'needs_evidence', factualNotes: [] }] }));
