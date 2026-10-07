import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { resolveChatModel, resolveReasoning } from "../../shared/chat-models";
import { wrapLanguageModel } from 'ai';
import { finalizeBackgroundParams } from '../../shared/codex-handoff.mjs';
import { assertIrisToolOutput, IRIS_TOOL_NAMES } from './iris-capabilities';
import { providerPacingMiddleware } from './provider-pacing';
import { providerPacingInterval } from '../../shared/provider-pacing';

export function grundenModelSelection(value: unknown, reasoning?: unknown, finishBackgroundTurn = false, browserWorker = false, reportOnly = false) {
  const apiKey = process.env.GRUNDEN_API_TOKEN?.trim();
  if (!apiKey) throw new Error("GRUNDEN_API_TOKEN is required to use the chat models.");

  const provider = createOpenAICompatible({
    name: "grunden",
    baseURL: "https://api.grunden.ai/v1",
    apiKey,
  });
  const rawModel = provider.chatModel(resolveChatModel(value));
  // Iris owns a stronger physical admission/usage wrapper; pacing there must
  // precede its model_started receipt, so never wrap it twice here.
  const model = !browserWorker && providerPacingInterval(process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS)
    ? wrapLanguageModel({ model: rawModel, middleware: providerPacingMiddleware() }) : rawModel;
  return {
    model: finishBackgroundTurn || browserWorker || reportOnly ? wrapLanguageModel({ model, middleware: {
      transformParams: async ({ params }) => reportOnly ? { ...params, tools: [], toolChoice: { type: 'none' as const } } : finishBackgroundTurn ? finalizeBackgroundParams(params) : { ...params, tools: params.tools?.filter(tool => IRIS_TOOL_NAMES.some(name => name === tool.name)) },
      ...(browserWorker ? {
        wrapGenerate: async ({ doGenerate }) => {
          const result = await doGenerate();
          for (const part of result.content) assertIrisToolOutput(part);
          return result;
        },
        wrapStream: async ({ doStream }) => {
          const result = await doStream();
          return { ...result, stream: result.stream.pipeThrough(new TransformStream({ transform(part, controller) { assertIrisToolOutput(part); controller.enqueue(part); } })) };
        },
      } : {}),
    } }) : model,
    // GET /v1/models advertises a 190,000-token usable context for both models.
    modelContextWindowTokens: 190_000,
    modelOptions: {
      providerOptions: { grunden: { reasoningEffort: resolveReasoning(reasoning) } },
    },
  };
}
