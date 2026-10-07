import { z } from 'zod';

export const PROVIDER_PACING_MAX_INTERVAL_MS = 30_000;
// Queue admission is separate from request spacing. A valid 30s slot or
// another worker's cooldown must not automatically exhaust a 30s waiter.
// Caller cancellation/deadlines still take precedence over this upper bound.
export const PROVIDER_PACING_MAX_WAIT_MS = 120_000;
export const PROVIDER_PACING_DEFAULT_COOLDOWN_MS = 30_000;
export const PROVIDER_PACING_MAX_COOLDOWN_MS = 300_000;
export const providerPacingModelSchema = z.enum(['glm-5.3', 'glm-5.3-flash']);

/** Opt-in burst mitigation, not a promise about the provider's RPM/TPM quota. */
export function providerPacingInterval(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0;
  if (!/^\d+$/.test(value.trim())) throw new Error('Invalid GRUNDEN_MIN_REQUEST_INTERVAL_MS');
  const interval = Number(value.trim());
  if (!Number.isSafeInteger(interval) || interval > PROVIDER_PACING_MAX_INTERVAL_MS) throw new Error('Invalid GRUNDEN_MIN_REQUEST_INTERVAL_MS');
  return interval;
}

const identity = {
  model: providerPacingModelSchema,
  credentialHash: z.string().regex(/^[a-f0-9]{64}$/),
  intervalMs: z.number().int().min(1).max(PROVIDER_PACING_MAX_INTERVAL_MS),
};
export const providerPacingRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reserve'), ...identity }).strict(),
  z.object({ action: z.literal('cooldown'), ...identity, delayMs: z.number().int().min(0).max(PROVIDER_PACING_MAX_COOLDOWN_MS) }).strict(),
]);
export type ProviderPacingRequest = z.infer<typeof providerPacingRequestSchema>;
export const providerPacingReservationSchema = z.discriminatedUnion('allowed', [
  z.object({ allowed: z.literal(true) }).strict(),
  z.object({ allowed: z.literal(false), waitMs: z.number().int().min(1).max(PROVIDER_PACING_MAX_COOLDOWN_MS) }).strict(),
]);
export type ProviderPacingReservation = z.infer<typeof providerPacingReservationSchema>;

/** The header contains no prompt or response body. Overlong/invalid values are
 * ignored; a real long cooldown is clamped, never interpreted as a retry grant. */
export function providerRetryAfter(headers: Record<string, string> | undefined, now = Date.now()): number | null {
  const value = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1]?.trim();
  if (!value || value.length > 100) return null;
  const delay = /^\d+(?:\.\d+)?$/.test(value) ? Math.ceil(Number(value) * 1000)
    : /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) ? Math.max(0, Date.parse(value) - now) : NaN;
  return Number.isSafeInteger(delay) && delay >= 0 ? Math.min(delay, PROVIDER_PACING_MAX_COOLDOWN_MS) : null;
}
