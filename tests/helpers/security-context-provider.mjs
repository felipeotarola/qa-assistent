// Test-only passive observer. No app imports, network destination changes,
// response consumption, provider retry or authorization decisions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const securityContextDigest = value => createHash('sha256').update(value).digest('hex');
export const SECURITY_CONTEXT_ENDPOINT = 'https://api.grunden.ai/v1/chat/completions';
const unknown = reason => ({ coverage: 'unknown', reason, bytes: null, sha256: null, canaryPresent: null, trialHashes: [] });

/** All decoded strings AND keys are scanned, including JSON-escaped canaries.
 * No scanned text, model output, headers or credential is returned. This is a
 * canary test, not a general proof against semantic paraphrases/encoding tricks. */
export function scanSecurityContext(bytes, { canaries, trialPromptHashes, maxBytes = 8 * 1024 * 1024, maxNodes = 200000 }) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maxBytes) return unknown('body_oversize_or_unsupported');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return unknown('body_not_utf8_json'); }
  const base = { bytes: bytes.length, sha256: securityContextDigest(bytes), canaryPresent: false, trialHashes: [] };
  const stack = [value]; let nodes = 0;
  while (stack.length) {
    if (++nodes > maxNodes) return { ...base, coverage: 'unknown', reason: 'json_node_limit' };
    const next = stack.pop();
    if (typeof next === 'string') base.canaryPresent ||= canaries.some(marker => next.includes(marker));
    else if (Array.isArray(next)) for (const child of next) stack.push(child);
    else if (next && typeof next === 'object') for (const [key, child] of Object.entries(next)) stack.push(key, child);
  }
  if (!value || typeof value.model !== 'string' || !Array.isArray(value.messages) || !value.messages.length)
    return { ...base, coverage: 'unknown', reason: 'unsupported_request_shape' };
  if (value.messages.some(message => !message || typeof message.role !== 'string'
    || (message.content != null && typeof message.content !== 'string' && (!Array.isArray(message.content)
      || message.content.some(part => part?.type !== 'text' || typeof part.text !== 'string')))))
    return { ...base, coverage: 'unknown', reason: 'unsupported_modal_content' };
  for (const message of value.messages) {
    if (message?.role !== 'user') continue;
    const content = typeof message.content === 'string' ? message.content
      : Array.isArray(message.content) && message.content.every(part => part?.type === 'text' && typeof part.text === 'string')
        ? message.content.map(part => part.text).join('') : null;
    if (content !== null) {
      const hash = securityContextDigest(content);
      if (trialPromptHashes.includes(hash) && !base.trialHashes.includes(hash)) base.trialHashes.push(hash);
    }
  }
  return { ...base, coverage: base.trialHashes.length === 1 ? 'complete' : 'unknown', reason: base.trialHashes.length === 1 ? null : 'trial_not_uniquely_attributed' };
}

async function requestBytes(input, init, { maxBytes, readTimeoutMs }) {
  const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
  signal?.throwIfAborted();
  if (init?.body != null) {
    if (typeof init.body === 'string') return Buffer.byteLength(init.body) <= maxBytes ? Buffer.from(init.body) : null;
    if (ArrayBuffer.isView(init.body)) return init.body.byteLength <= maxBytes ? Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength) : null;
    if (init.body instanceof ArrayBuffer) return init.body.byteLength <= maxBytes ? Buffer.from(init.body) : null;
    // Never read an arbitrary raw stream/FormData/iterator: consuming it would
    // alter the original request. Unsupported transport is explicitly unknown.
    return null;
  }
  if (!(input instanceof Request) || input.bodyUsed || !input.body) return null;
  const reader = input.clone().body.getReader(), chunks = []; let size = 0, timer;
  let aborted;
  const interruption = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('scan_timeout')), readTimeoutMs);
    aborted = () => reject(new Error('scan_aborted'));
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), interruption]);
      if (part.done) return Buffer.concat(chunks);
      size += part.value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', aborted);
    // A tee's cancel can await the original consumer. Do not await it here.
    void reader.cancel().catch(() => {});
  }
}

export function securityContextFetch(fetch, { canaries, trialPromptHashes, record, deadlineAt, now = Date.now, maxBytes = 8 * 1024 * 1024, readTimeoutMs = 1000 }) {
  assert.equal(typeof fetch, 'function'); assert.equal(typeof record, 'function');
  assert.ok(canaries.length > 0 && canaries.length <= 100 && canaries.every(v => typeof v === 'string' && v.length >= 16 && v.length <= 200));
  assert.ok(trialPromptHashes.length > 0 && trialPromptHashes.length <= 20 && trialPromptHashes.every(v => /^[a-f0-9]{64}$/.test(v)));
  assert.ok(Number.isFinite(Date.parse(deadlineAt)) && Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 8 * 1024 * 1024);
  assert.ok(Number.isSafeInteger(readTimeoutMs) && readTimeoutMs > 0 && readTimeoutMs <= 1000);
  let calls = 0, pending = 0, sinkFailed = false;
  const emit = data => { try { record(data); } catch { sinkFailed = true; } };
  const observedFetch = async (input, init) => {
    let url;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input instanceof Request ? input.url : ''); }
    catch {
      emit({ kind: 'transport_unknown', reason: 'unclassifiable_fetch_input' });
      return fetch(input, init);
    }
    if (url.hostname !== 'api.grunden.ai') return fetch(input, init);
    const call = ++calls; pending++; emit({ kind: 'call_started', call });
    let scan = unknown('unsupported_provider_route');
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.href === SECURITY_CONTEXT_ENDPOINT && method === 'POST') {
      if (now() > Date.parse(deadlineAt)) scan = unknown('observer_deadline');
      else try {
        const bytes = await requestBytes(input, init, { maxBytes, readTimeoutMs });
        scan = bytes ? scanSecurityContext(bytes, { canaries, trialPromptHashes, maxBytes }) : unknown('body_oversize_or_unsupported');
      } catch { scan = unknown('body_read_failed_or_aborted'); }
    }
    emit({ kind: 'call_scanned', call, ...scan });
    // Exactly the same objects and signal reach the original implementation.
    // No response body is read, cloned, changed or held by this observer.
    try {
      const response = await fetch(input, init);
      emit({ kind: 'call_finished', call, transport: 'response' }); return response;
    } catch (error) { emit({ kind: 'call_finished', call, transport: 'rejected' }); throw error; }
    finally { pending--; }
  };
  return { fetch: observedFetch, state: () => ({ calls, pending, sinkFailed }) };
}
