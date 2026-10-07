import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { APICallError, type LanguageModelMiddleware } from 'ai';
import { appOrigin, internalHeaders } from './internal-api.ts';
import { PROVIDER_PACING_DEFAULT_COOLDOWN_MS, PROVIDER_PACING_MAX_WAIT_MS, providerPacingInterval, providerPacingModelSchema, providerPacingReservationSchema, providerRetryAfter, type ProviderPacingRequest } from '../../shared/provider-pacing.ts';

function pacingIdentity(model: string) {
  const intervalMs = providerPacingInterval(process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS);
  if (!intervalMs) return null;
  const credential = process.env.GRUNDEN_API_TOKEN?.trim();
  if (!credential) throw new Error('Provider pacing requires configured credentials');
  return { model: providerPacingModelSchema.parse(model), intervalMs, credentialHash: createHash('sha256').update(credential).digest('hex') };
}
async function request(input: ProviderPacingRequest, signal: AbortSignal) {
  const response = await fetch(`${appOrigin()}/api/internal/provider-pacing`, {
    method: 'POST', headers: internalHeaders(), signal, body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error('Provider pacing is unavailable; model request was not started');
  return response.json() as Promise<unknown>;
}

/** Only admission requests repeat. A physical provider invocation never does.
 * A cancelled waiter gives up its turn; no database lock is held while asleep. */
export async function waitForProviderTurn(model: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const identity = pacingIdentity(model);
  if (!identity) return;
  const started = performance.now();
  const bounded = AbortSignal.any([AbortSignal.timeout(PROVIDER_PACING_MAX_WAIT_MS), ...(signal ? [signal] : [])]);
  while (true) {
    bounded.throwIfAborted();
    const reservation = providerPacingReservationSchema.parse(await request({ action: 'reserve', ...identity }, bounded));
    bounded.throwIfAborted();
    if (reservation.allowed) return;
    if (reservation.waitMs >= PROVIDER_PACING_MAX_WAIT_MS - (performance.now() - started)) {
      throw new Error('Provider pacing wait exceeds the bounded model admission window');
    }
    await delay(reservation.waitMs, undefined, { signal: bounded });
  }
}

/** Best effort shared backoff. Accounting/error propagation belongs to the
 * caller, so unavailable cooldown storage must never replace its real error. */
export async function noteProviderRateLimit(model: string, error: unknown): Promise<void> {
  try {
    if (!APICallError.isInstance(error) || error.statusCode !== 429) return;
    const identity = pacingIdentity(model);
    if (!identity) return;
    await request({ action: 'cooldown', ...identity, delayMs: providerRetryAfter(error.responseHeaders) ?? PROVIDER_PACING_DEFAULT_COOLDOWN_MS }, AbortSignal.timeout(5000));
  } catch { /* A missing cooldown receipt is never a successful provider receipt. */ }
}

/** V and Axel use this wrapper. Iris and metered server workflows perform the
 * same wait before their own physical authority and accounting gates.
 *
 * This local latch stops SDK retries and Eve's transient retry loop, not an
 * exactly-once ledger. Eve parks a conversational turn on this plain error;
 * its task mode may retry the durable step with a fresh model instance. Generic
 * Axel tasks do not yet have Iris's persistent unknown-consumption fence. */
export function providerPacingMiddleware(): LanguageModelMiddleware {
  let stopped: Error | undefined;
  async function failure(model: string, error: unknown) {
    await noteProviderRateLimit(model, error);
    if (!APICallError.isInstance(error) || error.statusCode !== 429) return error;
    // No retryable status, raw provider body or cause chain is forwarded. The
    // SDK must not silently replay an invocation with unknown consumption.
    stopped = new Error('Modelltjänsten nekade anropet. Det här modellförsöket avbröts och förbrukningen är okänd.');
    return stopped;
  }
  return {
    wrapGenerate: async ({ doGenerate, params, model }) => {
      if (stopped) throw stopped;
      await waitForProviderTurn(model.modelId, params.abortSignal);
      params.abortSignal?.throwIfAborted();
      try { return await doGenerate(); }
      catch (error) { throw await failure(model.modelId, error); }
    },
    wrapStream: async ({ doStream, params, model }) => {
      if (stopped) throw stopped;
      await waitForProviderTurn(model.modelId, params.abortSignal);
      params.abortSignal?.throwIfAborted();
      try {
        const result = await doStream();
        const reader = result.stream.getReader();
        return { ...result, stream: new ReadableStream({
          async pull(controller) {
            try {
              const part = await reader.read();
              if (part.done) { controller.close(); reader.releaseLock(); return; }
              controller.enqueue(part.value.type === 'error' ? { ...part.value, error: await failure(model.modelId, part.value.error) } : part.value);
            } catch (error) { controller.error(await failure(model.modelId, error)); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
          },
          async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
        }) };
      } catch (error) { throw await failure(model.modelId, error); }
    },
  };
}
