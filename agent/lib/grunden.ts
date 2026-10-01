import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { resolveChatModel, resolveReasoning } from "../../shared/chat-models";
import { wrapLanguageModel } from 'ai';
import { finalizeBackgroundParams } from '../../shared/codex-handoff.mjs';

export function grundenModelSelection(value: unknown, reasoning?: unknown, finishBackgroundTurn = false, browserWorker = false, reportOnly = false) {
  const apiKey = process.env.GRUNDEN_API_TOKEN?.trim();
  if (!apiKey) throw new Error("GRUNDEN_API_TOKEN is required to use the chat models.");

  const provider = createOpenAICompatible({
    name: "grunden",
    baseURL: "https://api.grunden.ai/v1",
    apiKey,
  });
  const model = provider.chatModel(resolveChatModel(value));
  return {
    model: finishBackgroundTurn || browserWorker || reportOnly ? wrapLanguageModel({ model, middleware: {
      transformParams: async ({ params }) => reportOnly ? { ...params, tools: [], toolChoice: { type: 'none' as const } } : finishBackgroundTurn ? finalizeBackgroundParams(params) : { ...params, tools: params.tools?.filter(tool => ['browser', 'workspace', 'test_run', 'test_plan', 'test_requirement', 'external', 'quality'].includes(tool.name) || tool.name.endsWith('load_skill')) },
    } }) : model,
    // GET /v1/models advertises a 190,000-token usable context for both models.
    modelContextWindowTokens: 190_000,
    modelOptions: {
      providerOptions: { grunden: { reasoningEffort: resolveReasoning(reasoning) } },
    },
  };
}
