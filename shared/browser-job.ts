import { z } from 'zod';

export const irisTerminalStates = ['completed', 'failed', 'cancelled'] as const;
export const irisActiveStates = ['starting', 'dispatching', 'dispatch_unknown', 'running', 'cancelling'] as const;
export type IrisTerminalState = typeof irisTerminalStates[number];
export const IRIS_MAX_MODEL_CALLS = 64;
export const IRIS_MAX_OUTPUT_TOKENS = 8_000;
export const IRIS_MODEL_LEDGER_PREFIX = 'server:iris-model:';
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const irisProviderUsageSchema = z.object({ inputTokens: tokenCount, outputTokens: tokenCount, cacheReadTokens: tokenCount, cacheWriteTokens: tokenCount }).strict();
export type IrisProviderUsage = z.infer<typeof irisProviderUsageSchema>;
// Only documented, non-freeform diagnostics may enter the durable ledger.
// Unknown provider codes remain null rather than persisting arbitrary content.
export const irisProviderFailureSchema = z.object({
  kind: z.enum(['rate_limited', 'provider_rejected', 'transport_error', 'stream_error', 'incomplete_stream', 'cancelled']),
  phase: z.enum(['request', 'stream']), outputObserved: z.boolean(),
  status: z.number().int().min(400).max(599).nullable(),
  providerErrorCode: z.enum(['rate_limit_exceeded', 'rate_limit_error', 'too_many_requests', 'insufficient_quota', 'quota_exceeded', 'billing_hard_limit_reached', 'resource_exhausted', 'overloaded_error']).nullable(),
  retryAfterMs: z.number().int().min(0).max(24 * 60 * 60_000).nullable(),
}).strict();
export type IrisProviderFailure = z.infer<typeof irisProviderFailureSchema>;
export const irisModelReceiptSchema = irisProviderUsageSchema.extend({ callId: z.string().uuid(), durationMs: z.number().int().nonnegative().max(24 * 60 * 60_000), failure: irisProviderFailureSchema.optional() }).strict();
export type IrisModelReceipt = z.infer<typeof irisModelReceiptSchema>;
/** Physical calls, never logical step coordinates. Cache reads are a subset of
 * provider input and are not added again. Missing usage remains unknown. */
export function irisModelUsage(ids: readonly string[]) {
  const starts = [...new Set(ids.filter(id => id.startsWith(`${IRIS_MODEL_LEDGER_PREFIX}start:`)).map(id => id.slice(`${IRIS_MODEL_LEDGER_PREFIX}start:`.length)))];
  const receipts = new Map<string, IrisModelReceipt>();
  let invalid = starts.length > IRIS_MAX_MODEL_CALLS || starts.some(id => !z.string().uuid().safeParse(id).success);
  for (const marker of ids.filter(id => id.startsWith(`${IRIS_MODEL_LEDGER_PREFIX}usage:`))) {
    try {
      const value = irisModelReceiptSchema.parse(JSON.parse(marker.slice(`${IRIS_MODEL_LEDGER_PREFIX}usage:`.length)));
      if (!starts.includes(value.callId) || receipts.has(value.callId) && JSON.stringify(receipts.get(value.callId)) !== JSON.stringify(value)) invalid = true;
      receipts.set(value.callId, value);
    } catch { invalid = true; }
  }
  const values = starts.flatMap(id => receipts.has(id) ? [receipts.get(id)!] : []);
  const knownCalls = values.filter(value => value.inputTokens !== null && value.outputTokens !== null).length;
  const sum = (key: keyof IrisProviderUsage) => values.reduce((total, value) => total + (value[key] ?? 0), 0);
  const count = (key: keyof IrisProviderUsage) => values.filter(value => value[key] !== null).length;
  if (![sum('inputTokens') + sum('outputTokens'), sum('cacheReadTokens'), sum('cacheWriteTokens')].every(Number.isSafeInteger)) invalid = true;
  return { providerCalls: starts.length, knownCalls, unknownCalls: starts.length - knownCalls, invalid,
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cacheReadTokens: sum('cacheReadTokens'), cacheWriteTokens: sum('cacheWriteTokens'),
    measurementCounts: { inputTokens: count('inputTokens'), outputTokens: count('outputTokens'), cacheReadTokens: count('cacheReadTokens'), cacheWriteTokens: count('cacheWriteTokens'), durationMs: values.length },
    tokens: invalid || knownCalls !== starts.length ? null : sum('inputTokens') + sum('outputTokens'),
    durationMs: values.reduce((total, value) => total + value.durationMs, 0) };
}
export const irisWorkerRequestSchema = z.object({ action: z.enum(['start', 'status', 'cancel']), jobId: z.string().uuid(), userId: z.string().uuid(), threadId: z.string().uuid(), task: z.string().max(16000), model: z.string(), reasoning: z.string(), dispatchLeaseToken: z.string().uuid().optional() });
export const irisEventSchema = z.object({
  jobId: z.string().uuid(), userId: z.string().uuid(), threadId: z.string().uuid(),
  kind: z.enum(['dispatch', 'started', 'receipt', 'progress', 'settled', 'model_started', 'model_finished']),
  sessionId: z.string().min(1).max(200).optional(), dispatchLeaseToken: z.string().uuid().optional(),
  status: z.enum(irisTerminalStates).optional(), report: z.string().max(50000).optional(),
  modelCallId: z.string().uuid().optional(), modelUsage: irisProviderUsageSchema.optional(), modelDurationMs: z.number().int().nonnegative().max(24 * 60 * 60_000).optional(),
  modelFailure: irisProviderFailureSchema.optional(),
}).superRefine((event, ctx) => {
  if (event.kind === 'dispatch' ? !event.dispatchLeaseToken : !event.sessionId) ctx.addIssue({ code: 'custom', message: 'Executor identity is required' });
  if (event.kind === 'settled' && !event.status) ctx.addIssue({ code: 'custom', message: 'A settled event needs a terminal state' });
  if (['model_started', 'model_finished'].includes(event.kind) && !event.modelCallId) ctx.addIssue({ code: 'custom', message: 'A physical model call ID is required' });
  if (event.kind === 'model_finished' && (!event.modelUsage || event.modelDurationMs === undefined)) ctx.addIssue({ code: 'custom', message: 'A model receipt needs explicit nullable usage' });
  if (event.modelFailure && event.kind !== 'model_finished') ctx.addIssue({ code: 'custom', message: 'Provider failure belongs to a physical model receipt' });
});
export type IrisEvent = z.infer<typeof irisEventSchema>;
export type IrisSnapshot = { sessionId: string; status: 'running' | IrisTerminalState; report?: string; observedTail: number; truncated: boolean };

/** Read a finite, captured durable tail. Never send a message to recover status. */
export async function readIrisSnapshot(session: { id: string; getStreamTailIndex(): Promise<number>; getEventStream(options: { startIndex: number }): Promise<ReadableStream<unknown>> }): Promise<IrisSnapshot> {
  const tail = await session.getStreamTailIndex(), start = Math.max(0, tail - 511);
  if (tail < 0) return { sessionId: session.id, status: 'running', observedTail: tail, truncated: false };
  const reader = (await session.getEventStream({ startIndex: start })).getReader();
  let status: IrisSnapshot['status'] = 'running', terminal: IrisTerminalState | null = null, report: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => undefined); reject(new Error('Iris status stream timed out')); }, 5000); });
  try {
    for (let index = start; index <= tail; index++) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next.done) throw new Error('Iris status stream ended before its captured tail');
      const event = next.value as { type?: string; data?: { message?: string } };
      if (event.type === 'turn.started') { status = 'running'; terminal = null; }
      if (event.type === 'message.completed' && typeof event.data?.message === 'string') report = event.data.message.slice(0, 50000);
      if (event.type === 'turn.completed') terminal = 'completed';
      if (event.type === 'turn.failed') { terminal = 'failed'; if (event.data?.message) report = event.data.message.slice(0, 50000); }
      if (event.type === 'turn.cancelled') terminal = 'cancelled';
      if (event.type === 'session.waiting' && terminal) status = terminal;
      if (event.type === 'session.failed') { status = 'failed'; if (event.data?.message) report = event.data.message.slice(0, 50000); }
      if (event.type === 'session.completed') status = terminal ?? 'completed';
    }
    return { sessionId: session.id, status, ...(report !== undefined ? { report } : {}), observedTail: tail, truncated: start > 0 };
  } finally { if (timer) clearTimeout(timer); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
