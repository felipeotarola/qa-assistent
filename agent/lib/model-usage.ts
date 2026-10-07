import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import { openAIWireUsage, sumProviderUsage, type ProviderCallUsage } from '../../shared/provider-usage.ts';
import { noteProviderRateLimit, waitForProviderTurn } from './provider-pacing.ts';

/** One bounded inference workflow. Measures actual physical calls, including
 * failures and SDK retries. Persistence/lease authority remains with the caller;
 * a process crash therefore still leaves its durable reservation unknown. */
export function meteredModel(model: Parameters<typeof wrapLanguageModel>[0]['model'], beforeCall?: () => Promise<void>, limits?: { maxTokens: number }) {
  if (limits && (!Number.isSafeInteger(limits.maxTokens) || limits.maxTokens < 1)) throw new Error('A positive bounded model allowance is required');
  const calls: ProviderCallUsage[] = [];
  let inFlight = false;
  function checkBudget() {
    if (!limits) return;
    const usage = sumProviderUsage(calls);
    if (usage.totalTokens === null || usage.totalTokens >= limits.maxTokens) throw new Error('Model workflow budget exhausted or previous usage unknown');
  }
  const middleware: LanguageModelMiddleware = {
    wrapGenerate: async ({ doGenerate, params, model }) => {
      // The reader and writer deliberately share one bounded meter. Concurrent
      // calls cannot race its measured allowance while admission is awaiting.
      if (inFlight) throw new Error('Concurrent calls require separate bounded model workflows');
      inFlight = true;
      try {
        checkBudget();
        await waitForProviderTurn(model.modelId, params.abortSignal);
        checkBudget();
        // Admission/lease and durable model-start receipt are deliberately after
        // waiting. A pacer failure has not spent or recorded a physical call.
        await beforeCall?.();
        params.abortSignal?.throwIfAborted();
        const started = performance.now();
        let usage: unknown;
        try {
          try { const result = await doGenerate(); usage = result.usage; return result; }
          finally { calls.push({ ...openAIWireUsage(usage), durationMs: Math.max(0, Math.round(performance.now() - started)) }); }
        } catch (error) { await noteProviderRateLimit(model.modelId, error); throw error; }
      } finally {
        inFlight = false;
      }
    },
    // These planner/reviewer workflows use generate(). Refuse accidental
    // streaming until its cancellation/EOF accounting is implemented here.
    wrapStream: async () => { throw new Error('This bounded model meter requires generate'); },
  };
  return { model: wrapLanguageModel({ model, middleware }), usage: () => sumProviderUsage(calls) };
}
