import { createHash } from 'node:crypto';
import { canonicalExecutionPayload, executionAdmission, missionExecution } from '../../shared/mission-execution.mjs';

// Stable hashing is for idempotence, not a substitute for live admission.
export function executionHash(value) {
  return createHash('sha256').update(canonicalExecutionPayload(value)).digest('hex');
}
export function sameExecution(stored, supplied) {
  if (!stored && supplied === undefined) return null;
  if (!stored || supplied === undefined) throw new Error('Execution binding cannot be added or removed on replay');
  const execution = missionExecution(supplied);
  if (executionHash(missionExecution(stored)) !== executionHash(execution)) throw new Error('Execution binding changed');
  return execution;
}
export class ExecutorAdmission {
  constructor({ appUrl = process.env.AUTONOMY_APP_URL, secret = process.env.INTERNAL_API_SECRET, fetch: request = globalThis.fetch, now = Date.now, timeoutMs = 5000 } = {}) {
    Object.assign(this, { appUrl, secret, request, now, timeoutMs });
  }
  async admit(input) {
    const value = executionAdmission(input);
    if (Date.parse(value.execution.deadlineAt) <= this.now()) throw new Error('Execution deadline expired');
    if (!this.appUrl || typeof this.secret !== 'string' || this.secret.length < 32) throw new Error('Autonomous executor admission is unavailable');
    const url = new URL(this.appUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Invalid configured autonomy app URL');
    url.pathname = '/api/internal/autonomy/executor/admit';
    let result;
    try {
      const response = await this.request(url, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) throw new Error('Denied');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing receipt');
      let size = 0; const chunks = [];
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 16384) throw new Error('Oversized receipt'); chunks.push(chunk.value); } }
      finally { await reader.cancel().catch(() => {}); }
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new Error('Executor admission denied or unavailable'); }
    const expected = { allowed: true, attemptId: value.execution.attemptId, dispatchId: value.execution.dispatchId, resourceId: value.resourceId, operationId: value.operationId, kind: value.kind, payloadHash: value.payloadHash };
    if (!result || typeof result !== 'object' || Object.keys(result).length !== 8 || Object.entries(expected).some(([key, entry]) => result[key] !== entry)) throw new Error('Executor admission receipt mismatch');
    const until = typeof result.validUntil === 'string' ? Date.parse(result.validUntil) : NaN;
    if (!Number.isFinite(until) || until <= this.now() || until > Date.parse(value.execution.deadlineAt)) throw new Error('Executor admission receipt expired or widened');
    return result;
  }
}
