import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { resolveChatModel, resolveReasoning } from "../../shared/chat-models";
import { wrapLanguageModel } from 'ai';
import { finalizeBackgroundParams } from '../../shared/codex-handoff.mjs';

export function grundenModelSelection(value: unknown, reasoning?: unknown, finishBackgroundTurn = false) {
  const apiKey = process.env.GRUNDEN_API_TOKEN?.trim();
  if (!apiKey) throw new Error("GRUNDEN_API_TOKEN is required to use the chat models.");

  const provider = createOpenAICompatible({
    name: "grunden",
    baseURL: "https://api.grunden.ai/v1",
    apiKey,
  });
  const model = provider.chatModel(resolveChatModel(value));
  return {
    model: finishBackgroundTurn ? wrapLanguageModel({ model, middleware: {
      transformParams: async ({ params }) => finalizeBackgroundParams(params),
    } }) : model,
    // GET /v1/models advertises a 190,000-token usable context for both models.
    modelContextWindowTokens: 190_000,
    modelOptions: {
      providerOptions: { grunden: { reasoningEffort: resolveReasoning(reasoning) } },
    },
  };
}
