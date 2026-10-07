import { z } from "zod";
import type { MessageStreamEvent } from "eve/client";
import { requireInternalRequest } from "../../utils/internal-api";
import { chatHistory, isChatRoot, saveChatEvents, priorRequestMessages } from "../../utils/chat-history";

export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const body = await readValidatedBody(event, z.object({ userId: z.string().uuid(), threadId: z.string().uuid(), sessionId: z.string().min(1), runtime: z.string().max(300).optional(), requestTurnId: z.string().min(1).max(400).optional(), events: z.array(z.object({ type: z.string(), meta: z.object({ id: z.string(), at: z.string().datetime() }) }).passthrough()).max(100).optional() }).parse);
  if (body.events) {
    await saveChatEvents(body.userId, body.threadId, body.sessionId, body.events as MessageStreamEvent[], body.runtime);
    return { saved: true };
  }
  if (!await isChatRoot(body.userId, body.threadId, body.sessionId)) return { context: '[]', truncated: false };
  const history = await chatHistory(body.userId, body.threadId);
  // Previous turns in this runtime already live in Eve's own model history.
  const messages = history.filter(m => m.sessionId !== body.sessionId).map(m => ({ role: m.message.role, text: m.message.parts.filter(p => p.type === "text").map(p => "text" in p ? p.text : "").join("\n") })).filter(m => m.text);
  const selected: typeof messages = [];
  let length = 2;
  for (const message of [...messages].reverse()) {
    const entry = { ...message, text: message.text.slice(-50000) };
    const size = JSON.stringify(entry).length + 1;
    if (length + size > 60000) break;
    selected.unshift(entry); length += size;
  }
  const requestMessages = body.requestTurnId && body.runtime
    ? await priorRequestMessages(body.userId, body.threadId, body.sessionId, body.runtime, body.requestTurnId) : [];
  return { requestMessages, context: JSON.stringify(selected), truncated: selected.length < messages.length || messages.some(m => m.text.length > 50000) };
});
