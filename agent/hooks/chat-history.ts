import { defineHook } from "eve/hooks";
import { appOrigin, internalHeaders } from "../lib/internal-api";
import { runtimeScope } from "../../shared/runtime-scope";

const persisted = new Set(["session.started", "turn.started", "message.received", "message.completed", "reasoning.completed", "actions.requested", "action.result", "step.started", "step.completed", "step.failed", "turn.completed", "turn.failed", "turn.cancelled", "session.waiting", "session.completed", "session.failed", "result.completed"]);
export default defineHook({
  events: {
    async "*"(event, ctx) {
      const auth = ctx.session.auth.current;
      const threadId = auth?.attributes.browserThreadId;
      if (!persisted.has(event.type) || auth?.authenticator !== "app" || typeof threadId !== "string" || !threadId) return;
      const response = await fetch(`${appOrigin()}/api/internal/chat-history`, { method: "POST", headers: internalHeaders(), body: JSON.stringify({ userId: auth.principalId, threadId, sessionId: ctx.session.id, runtime: runtimeScope(), events: [event] }), signal: AbortSignal.timeout(15000) });
      // Fail visibly instead of silently dropping the shared conversation.
      if (!response.ok) throw new Error("Could not save shared chat history");
    },
  },
});
