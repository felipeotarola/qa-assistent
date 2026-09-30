export const CHAT_MODELS = [
  { id: "glm-5.3", label: "GLM 5.3" },
  { id: "glm-5.3-flash", label: "Flash" },
] as const;

export type ChatModelId = typeof CHAT_MODELS[number]["id"];
export const DEFAULT_CHAT_MODEL: ChatModelId = "glm-5.3-flash";
export const CHAT_MODEL_HEADER = "x-pat-chat-model";

export function resolveChatModel(value: unknown): ChatModelId {
  return CHAT_MODELS.find(model => model.id === value)?.id ?? DEFAULT_CHAT_MODEL;
}

export const REASONING_LEVELS = ["low", "high", "max"] as const;
export type ReasoningLevel = typeof REASONING_LEVELS[number];
export const DEFAULT_REASONING: ReasoningLevel = "low";
export const REASONING_HEADER = "x-pat-reasoning";

export function resolveReasoning(value: unknown): ReasoningLevel {
  return REASONING_LEVELS.find(level => level === value) ?? DEFAULT_REASONING;
}
