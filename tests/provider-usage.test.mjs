import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { openAIWireUsage, sumProviderUsage, combineProviderUsage, providerUsageSchema } from '../shared/provider-usage.ts';
import { meteredModel } from '../agent/lib/model-usage.ts';

const full = { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 8 } };
function fixture(receipts, beforeCall) {
  let calls = 0;
  const provider = createOpenAICompatible({ name: 'local-fixture', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'fixture-only', fetch: async (url) => {
    assert.equal(String(url), 'http://127.0.0.1:1/v1/chat/completions');
    const usage = receipts[calls++];
    if (usage === 'fail') return new Response(JSON.stringify({ error: { message: 'synthetic unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'fixture', created: 0, model: 'fixture', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'observed' }, finish_reason: 'stop' }], ...(usage === undefined ? {} : { usage }) }), { headers: { 'content-type': 'application/json' } });
  } });
  const meter = meteredModel(provider('fixture'), beforeCall);
  return { ...meter, calls: () => calls, run: (maxRetries = 0) => generateText({ model: meter.model, prompt: 'Local transport fixture', maxRetries }) };
}

test('wire usage rejects normalized placeholders and retains real zero', () => {
  assert.deepEqual(openAIWireUsage({ inputTokens: { total: 0 }, outputTokens: { total: 0 } }), { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null });
  assert.deepEqual(openAIWireUsage({ raw: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: null });
  for (const bad of [-1, 0.5, '12', Number.MAX_SAFE_INTEGER + 1, NaN]) assert.equal(openAIWireUsage({ raw: { prompt_tokens: bad } }).inputTokens, null);
});
test('cached input is a subset; missing cache is unknown; a meter with no calls knows zero', () => {
  const first = sumProviderUsage([{ ...openAIWireUsage({ raw: full }), durationMs: 4 }]);
  assert.equal(first.totalTokens, 15); assert.equal(first.cacheReadTokens, 8); assert.equal(first.cacheWriteTokens, null);
  const mixed = combineProviderUsage([first, sumProviderUsage([{ ...openAIWireUsage({ raw: { prompt_tokens: 2, completion_tokens: 1 } }), durationMs: 6 }])]);
  assert.equal(mixed.totalTokens, 18); assert.equal(mixed.providerCalls, 2); assert.equal(mixed.cacheReadTokens, null); assert.equal(mixed.durationMs, 10);
  assert.equal(sumProviderUsage([]).totalTokens, 0);
});
test('malformed cache and numeric overflow settle as valid unknown measurements', () => {
  const malformedCache = sumProviderUsage([{ ...openAIWireUsage({ raw: { prompt_tokens: 2, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 3 } } }), durationMs: 1 }]);
  assert.equal(malformedCache.cacheReadTokens, null); assert.equal(malformedCache.totalTokens, 3);
  providerUsageSchema.parse(malformedCache);
  const oversized = sumProviderUsage([{ ...openAIWireUsage({ raw: { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 } }), durationMs: 1 }]);
  assert.equal(oversized.totalTokens, null); assert.equal(oversized.unknownCalls, 1); providerUsageSchema.parse(oversized);
  const call = { ...openAIWireUsage({ raw: { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 0 } }), durationMs: 1 };
  const aggregate = sumProviderUsage([call, call]);
  assert.equal(aggregate.providerCalls, 2); assert.equal(aggregate.unknownCalls, 2); assert.equal(aggregate.totalTokens, null); providerUsageSchema.parse(aggregate);
});
for (const [name, wire, expected] of [
  ['complete', full, [12, 3, 15, 8, 0]],
  ['missing input', { completion_tokens: 3 }, [null, 3, null, null, 1]],
  ['missing output', { prompt_tokens: 12 }, [12, null, null, null, 1]],
  ['no usage', undefined, [null, null, null, null, 1]],
  ['explicit zero', { prompt_tokens: 0, completion_tokens: 0 }, [0, 0, 0, null, 0]],
]) test(`installed provider meter preserves ${name} wire receipt`, async () => {
  const f = fixture([wire]); await f.run(); const u = f.usage();
  assert.deepEqual([u.inputTokens, u.outputTokens, u.totalTokens, u.cacheReadTokens, u.unknownCalls], expected);
  assert.equal(f.calls(), 1); assert.equal(u.providerCalls, 1); assert.ok(u.durationMs >= 0);
});
test('each actual SDK retry is counted; a failed call prevents a false complete total', async () => {
  const f = fixture(['fail', full]); await f.run(1); const u = f.usage();
  assert.equal(f.calls(), 2); assert.equal(u.providerCalls, 2); assert.equal(u.unknownCalls, 1); assert.equal(u.totalTokens, null);
});
test('admission denial occurs before transport and does not fabricate a provider call', async () => {
  const f = fixture([full], async () => { throw new Error('lease expired'); });
  await assert.rejects(f.run(), /lease expired/); assert.equal(f.calls(), 0); assert.equal(f.usage().providerCalls, 0);
  assert.equal(f.usage().totalTokens, 0); assert.equal(f.usage().unknownCalls, 0);
});
test('separate reader/writer calls share a measured workflow total without duplicating cached input', async () => {
  let admitted = 0;
  const f = fixture([full, full], async () => { admitted++; }); await f.run(); await f.run();
  assert.equal(admitted, 2); assert.equal(f.usage().totalTokens, 30); assert.equal(f.usage().cacheReadTokens, 16);
});
