import { DEFAULT_REASONING, resolveReasoning, type ReasoningLevel } from "#shared/chat-models";

export function useChatReasoning() {
  const preference = useCookie<ReasoningLevel>("pat_chat_reasoning", {
    default: () => DEFAULT_REASONING,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
  return computed({
    get: () => resolveReasoning(preference.value),
    set: (value: ReasoningLevel) => { preference.value = resolveReasoning(value); },
  });
}
