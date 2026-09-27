import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { resolveChatModel, resolveReasoning } from "../../shared/chat-models";

export function grundenModelSelection(value: unknown, reasoning?: unknown) {
  const apiKey = process.env.GRUNDEN_API_TOKEN?.trim();
  if (!apiKey) throw new Error("GRUNDEN_API_TOKEN is required to use the chat models.");

  const provider = createOpenAICompatible({
    name: "grunden",
    baseURL: "https://api.grunden.ai/v1",
    apiKey,
  });
  return {
    model: provider.chatModel(resolveChatModel(value)),
    // GET /v1/models advertises a 190,000-token usable context for both models.
    modelContextWindowTokens: 190_000,
    modelOptions: {
      providerOptions: { grunden: { reasoningEffort: resolveReasoning(reasoning) } },
    },
  };
}
