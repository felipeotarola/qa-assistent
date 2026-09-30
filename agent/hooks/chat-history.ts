import { defineHook } from "eve/hooks";
import { appOrigin, internalHeaders } from "../lib/internal-api";
import { runtimeScope } from "../../shared/runtime-scope";
import { defineState } from "eve/context";
import type { MessageStreamEvent } from "eve/client";

const persisted = new Set(["session.started", "turn.started", "message.received", "message.completed", "reasoning.completed", "actions.requested", "action.result", "step.started", "step.completed", "step.failed", "turn.completed", "turn.failed", "turn.cancelled", "session.waiting", "session.completed", "session.failed", "result.completed"]);
// Eve checkpoints this queue with the step. Delivery is awaited at boundaries,
// never left in a promise that a serverless process could discard. The API
// deduplicates event IDs if a committed batch's acknowledgement is lost.
const pending = defineState<MessageStreamEvent[]>("app.chat-history.pending.v1", () => []);
const boundaries = new Set(["session.started", "step.completed", "step.failed", "turn.completed", "turn.failed", "turn.cancelled", "session.waiting", "session.completed", "session.failed"]);
export default defineHook({
  events: {
    async "*"(event, ctx) {
      const auth = ctx.session.auth.current;
      const threadId = auth?.attributes.browserThreadId;
      if (ctx.session.parent || !persisted.has(event.type) || auth?.authenticator !== "app" || typeof threadId !== "string" || !threadId) return;
      pending.update(events => events.some(saved => saved.meta.id === event.meta.id) ? events : [...events, event]);
      if (!boundaries.has(event.type) && pending.get().length < 50) return;
      const batch = pending.get().slice(0, 100);
      const response = await fetch(`${appOrigin()}/api/internal/chat-history`, { method: "POST", headers: internalHeaders(), body: JSON.stringify({ userId: auth.principalId, threadId, sessionId: ctx.session.id, runtime: runtimeScope(), events: batch }), signal: AbortSignal.timeout(15000) });
      // Fail visibly instead of silently dropping the shared conversation.
      if (!response.ok) throw new Error("Could not save shared chat history");
      const acknowledged = new Set(batch.map(saved => saved.meta.id));
      pending.update(events => events.filter(saved => !acknowledged.has(saved.meta.id)));
    },
  },
});
