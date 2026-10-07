// Test-only provider response barrier. Importing does not install or call it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const endpoint = 'https://api.grunden.ai/v1/chat/completions';
const digest = value => createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,150}$/.test(value);

/** Extract only exact report identity and consumed-evidence IDs/digests. Raw
 * source text, images, prompts, credentials and provider output never reach
 * the controller or receipt. Tool calls/other agent traffic never qualify. */
export function reportProviderIdentity(body) {
  try {
    const request = JSON.parse(body);
    if (request.stream || request.model !== 'glm-5.3' || !request.response_format?.json_schema || request.tools?.length) return null;
    const message = request.messages?.at(-1);
    if (message?.role !== 'user' || !Array.isArray(message.content) || message.content[0]?.type !== 'text') return null;
    const context = JSON.parse(message.content[0].text);
    if (context.schemaVersion !== 2 || !identifier(context.missionId) || !identifier(context.workspaceId)
      || !Number.isInteger(context.revision) || !/^[a-f0-9]{64}$/.test(context.inputFingerprint ?? '')
      || context.evidenceSelection?.basis !== 'metadata_selection_only' || !Array.isArray(context.evidenceSelection.readEvidenceIds)) return null;
    const ids = context.evidenceSelection.readEvidenceIds;
    if (ids.length > 24 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || id.length > 200)) return null;
    const receipts = [];
    for (const [index, part] of message.content.entries()) {
      if (!index) continue;
      if (part.type !== 'text') continue;
      let read; try { read = JSON.parse(part.text); } catch { continue; }
      if (!ids.includes(read.id)) continue;
      if (read.unavailable || read.limited || !/^[a-f0-9]{64}$/.test(read.digest ?? '') || (!read.text && !read.image)) return null;
      if (receipts.some(receipt => receipt.id === read.id)) return null;
      if (read.image) {
        const pixels = message.content[index + 1];
        const encoded = pixels?.type === 'image_url' && /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(pixels.image_url?.url ?? '');
        if (!encoded) return null;
        const bytes = Buffer.from(encoded[1], 'base64');
        if (bytes.toString('base64') !== encoded[1] || digest(bytes) !== read.digest) return null;
      }
      receipts.push({ id: read.id, digest: read.digest });
    }
    if (receipts.length !== ids.length) return null;
    return { missionId: context.missionId, workspaceId: context.workspaceId, revision: context.revision,
      inputFingerprint: context.inputFingerprint, evidence: receipts, requestSha256: digest(body) };
  } catch { return null; }
}

/** The unmodified physical request runs first. Only an exact successful JSON
 * report response waits at afterResponse. An error/timeout/429 is not a valid
 * freshness fault. A failed hook aborts the original call; it never retries,
 * invents a model response, or relaxes the application's validation. */
export function reportBarrierFetch(fetch, { match, afterResponse, maxHoldMs = 10000 }) {
  assert.equal(typeof fetch, 'function'); assert.equal(typeof match, 'function'); assert.equal(typeof afterResponse, 'function');
  assert.ok(Number.isInteger(maxHoldMs) && maxHoldMs >= 1 && maxHoldMs <= 15000);
  return async (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (url !== endpoint || init?.method?.toUpperCase() !== 'POST' || typeof init.body !== 'string' || init.body.length > 8 * 1024 * 1024) return fetch(input, init);
    const identity = reportProviderIdentity(init.body);
    if (!identity || !await match(identity)) return fetch(input, init);
    const response = await fetch(input, init);
    if (response.status !== 200 || !response.headers.get('content-type')?.includes('application/json')) return response;
    // Wait for the real provider's complete wire response. Never count headers
    // alone as a completed model request or claim a failed provider as proof.
    const limit = 4 * 1024 * 1024, chunks = []; let size = 0;
    const reader = response.body?.getReader(); assert.ok(reader, 'Provider response has no body');
    try { for (;;) { init.signal?.throwIfAborted(); const part = await reader.read(); if (part.done) break;
      size += part.value.length; assert.ok(size <= limit, 'Provider response exceeded barrier limit'); chunks.push(part.value);
    } } finally { await reader.cancel().catch(() => {}); }
    const bytes = Buffer.concat(chunks), result = JSON.parse(bytes.toString('utf8'));
    assert.ok(result.choices?.[0]?.message?.content && !result.choices[0].message.tool_calls?.length, 'No completed report response at fault boundary');
    const controller = new AbortController(), signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error('Report fault barrier deadline exceeded')), maxHoldMs);
    try {
      const held = { ...identity, providerResponseSha256: digest(bytes), providerStatus: 200, providerCompletedAt: new Date().toISOString() };
      const receipt = await Promise.race([afterResponse(held, signal), new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })]);
      signal.throwIfAborted();
      assert.ok(receipt?.released === true && receipt.requestSha256 === identity.requestSha256, 'Report fault barrier has no matching release receipt');
      const headers = new Headers(response.headers); headers.delete('content-encoding'); headers.delete('content-length');
      return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
    } finally { clearTimeout(timer); controller.abort(); }
  };
}
