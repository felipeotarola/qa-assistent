import { DEFAULT_CHAT_MODEL, resolveChatModel, type ChatModelId } from "#shared/chat-models";

export function useChatModel() {
  const preference = useCookie<ChatModelId>("pat_chat_model", {
    default: () => DEFAULT_CHAT_MODEL,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
  return computed({
    get: () => resolveChatModel(preference.value),
    set: (value: ChatModelId) => { preference.value = resolveChatModel(value); },
  });
}
