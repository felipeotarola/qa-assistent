import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { APICallError, generateText, streamText, wrapLanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { providerPacingInterval, providerRetryAfter, providerPacingRequestSchema } from '../shared/provider-pacing.ts';
import { waitForProviderTurn, noteProviderRateLimit, providerPacingMiddleware } from '../agent/lib/provider-pacing.ts';
import { meteredModel } from '../agent/lib/model-usage.ts';

const saved = Object.fromEntries(['GRUNDEN_MIN_REQUEST_INTERVAL_MS', 'GRUNDEN_API_TOKEN', 'INTERNAL_API_SECRET', 'APP_URL'].map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
function enabled() {
  process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS = '6000';
  process.env.GRUNDEN_API_TOKEN = 'synthetic-pacer-only'; process.env.INTERNAL_API_SECRET = 'synthetic-internal';
  process.env.APP_URL = 'http://127.0.0.1:1';
}
function reply(value) { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); }
function model(beforeCall, fail = false) {
  let count = 0;
  const provider = createOpenAICompatible({ name: 'fixture', baseURL: 'http://synthetic.invalid/v1', apiKey: 'fixture-only', fetch: async () => {
    count++;
    if (fail) return new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'synthetic rejection' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '27' } });
    return reply({ id: 'fixture', created: 0, model: 'glm-5.3', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'synthetic' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } });
  } });
  const meter = meteredModel(provider.chatModel('glm-5.3'), beforeCall, { maxTokens: 100000 });
  return { ...meter, count: () => count, run: signal => generateText({ model: meter.model, prompt: 'Synthetic transport fixture', maxRetries: 0, abortSignal: signal }) };
}

test('configuration is opt-in and strict; headers cannot request an unbounded cooldown', () => {
  for (const [value, expected] of [[undefined, 0], ['', 0], ['0', 0], ['6000', 6000], ['30000', 30000]]) assert.equal(providerPacingInterval(value), expected);
  for (const value of ['-1', '30001', '1.5', 'Infinity', '6e3', 'null']) assert.throws(() => providerPacingInterval(value));
  for (const [value, expected] of [['27', 27000], ['0.1', 100], ['999999', 300000], ['-1', null], ['Infinity', null], ['private body', null]]) assert.equal(providerRetryAfter({ 'Retry-After': value }), expected);
  assert.equal(providerRetryAfter({ 'retry-after': 'Mon, 05 Oct 2026 20:00:27 GMT' }, Date.parse('2026-10-05T20:00:00Z')), 27000);
  assert.equal(providerPacingRequestSchema.safeParse({ action: 'reserve', model: 'anything', credentialHash: 'a'.repeat(64), intervalMs: 6000 }).success, false);
});
test('default disabled pacing does not use the app API or require credentials', async () => {
  delete process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS; delete process.env.GRUNDEN_API_TOKEN;
  globalThis.fetch = () => { throw new Error('Unexpected API'); };
  await waitForProviderTurn('fixture-model');
  const m = model(); await m.run(); assert.equal(m.count(), 1); assert.equal(m.usage().totalTokens, 3);
});
test('a cancelled waiter never starts the provider or admission ledger', async () => {
  enabled(); let admission = 0, reservations = 0;
  globalThis.fetch = async () => { reservations++; return reply({ allowed: false, waitMs: 1000 }); };
  const m = model(async () => { admission++; }), abort = new AbortController();
  const pending = m.run(abort.signal); setTimeout(() => abort.abort(), 20);
  await assert.rejects(pending); assert.equal(reservations, 1); assert.equal(admission, 0); assert.equal(m.count(), 0); assert.equal(m.usage().providerCalls, 0);
});

test('a valid 30s slot is queued rather than immediately failing its admission window', async () => {
  enabled(); let admission = 0, reservations = 0;
  globalThis.fetch = async () => { reservations++; return reply({ allowed: false, waitMs: 30000 }); };
  const m = model(async () => { admission++; }), abort = new AbortController();
  const reason = new Error('Caller deadline while queued');
  const pending = m.run(abort.signal); setTimeout(() => abort.abort(reason), 25);
  await assert.rejects(pending, error => error === reason || error.cause === reason);
  assert.equal(reservations, 1); assert.equal(admission, 0);
  assert.equal(m.count(), 0); assert.equal(m.usage().providerCalls, 0);
});

test('repeated contended slots preserve an overall bound and never start the model early', async (t) => {
  enabled(); let elapsed = 0, reservations = 0, admission = 0;
  // Advance monotonic time between short real waits; do not alter wall-clock
  // timers or production timeout constants to make this boundary test fast.
  t.mock.method(performance, 'now', () => elapsed);
  globalThis.fetch = async () => { reservations++; elapsed += 31000; return reply({ allowed: false, waitMs: 1 }); };
  const m = model(async () => { admission++; });
  await assert.rejects(m.run(), /bounded model admission window/);
  assert.equal(reservations, 4); assert.equal(admission, 0);
  assert.equal(m.count(), 0); assert.equal(m.usage().providerCalls, 0);
});

test('admission beyond the old 30s window succeeds only after a current permission check', async (t) => {
  enabled(); let elapsed = 0, reservations = 0, admission = 0;
  t.mock.method(performance, 'now', () => elapsed);
  globalThis.fetch = async () => {
    if (++reservations === 1) { elapsed = 31000; return reply({ allowed: false, waitMs: 1 }); }
    return reply({ allowed: true });
  };
  const m = model(async () => { admission++; });
  await m.run(); assert.equal(reservations, 2); assert.equal(admission, 1);
  assert.equal(m.count(), 1); assert.equal(m.usage().providerCalls, 1); assert.equal(m.usage().totalTokens, 3);
});

test('missing Retry-After keeps the 30s cooldown independent of the admission limit', async () => {
  enabled(); let input;
  globalThis.fetch = async (_url, options) => { input = JSON.parse(options.body); return reply({ recorded: true }); };
  await noteProviderRateLimit('glm-5.3', new APICallError({ message: 'Synthetic rejection', url: 'http://synthetic.invalid', requestBodyValues: {}, statusCode: 429 }));
  assert.equal(input.action, 'cooldown'); assert.equal(input.delayMs, 30000);
});
test('authority is checked after a wait and denies a newly expired lease', async () => {
  enabled(); let current = true, requests = 0;
  globalThis.fetch = async () => { if (++requests === 1) { current = false; return reply({ allowed: false, waitMs: 5 }); } return reply({ allowed: true }); };
  const m = model(async () => { if (!current) throw new Error('lease expired'); });
  await assert.rejects(m.run(), /lease expired/); assert.equal(requests, 2); assert.equal(m.count(), 0); assert.equal(m.usage().providerCalls, 0);
});
test('unavailable, malformed or overlong pacing never fabricates a physical call', async () => {
  enabled(); let admission = 0;
  for (const response of [() => { throw new Error('uncertain reserve acknowledgement'); }, () => reply({ allowed: true, extra: 'unexpected' }), () => reply({ allowed: false, waitMs: 300000 })]) {
    globalThis.fetch = async () => response(); const m = model(async () => { admission++; });
    await assert.rejects(m.run()); assert.equal(m.count(), 0); assert.equal(m.usage().providerCalls, 0); assert.equal(m.usage().totalTokens, 0);
  }
  assert.equal(admission, 0);
});
test('429 records unknown physical usage and shares cooldown without retrying the model', async () => {
  enabled(); const actions = [];
  globalThis.fetch = async (_url, options) => { const input = JSON.parse(options.body); actions.push(input); return reply(input.action === 'reserve' ? { allowed: true } : { recorded: true }); };
  const m = model(undefined, true); await assert.rejects(m.run(), error => APICallError.isInstance(error) && error.statusCode === 429);
  assert.equal(m.count(), 1); assert.equal(m.usage().providerCalls, 1); assert.equal(m.usage().unknownCalls, 1); assert.equal(m.usage().totalTokens, null);
  assert.deepEqual(actions.map(a => [a.action, a.delayMs]), [['reserve', undefined], ['cooldown', 27000]]);
  assert.ok(actions.every(a => !JSON.stringify(a).includes('synthetic-pacer-only')));
});
test('cooldown failure does not mask the original physical rejection or unknown usage', async () => {
  enabled(); globalThis.fetch = async (_url, options) => { if (JSON.parse(options.body).action === 'cooldown') throw new Error('cooldown unavailable'); return reply({ allowed: true }); };
  const m = model(undefined, true); await assert.rejects(m.run(), error => APICallError.isInstance(error) && error.statusCode === 429);
  assert.equal(m.usage().providerCalls, 1); assert.equal(m.usage().unknownCalls, 1); assert.equal(m.usage().totalTokens, null);
  await noteProviderRateLimit('glm-5.3', new Error('non-provider failure'));
});
test('V/Axel wrapper prevents installed SDK default retries after a physical429', async () => {
  enabled(); let calls = 0;
  globalThis.fetch = async (_url, options) => reply(JSON.parse(options.body).action === 'reserve' ? { allowed: true } : { recorded: true });
  const provider = createOpenAICompatible({ name: 'fixture', baseURL: 'http://synthetic.invalid/v1', apiKey: 'fixture', fetch: async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: 'PRIVATE PROVIDER RESPONSE', code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' } });
  } });
  const model = wrapLanguageModel({ model: provider.chatModel('glm-5.3'), middleware: providerPacingMiddleware() });
  // Deliberately leave the installed SDK's default retry count in effect.
  const { classifyModelCallError } = await import(new URL('./harness/model-call-error.js', import.meta.resolve('eve')));
  await assert.rejects(generateText({ model, prompt: 'Fixture' }), error => {
    assert.equal(APICallError.isInstance(error), false); assert.equal(error.cause, undefined); assert.doesNotMatch(error.message, /PRIVATE/);
    // Exact installed Eve behavior: no transient retry, but NOT a terminal
    // durable-task guarantee. V parks; task mode can durable-retry this error.
    assert.equal(classifyModelCallError(error), 'recoverable'); return true;
  });
  await assert.rejects(generateText({ model, prompt: 'Same instance cannot replay the call' }));
  assert.equal(calls, 1);
});
test('installed streaming SDK does not replay a429 start and later instance calls stay stopped', async () => {
  enabled(); let calls = 0;
  globalThis.fetch = async (_url, options) => reply(JSON.parse(options.body).action === 'reserve' ? { allowed: true } : { recorded: true });
  const provider = createOpenAICompatible({ name: 'fixture', baseURL: 'http://synthetic.invalid/v1', apiKey: 'fixture', fetch: async () => {
    calls++; return new Response(JSON.stringify({ error: { message: 'synthetic429' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' } });
  } });
  const model = wrapLanguageModel({ model: provider.chatModel('glm-5.3'), middleware: providerPacingMiddleware() });
  await assert.rejects(streamText({ model, prompt: 'Fixture', onError() {} }).text);
  await assert.rejects(streamText({ model, prompt: 'Same stopped instance', onError() {} }).text);
  assert.equal(calls, 1);
});
test('a shared bounded meter cannot race its allowance through concurrent admissions', async () => {
  delete process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS;
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { release = resolve; });
  const m = model(async () => { entered(); await hold; });
  const pending = m.run(); await ready;
  await assert.rejects(m.run(), /Concurrent calls/); assert.equal(m.count(), 0);
  release(); await pending; assert.equal(m.count(), 1); assert.equal(m.usage().providerCalls, 1);
});
