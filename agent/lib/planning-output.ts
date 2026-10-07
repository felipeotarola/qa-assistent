import type { LanguageModelMiddleware } from 'ai';
import type { PlanningOutputDiagnostic } from '../../shared/mission-planning.ts';
import type { ProviderUsage } from '../../shared/provider-usage.ts';

/** Capture the normalized reason before Output.object parses the response.
 * NoOutputGeneratedError itself has no finishReason. Never inspect raw reasons,
 * content, response, usage, messages, or cause on the provider response. */
export function planningOutputObserver(maxOutputTokens: number) {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error('Invalid planning output allowance');
  let finishReason: PlanningOutputDiagnostic['finishReason'] = null;
  const middleware: LanguageModelMiddleware = {
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      try {
        const reason: unknown = result.finishReason.unified;
        finishReason = reason === 'stop' || reason === 'length' || reason === 'content-filter' || reason === 'tool-calls' || reason === 'error' || reason === 'other' ? reason : null;
      } catch { finishReason = null; /* Telemetry must not replace the original result or error. */ }
      return result;
    },
  };
  return { middleware, diagnostic(usage: ProviderUsage): PlanningOutputDiagnostic {
    const outputTokens = usage.providerCalls === 1 && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens !== null && usage.outputTokens >= 0 ? usage.outputTokens : null;
    return { finishReason, maxOutputTokens, outputTokens, capReached: outputTokens === null ? null : outputTokens >= maxOutputTokens };
  } };
}
