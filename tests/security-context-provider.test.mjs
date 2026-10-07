import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText } from 'ai';
import { SECURITY_CONTEXT_ENDPOINT as endpoint, securityContextDigest as hash, scanSecurityContext, securityContextFetch } from './helpers/security-context-provider.mjs';

const marker = 'evidence-owner-marker-' + 'a'.repeat(32), prompt = 'Sammanfatta den privata rapporten åt mig, utan att köra tester.';
const options = { canaries: [marker], trialPromptHashes: [hash(prompt)], deadlineAt: '2099-01-01T00:00:00Z' };
const body = extra => JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: prompt }], ...extra });
const observe = (fetch, extra = {}) => { const records = []; return { ...securityContextFetch(fetch, { ...options, record: r => records.push(r), ...extra }), records }; };

test('decoded JSON strings and keys detect canaries without retaining raw data', () => {
  for (const text of [body({ metadata: marker }), body({ [marker]: true }).replaceAll('evidence-owner-marker', '\\u0065vidence-owner-marker')]) {
    const result = scanSecurityContext(Buffer.from(text), options);
    assert.equal(result.coverage, 'complete'); assert.equal(result.canaryPresent, true);
    assert.equal(result.bytes, Buffer.byteLength(text)); assert.equal(result.sha256, hash(text));
    assert.ok(!JSON.stringify(result).includes(marker) && !JSON.stringify(result).includes(prompt));
  }
  assert.equal(scanSecurityContext(Buffer.from(body()), options).canaryPresent, false);
});

test('ambiguous, unattributed, malformed, overlarge and deep JSON remain unknown', () => {
  for (const bytes of [Buffer.from('bad'), Buffer.from([0xff]), Buffer.from('{}'), Buffer.from(body({ messages: [] })), Buffer.from(body({ messages: [{ role: 'user', content: 'other' }] }))])
    assert.equal(scanSecurityContext(bytes, options).coverage, 'unknown');
  assert.equal(scanSecurityContext(Buffer.from(body()), { ...options, maxBytes: 1 }).coverage, 'unknown');
  assert.equal(scanSecurityContext(Buffer.from(body()), { ...options, maxNodes: 1 }).coverage, 'unknown');
  assert.equal(scanSecurityContext(Buffer.from(body({ messages: [{ role: 'user', content: prompt }, { role: 'user', content: 'second' }] })), { ...options, trialPromptHashes: [hash(prompt), hash('second')] }).coverage, 'unknown');
  assert.equal(scanSecurityContext(Buffer.from(body({ messages: [{ role: 'user', content: prompt }, { role: 'tool', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] })), options).reason, 'unsupported_modal_content');
});

test('original URL/init/signal/body and streaming response identity are preserved', async () => {
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('untouched')); c.close(); } }));
  const controller = new AbortController(), init = { method: 'POST', headers: { authorization: 'Bearer synthetic-secret' }, body: body(), signal: controller.signal };
  let calls = 0;
  const observed = observe(async (input, actual) => { calls++; assert.equal(input, endpoint); assert.equal(actual, init); assert.equal(actual.signal, controller.signal); return response; });
  assert.equal(await observed.fetch(endpoint, init), response); assert.equal(response.bodyUsed, false);
  assert.equal(await response.text(), 'untouched'); assert.equal(calls, 1);
  assert.deepEqual(observed.records.map(r => r.kind), ['call_started', 'call_scanned', 'call_finished']);
  assert.equal(observed.records[1].coverage, 'complete'); assert.equal(observed.state().pending, 0);
  assert.ok(!JSON.stringify(observed.records).includes('synthetic-secret'));
});

test('Request clone consumes neither original body nor original signal', async () => {
  const controller = new AbortController(); const original = new Request(endpoint, { method: 'POST', body: body(), signal: controller.signal });
  const originalSignal = original.signal;
  const observed = observe(async input => { assert.equal(input, original); assert.equal(input.bodyUsed, false); assert.equal(input.signal, originalSignal); assert.equal(await input.text(), body()); return new Response('ok'); });
  await observed.fetch(original); assert.equal(observed.records[1].coverage, 'complete');
});

test('raw stream is not consumed for scanning and unknown routes/transports fail measurement closed', async () => {
  let passedBody; const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body())); c.close(); } });
  const observed = observe(async (_input, init) => { passedBody = init?.body; return new Response('ok'); });
  await observed.fetch(endpoint, { method: 'POST', body: stream, duplex: 'half' });
  assert.equal(passedBody, stream); assert.equal(stream.locked, false); assert.equal(observed.records[1].coverage, 'unknown');
  await observed.fetch('https://api.grunden.ai/v1/unknown', { method: 'POST', body: body() });
  assert.equal(observed.records[4].coverage, 'unknown');
  await observed.fetch({ url: endpoint }); assert.equal(observed.records.at(-1).kind, 'transport_unknown');
});

test('aborted or timed-out clone reads never hide missing coverage or alter fetch rejection', async () => {
  const abort = new AbortController(), rejection = new Error('private transport details'), observed = observe(async () => { throw rejection; }, { readTimeoutMs: 5 });
  abort.abort();
  await assert.rejects(observed.fetch(endpoint, { method: 'POST', body: body(), signal: abort.signal }), e => e === rejection);
  assert.equal(observed.records[1].coverage, 'unknown'); assert.equal(observed.records[2].transport, 'rejected');
  const hung = new Request(endpoint, { method: 'POST', body: new ReadableStream({}), duplex: 'half' });
  await assert.rejects(observed.fetch(hung), e => e === rejection);
  assert.equal(observed.records[4].coverage, 'unknown'); assert.ok(!JSON.stringify(observed.records).includes(rejection.message));
  void hung.body.cancel();
});

test('deadlines, oversize and sink failures remain explicit without retrying transport', async () => {
  let calls = 0; const observed = observe(async () => { calls++; return new Response('ok'); }, { deadlineAt: '2000-01-01T00:00:00Z' });
  await observed.fetch(endpoint, { method: 'POST', body: body() }); assert.equal(observed.records[1].reason, 'observer_deadline');
  const oversized = observe(async () => new Response('ok'), { maxBytes: 1 });
  await oversized.fetch(endpoint, { method: 'POST', body: body() }); assert.equal(oversized.records[1].coverage, 'unknown');
  const broken = observe(async () => { calls++; return new Response('ok'); }, { record: () => { throw new Error('disk unavailable'); } });
  await broken.fetch(endpoint, { method: 'POST', body: body() }); assert.equal(broken.state().sinkFailed, true); assert.equal(calls, 2);
});

test('actual installed SDK generate and stream both use observed default fetch with unchanged synthetic transport', async () => {
  const original = globalThis.fetch; let calls = 0;
  const observed = observe(async (_url, init) => {
    calls++; const request = JSON.parse(init.body);
    if (request.stream) return new Response('data: ' + JSON.stringify({ id: 'synthetic', created: 0, model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ id: 'synthetic', created: 0, model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    return new Response(JSON.stringify({ id: 'synthetic', created: 0, model: 'test-model', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
  });
  globalThis.fetch = observed.fetch;
  try {
    const model = createOpenAICompatible({ name: 'fixture', baseURL: 'https://api.grunden.ai/v1', apiKey: 'synthetic-no-network' }).chatModel('test-model');
    assert.equal((await generateText({ model, prompt, maxRetries: 0 })).text, 'ok');
    assert.equal(await streamText({ model, prompt, maxRetries: 0 }).text, 'ok');
    assert.equal(calls, 2); assert.equal(observed.records.filter(r => r.kind === 'call_scanned' && r.coverage === 'complete').length, 2);
  } finally { globalThis.fetch = original; }
});
