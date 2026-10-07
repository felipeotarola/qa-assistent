import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const providerUsageSchema = z.object({
  providerCalls: count, unknownCalls: count, inputTokens: count.nullable(), outputTokens: count.nullable(), totalTokens: count.nullable(),
  cacheReadTokens: count.nullable(), cacheWriteTokens: count.nullable(), durationMs: count.nullable(),
}).strict().superRefine((value, ctx) => {
  const invalid = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (value.unknownCalls > value.providerCalls) invalid('unknownCalls', 'Unknown calls exceed observed provider calls');
  const total = value.inputTokens === null || value.outputTokens === null ? null : value.inputTokens + value.outputTokens;
  if (total !== value.totalTokens || total !== null && !Number.isSafeInteger(total)) invalid('totalTokens', 'Token total must match measured input and output');
  if (value.unknownCalls > 0 && value.totalTokens !== null) invalid('totalTokens', 'Unknown calls cannot have a complete token total');
  if (value.providerCalls > 0 && value.unknownCalls === 0 && value.totalTokens === null) invalid('unknownCalls', 'Incomplete tokens require unknown calls');
  if (value.providerCalls === 0) for (const field of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'durationMs'] as const) {
    if (value[field] !== null && value[field] !== 0) invalid(field, 'Zero provider calls cannot have positive consumption');
  }
  for (const field of ['cacheReadTokens', 'cacheWriteTokens'] as const) if (value.inputTokens !== null && value[field] !== null && value[field] > value.inputTokens) invalid(field, 'Cached tokens cannot exceed measured input');
});

/** Grunden's OpenAI-compatible wire receipt. The SDK's normalized usage can
 * substitute zero for missing fields; it cannot distinguish unknown from zero.
 * A new provider requires an explicit mapping, never a normalized fallback. */
export function openAIWireUsage(value: unknown) {
  const usage = value as { raw?: { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } } | null } | undefined;
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  let inputTokens = count(usage?.raw?.prompt_tokens), outputTokens = count(usage?.raw?.completion_tokens);
  if (inputTokens !== null && outputTokens !== null && !Number.isSafeInteger(inputTokens + outputTokens)) inputTokens = outputTokens = null;
  const cached = count(usage?.raw?.prompt_tokens_details?.cached_tokens);
  return { inputTokens, outputTokens,
    cacheReadTokens: inputTokens !== null && cached !== null && cached > inputTokens ? null : cached, cacheWriteTokens: null };
}

export type ProviderCallUsage = ReturnType<typeof openAIWireUsage> & { durationMs: number };
export function sumProviderUsage(calls: readonly ProviderCallUsage[]) {
  const sum = (field: keyof ProviderCallUsage) => {
    // An instantiated meter that saw no provider calls is a known zero. This
    // differs from a missing meter receipt after process loss.
    if (calls.some(call => call[field] === null)) return null;
    const value = calls.reduce((total, call) => total + call[field]!, 0);
    return Number.isSafeInteger(value) ? value : null;
  };
  let inputTokens = sum('inputTokens'), outputTokens = sum('outputTokens');
  const total = inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens;
  const overflow = calls.every(call => call.inputTokens !== null && call.outputTokens !== null)
    && (inputTokens === null || outputTokens === null || total !== null && !Number.isSafeInteger(total));
  // Malformed or unrepresentable receipts must still be persistable as unknown
  // consumption. They cannot become a zero charge or prevent queue settlement.
  if (overflow) inputTokens = outputTokens = null;
  return {
    providerCalls: calls.length,
    unknownCalls: overflow ? calls.length : calls.filter(call => call.inputTokens === null || call.outputTokens === null).length,
    inputTokens, outputTokens, totalTokens: total !== null && Number.isSafeInteger(total) ? total : null,
    cacheReadTokens: sum('cacheReadTokens'), cacheWriteTokens: sum('cacheWriteTokens'), durationMs: sum('durationMs'),
  };
}
export type ProviderUsage = ReturnType<typeof sumProviderUsage>;

/** Combines measured workflow receipts, never an estimate for a crashed call. */
export function combineProviderUsage(values: readonly ProviderUsage[]): ProviderUsage | undefined {
  if (!values.length) return;
  for (const value of values) providerUsageSchema.parse(value);
  const sum = (field: keyof ProviderUsage) => {
    if (values.some(value => value[field] === null)) return null;
    const result = values.reduce((total, value) => total + value[field]!, 0);
    if (!Number.isSafeInteger(result)) throw new Error('Provider usage exceeds numeric range');
    return result;
  };
  return { providerCalls: sum('providerCalls')!, unknownCalls: sum('unknownCalls')!,
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens'),
    cacheReadTokens: sum('cacheReadTokens'), cacheWriteTokens: sum('cacheWriteTokens'), durationMs: sum('durationMs') };
}
