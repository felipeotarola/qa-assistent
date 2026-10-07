import { appOrigin, internalHeaders } from './internal-api';
import { randomUUID } from 'node:crypto';
import { APICallError, wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import { IRIS_MAX_OUTPUT_TOKENS, irisProviderFailureSchema, type IrisEvent, type IrisProviderUsage, type IrisProviderFailure } from '../../shared/browser-job';
import { openAIWireUsage } from '../../shared/provider-usage';
import { noteProviderRateLimit, waitForProviderTurn } from './provider-pacing';

type Auth = { authenticator: string; issuer?: string; principalId: string; principalType: string; attributes: Readonly<Record<string, unknown>> };
type AdmissionContext = { channel: { kind?: string }; session: { id: string; auth: { current: Auth | null; initiator: Auth | null } } };

/** Model resolvers propagate failures; channel event callbacks deliberately do not. */
function identity(event: unknown, ctx: AdmissionContext) {
  const current = ctx.session.auth.current, initial = ctx.session.auth.initiator;
  // Channel identity survives a later send with altered or omitted auth metadata.
  if (ctx.channel.kind !== 'channel:iris' && current?.attributes.browserWorker !== 'iris' && initial?.attributes.browserWorker !== 'iris') return;
  const sequence = (event as { data?: { sequence?: number } } | null)?.data?.sequence;
  if (ctx.channel.kind !== 'channel:iris' || sequence !== 0
    || !current || !initial || current.authenticator !== 'app' || initial.authenticator !== 'app'
    || current.issuer !== 'app' || initial.issuer !== 'app' || current.principalType !== 'user' || initial.principalType !== 'user'
    || current.principalId !== initial.principalId || current.attributes.browserWorker !== 'iris' || initial.attributes.browserWorker !== 'iris'
    || typeof initial.attributes.browserJobId !== 'string' || typeof initial.attributes.browserThreadId !== 'string'
    || current.attributes.browserJobId !== initial.attributes.browserJobId || current.attributes.browserThreadId !== initial.attributes.browserThreadId) {
    throw new Error('Iris requires its original authenticated dispatch');
  }
  return { jobId: initial.attributes.browserJobId as string, userId: initial.principalId, threadId: initial.attributes.browserThreadId as string, sessionId: ctx.session.id };
}
async function persist(value: IrisEvent) {
  const response = await fetch(`${appOrigin()}/api/internal/browser-job-event`, {
    method: 'POST', headers: internalHeaders(), signal: AbortSignal.timeout(30000), body: JSON.stringify(value),
  });
  if (!response.ok || (await response.json() as { allowed?: boolean }).allowed !== true) throw new Error('Iris execution is no longer authorized');
}
export async function assertIrisAdmission(event: unknown, ctx: AdmissionContext) {
  const actor = identity(event, ctx);
  if (!actor) return;
  // Recheck on every model step: a paused, cancelled, expired or replaced attempt
  // cannot spend another model call. Browser tools independently recheck at use.
  await persist({ kind: 'started', ...actor });
}

function usageOf(value: unknown): IrisProviderUsage {
  // Grunden uses the OpenAI-compatible chat provider. Its normalized v4 usage
  // substitutes zero for missing fields in a partial receipt; only raw wire
  // measurements distinguish unknown consumption from an explicit real zero.
  // A different provider format needs an explicit mapping, never a fallback to
  // normalized totals. Missing/unsupported receipts therefore fail closed.
  return openAIWireUsage(value);
}
function retryAfter(headers: Record<string, string> | undefined, now: number) {
  const value = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1]?.trim();
  if (!value || value.length > 100) return null;
  const delay = /^\d+(?:\.\d+)?$/.test(value) ? Math.ceil(Number(value) * 1000)
    : /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) ? Math.max(0, Date.parse(value) - now) : NaN;
  return Number.isSafeInteger(delay) && delay >= 0 && delay <= 24 * 60 * 60_000 ? delay : null;
}
export function safeIrisProviderFailure(error: unknown, phase: 'request' | 'stream', outputObserved = false, now = Date.now()): IrisProviderFailure {
  const apiError = APICallError.isInstance(error) ? error : null;
  const status = apiError?.statusCode !== undefined && Number.isInteger(apiError.statusCode) && apiError.statusCode >= 400 && apiError.statusCode <= 599 ? apiError.statusCode : null;
  const data = apiError?.data as { error?: { code?: unknown } } | undefined;
  const code = apiError ? data?.error?.code : (error as { code?: unknown } | null)?.code;
  const parsedCode = irisProviderFailureSchema.shape.providerErrorCode.safeParse(code);
  return { kind: status === 429 ? 'rate_limited' : phase === 'stream' ? 'stream_error' : status !== null ? 'provider_rejected' : 'transport_error',
    phase, outputObserved, status, providerErrorCode: parsedCode.success ? parsedCode.data : null, retryAfterMs: retryAfter(apiError?.responseHeaders, now) };
}
function modelFailure(failure: IrisProviderFailure) {
  // HTTP rejection before output does not prove zero billable work behind the
  // gateway. Preserve unknown usage and let admission refuse another physical
  // call. Retry-After is diagnostic data, never permission to replay a step.
  return new Error(failure.kind === 'rate_limited'
    ? 'Modelltjänstens anropsgräns nåddes. Förbrukningen är okänd; automatisk modellretry har stoppats.'
    : failure.phase === 'stream' ? 'Modellsvaret avbröts. Förbrukningen kan vara okänd; ingen automatisk modellretry görs.'
      : 'Modellanropet misslyckades. Förbrukningen är okänd; automatisk modellretry har stoppats.');
}

/** Wrap the actual provider invocation, including SDK retries. No channel hook
 * failure can bypass this gate. Physical UUIDs differ even if Eve replays the
 * same turn/step; HTTP receipt replays keep the same UUID. Tokens are checked
 * between calls, so the last admitted call can exceed the remaining allowance. */
export function irisModelMiddleware(event: unknown, ctx: AdmissionContext): LanguageModelMiddleware | undefined {
  const actor = identity(event, ctx);
  if (!actor) return;
  let failedClosed = false;
  async function begin() {
    if (failedClosed) throw new Error('Iris model accounting requires reconciliation');
    const modelCallId = randomUUID();
    try { await persist({ kind: 'model_started', ...actor!, modelCallId }); }
    catch (error) { failedClosed = true; throw error; }
    const started = performance.now();
    let settled = false;
    return async (usage: unknown, failure?: IrisProviderFailure) => {
      if (settled) return;
      settled = true;
      try { await persist({ kind: 'model_finished', ...actor!, modelCallId, modelUsage: usageOf(usage), modelDurationMs: Math.max(0, Math.min(24 * 60 * 60_000, Math.round(performance.now() - started))), ...(failure ? { modelFailure: failure } : {}) }); }
      catch (error) { failedClosed = true; throw error; }
    };
  }
  return {
    transformParams: async ({ params }) => ({ ...params, maxOutputTokens: Math.min(params.maxOutputTokens ?? IRIS_MAX_OUTPUT_TOKENS, IRIS_MAX_OUTPUT_TOKENS) }),
    wrapGenerate: async ({ doGenerate, params, model }) => {
      if (failedClosed) throw new Error('Iris model accounting requires reconciliation');
      await waitForProviderTurn(model.modelId, params.abortSignal);
      params.abortSignal?.throwIfAborted();
      // model_started repeats current server authority after the wait.
      const finish = await begin();
      let result;
      try { result = await doGenerate(); }
      catch (error) {
        const failure = safeIrisProviderFailure(error, 'request');
        await finish(undefined, failure).catch(() => undefined);
        await noteProviderRateLimit(model.modelId, error); throw modelFailure(failure);
      }
      await finish(result.usage); return result;
    },
    wrapStream: async ({ doStream, params, model }) => {
      if (failedClosed) throw new Error('Iris model accounting requires reconciliation');
      await waitForProviderTurn(model.modelId, params.abortSignal);
      params.abortSignal?.throwIfAborted();
      const finish = await begin();
      let result;
      try {
        result = await doStream();
      } catch (error) {
        const failure = safeIrisProviderFailure(error, 'request');
        await finish(undefined, failure).catch(() => undefined);
        await noteProviderRateLimit(model.modelId, error); throw modelFailure(failure);
      }
      const reader = result.stream.getReader(); let outputObserved = false;
      return { ...result, stream: new ReadableStream({
        async pull(controller) {
          try {
            let next;
            try { next = await reader.read(); }
            catch (error) {
              const failure = safeIrisProviderFailure(error, 'stream', outputObserved);
              await finish(undefined, failure).catch(() => undefined);
              await noteProviderRateLimit(model.modelId, error); throw modelFailure(failure);
            }
            if (next.done) {
              await finish(undefined, { ...safeIrisProviderFailure(null, 'stream', outputObserved), kind: 'incomplete_stream' });
              controller.close(); reader.releaseLock(); return;
            }
            if (next.value.type === 'error') {
              const failure = safeIrisProviderFailure(next.value.error, 'stream', outputObserved);
              await finish(undefined, failure).catch(() => undefined);
              await noteProviderRateLimit(model.modelId, next.value.error); throw modelFailure(failure);
            }
            if (next.value.type === 'finish') await finish(next.value.usage);
            else if (!['stream-start', 'response-metadata', 'raw'].includes(next.value.type)) outputObserved = true;
            controller.enqueue(next.value);
          } catch (error) { await reader.cancel().catch(() => undefined); reader.releaseLock(); controller.error(error); }
        },
        async cancel(reason) {
          try { await reader.cancel(reason); }
          finally { await finish(undefined, { ...safeIrisProviderFailure(null, 'stream', outputObserved), kind: 'cancelled' }); reader.releaseLock(); }
        },
      }) };
    },
  };
}
export function withIrisModelBudget(model: Parameters<typeof wrapLanguageModel>[0]['model'], event: unknown, ctx: AdmissionContext) {
  const middleware = irisModelMiddleware(event, ctx);
  return middleware ? wrapLanguageModel({ model, middleware }) : model;
}
