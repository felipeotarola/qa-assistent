import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { reportBarrierFetch } from './helpers/report-fault-provider.mjs';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) { const url = new URL(`${specifier}.ts`, context.parentURL); if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }; }
  return next(specifier, context);
} });
const { writeMissionReport } = await import('../agent/lib/mission-reporter.ts'); hooks.deregister();
const hash = value => createHash('sha256').update(value).digest('hex');

test('real installed SDK reporter is intercepted only after its actual text and pixel reads, without changing provider usage', async () => {
  const oldFetch = globalThis.fetch, oldToken = process.env.GRUNDEN_API_TOKEN;
  const text = 'ACTUAL SYNTHETIC TEXT', pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1EAAAAASUVORK5CYII=', 'base64');
  const target = { environment: 'fixture', url: 'https://fixture.test', revision: 'fixture' }, at = '2026-10-06T10:00:30Z';
  const snapshot = { schemaVersion: 2, missionId: 'mission', workspaceId: 'workspace', revision: 1, inputFingerprint: 'a'.repeat(64),
    config: { target, criteria: [{ id: 'original', text: 'Original requirement', delivery: { kind: 'source', sourceTypes: ['test'], sourceRefs: [{ type: 'test', id: 'run' }] } }] },
    tasks: [{ id: 'task', criterionIds: ['original'], sources: [{ schemaVersion: 2, sourceType: 'test', sourceId: 'run', target, startedAt: '2026-10-06T10:00:00Z', finishedAt: '2026-10-06T10:01:00Z',
      evidence: ['text', 'image'].map(id => ({ id, itemId: id, kind: id, origin: 'tool', evidencePolicyVersion: 2, title: id, hash: hash(id), observedAt: at,
        provenance: { version: 1, origin: 'tool', producer: id === 'image' ? 'test-capture' : 'browser-action', sourceType: 'test', sourceId: 'run', observedAt: at, sha256: hash(id === 'image' ? pixels : text) } })) }] }] };
  const draft = { summary: 'Synthetic result only', findings: [{ criterionId: 'original', verdict: 'needs_evidence', conclusion: 'Original report', evidenceIds: ['text', 'image'], nextStep: '' }], limitations: [] };
  const wire = { findings: draft.findings.map(({ criterionId, verdict, conclusion, evidenceIds }) => ({ criterionId, verdict, observations: [{ text: conclusion, evidenceIds }] })) };
  const reads = []; let physical = 0, held;
  process.env.GRUNDEN_API_TOKEN = 'synthetic-test-token';
  globalThis.fetch = reportBarrierFetch(async () => {
    physical++; assert.deepEqual([...reads].sort(), ['image', 'text']);
    return new Response(JSON.stringify({ id: 'synthetic', created: 0, model: 'fixture', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(wire) }, finish_reason: 'stop' }], usage: { prompt_tokens: 23, completion_tokens: 7 } }), { headers: { 'content-type': 'application/json' } });
  }, { match: async identity => identity.missionId === 'mission', afterResponse: async value => { held = value; return { released: true, requestSha256: value.requestSha256 }; } });
  try {
    const result = await writeMissionReport(snapshot, async id => { reads.push(id); return id === 'text' ? { id, text, digest: hash(text) } : { id, image: { data: pixels.toString('base64'), mediaType: 'image/png' }, digest: hash(pixels) }; }, AbortSignal.timeout(5000));
    assert.equal(physical, 1); assert.equal(held?.evidence.length, 2); assert.equal(result.usage.provider.totalTokens, 30); assert.deepEqual(result.draft.findings.map(({ criterionId, verdict, observations }) => ({ criterionId, verdict, observations })), wire.findings);
    assert.deepEqual(result.draft.findings[0].evidenceIds, draft.findings[0].evidenceIds);
    assert.ok(!JSON.stringify(held).includes(text) && !JSON.stringify(held).includes(pixels.toString('base64')));
  } finally { globalThis.fetch = oldFetch; if (oldToken === undefined) delete process.env.GRUNDEN_API_TOKEN; else process.env.GRUNDEN_API_TOKEN = oldToken; }
});
