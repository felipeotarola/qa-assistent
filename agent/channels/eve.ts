import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { vercelOidc } from "eve/channels/auth";
import { createRequestSupabase } from "../../shared/supabase";
import { CHAT_MODEL_HEADER, REASONING_HEADER, resolveChatModel, resolveReasoning } from "../../shared/chat-models";
import { BROWSER_THREAD_HEADER } from "../../shared/browser";
import { browserUserInputMarker } from '../../shared/mission-request-context';
import { CHAT_MESSAGE_HEADER } from '../../shared/chat-recovery';

function appSession(): AuthFn<Request> {
  return async (request) => {
    const client = createRequestSupabase(request.headers.get("cookie") || "");
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) {
      return null;
    }

    return {
      attributes: {
        browserUserInput: await browserUserInputMarker(request),
        browserThreadId: request.headers.get(BROWSER_THREAD_HEADER) ?? "",
        browserMessageId: /^[a-f0-9-]{36}$/i.test(request.headers.get(CHAT_MESSAGE_HEADER) ?? '') ? request.headers.get(CHAT_MESSAGE_HEADER)! : '',
        chatModel: resolveChatModel(request.headers.get(CHAT_MODEL_HEADER)),
        reasoning: resolveReasoning(request.headers.get(REASONING_HEADER)),
        email: data.user.email ?? "",
        name: typeof data.user.user_metadata?.name === "string" ? data.user.user_metadata.name : "",
      },
      authenticator: "app",
      issuer: "app",
      principalId: data.user.id,
      principalType: "user",
    };
  };
}

export default eveChannel({
  auth: [
    appSession(),
    vercelOidc(),
  ],
});
