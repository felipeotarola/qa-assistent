import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { APICallError, generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { irisEventSchema, irisModelReceiptSchema, irisModelUsage, IRIS_MODEL_LEDGER_PREFIX as prefix } from '../shared/browser-job.ts';

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
after(() => hooks.deregister());
const { safeIrisProviderFailure, withIrisModelBudget } = await import('../agent/lib/iris-admission.ts');
const privateText = 'PRIVATE_BODY_COT_AND_CREDENTIAL_SENTINEL';
const failure = (extra = {}) => new APICallError({ message: privateText, url: 'https://never-request.invalid/private', requestBodyValues: { secret: privateText }, responseBody: privateText,
  statusCode: 429, responseHeaders: { 'retry-after': '12', authorization: privateText }, data: { error: { message: privateText, code: 'rate_limit_exceeded', param: privateText } }, ...extra });

test('provider diagnostic projects only fixed metadata and preserves Retry-After without authorizing a retry', () => {
  assert.deepEqual(safeIrisProviderFailure(failure(), 'request'), { kind: 'rate_limited', phase: 'request', outputObserved: false, status: 429, providerErrorCode: 'rate_limit_exceeded', retryAfterMs: 12000 });
  const unsafe = safeIrisProviderFailure(failure({ data: { error: { code: privateText } }, responseHeaders: { 'retry-after': privateText } }), 'request');
  assert.equal(unsafe.providerErrorCode, null); assert.equal(unsafe.retryAfterMs, null);
  assert.doesNotMatch(JSON.stringify(unsafe), /PRIVATE|credential|private/);
  assert.equal(safeIrisProviderFailure(failure({ data: { error: { code: 'insufficient_quota' } } }), 'request').providerErrorCode, 'insufficient_quota');
});

test('Retry-After accepts bounded seconds or an HTTP date, never an arbitrary value or infinite wait', () => {
  const now = Date.parse('2026-10-05T20:00:00Z');
  for (const [value, expected] of [['0', 0], ['0.1', 100], ['30', 30000], ['Mon, 05 Oct 2026 20:00:15 GMT', 15000], ['-1', null], ['90000', null], ['Infinity', null], ['2026-10-05', null]]) {
    assert.equal(safeIrisProviderFailure(failure({ responseHeaders: { 'Retry-After': value } }), 'request', false, now).retryAfterMs, expected);
  }
});

test('diagnostics retain compatibility with old receipts and reject freeform extras', () => {
  const value = { callId: randomUUID(), inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, durationMs: 1 };
  assert.doesNotThrow(() => irisModelReceiptSchema.parse(value));
  assert.throws(() => irisModelReceiptSchema.parse({ ...value, failure: { ...safeIrisProviderFailure(failure(), 'request'), body: privateText } }));
  assert.throws(() => irisModelReceiptSchema.parse({ ...value, failure: { ...safeIrisProviderFailure(failure(), 'request'), providerErrorCode: privateText } }));
});

function fixture(t, response) {
  const savedFetch = globalThis.fetch, savedUrl = process.env.APP_URL, savedSecret = process.env.INTERNAL_API_SECRET;
  process.env.APP_URL = 'http://127.0.0.1:1'; process.env.INTERNAL_API_SECRET = 'isolated-synthetic-no-network';
  const markers = [], events = [], counter = { calls: 0 }, actor = { jobId: randomUUID(), userId: randomUUID(), threadId: randomUUID(), sessionId: randomUUID() };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:1/api/internal/browser-job-event');
    const event = irisEventSchema.parse(JSON.parse(options.body)); events.push(event);
    if (event.kind === 'model_started') {
      if (irisModelUsage(markers).unknownCalls) return new Response('{}', { status: 409 });
      markers.push(`${prefix}start:${event.modelCallId}`);
    }
    if (event.kind === 'model_finished') markers.push(`${prefix}usage:${JSON.stringify(irisModelReceiptSchema.parse({ callId: event.modelCallId, ...event.modelUsage, durationMs: event.modelDurationMs, ...(event.modelFailure ? { failure: event.modelFailure } : {}) }))}`);
    return Response.json({ allowed: true });
  };
  t.after(() => {
    globalThis.fetch = savedFetch;
    if (savedUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = savedUrl;
    if (savedSecret === undefined) delete process.env.INTERNAL_API_SECRET; else process.env.INTERNAL_API_SECRET = savedSecret;
  });
  const auth = { authenticator: 'app', issuer: 'app', principalId: actor.userId, principalType: 'user', attributes: { browserWorker: 'iris', browserJobId: actor.jobId, browserThreadId: actor.threadId } };
  const ctx = { channel: { kind: 'channel:iris' }, session: { id: actor.sessionId, auth: { current: auth, initiator: auth } } };
  const provider = createOpenAICompatible({ name: 'synthetic-fixture', baseURL: 'http://127.0.0.1:2/v1', apiKey: 'local-fixture', fetch: async url => {
    assert.equal(String(url), 'http://127.0.0.1:2/v1/chat/completions'); counter.calls++; return response();
  } });
  const wrap = () => withIrisModelBudget(provider('fixture'), { data: { sequence: 0 } }, ctx);
  return { wrap, counter, events, usage: () => irisModelUsage(markers), receipts: () => markers.filter(value => value.startsWith(`${prefix}usage:`)).map(value => JSON.parse(value.slice(`${prefix}usage:`.length))) };
}
const prompt = [{ role: 'user', content: [{ type: 'text', text: 'Local synthetic transport only' }] }];
const rejected = () => new Response(JSON.stringify({ error: { message: privateText, code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '3' } });

for (const streaming of [false, true]) test(`installed provider ${streaming ? 'stream' : 'generate'} rejection saves safe 429 and unknown usage, with no SDK or fresh-wrapper retry`, async t => {
  const f = fixture(t, rejected);
  const run = () => streaming ? f.wrap().doStream({ prompt }) : generateText({ model: f.wrap(), prompt: 'Synthetic transport', maxRetries: 2 });
  await assert.rejects(run, error => /anropsgräns/.test(error.message) && !error.message.includes(privateText));
  assert.equal(f.counter.calls, 1); assert.equal(f.usage().tokens, null); assert.equal(f.usage().unknownCalls, 1);
  assert.deepEqual(f.receipts()[0].failure, { kind: 'rate_limited', phase: 'request', outputObserved: false, status: 429, providerErrorCode: 'rate_limit_exceeded', retryAfterMs: 3000 });
  await assert.rejects(run); assert.equal(f.counter.calls, 1);
  assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE_BODY|authorization|requestBody|responseBody/);
});

for (const withOutput of [false, true]) test(`installed provider in-stream error ${withOutput ? 'after output' : 'before output'} is sanitized and never retried`, async t => {
  const chunk = value => `data: ${JSON.stringify(value)}\n\n`;
  const f = fixture(t, () => new Response((withOutput ? chunk({ id: 'stream', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Observed text' } }] }) : '')
    + chunk({ error: { message: privateText, code: 'rate_limit_exceeded' } }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  const result = await f.wrap().doStream({ prompt }), parts = [];
  await assert.rejects(async () => { for await (const part of result.stream) parts.push(part); }, error => !error.message.includes(privateText) && /avbröts/.test(error.message));
  assert.equal(f.counter.calls, 1); assert.equal(f.usage().tokens, null);
  assert.equal(f.receipts()[0].failure.phase, 'stream'); assert.equal(f.receipts()[0].failure.outputObserved, withOutput);
  assert.equal(f.receipts()[0].failure.providerErrorCode, 'rate_limit_exceeded'); assert.equal(f.receipts()[0].failure.status, null);
  assert.doesNotMatch(JSON.stringify([...parts, ...f.events]), /PRIVATE_BODY/);
  await assert.rejects(f.wrap().doStream({ prompt })); assert.equal(f.counter.calls, 1);
});

test('complete provider finish remains measured and receives no synthetic failure on EOF', async t => {
  const f = fixture(t, () => new Response('data: ' + JSON.stringify({ id: 'stream', created: 0, model: 'fixture', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  const result = await f.wrap().doStream({ prompt }); for await (const part of result.stream) assert.ok(part.type);
  assert.equal(f.usage().tokens, 12); assert.equal(f.receipts().length, 1); assert.equal(f.receipts()[0].failure, undefined);
});
