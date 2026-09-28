import { and, eq, asc, isNull } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import type { MessageStreamEvent } from "eve/client";
import { archivedEventTypes, projectChatHistory } from "../../shared/chat-history";
import { getThreadForUser } from "./threads";

export async function saveChatEvents(userId: string, threadId: string, sessionId: string, events: MessageStreamEvent[], runtime?: string) {
  if (!await getThreadForUser(userId, threadId)) throw createError({ statusCode: 404, statusMessage: "Thread not found" });
  const accepted = events.filter(e => archivedEventTypes.has(e.type) && e.meta?.id && e.meta.at);
  if (runtime) await db.insert(schema.chatRuntimes).values({ threadId, runtime, sessionId }).onConflictDoUpdate({ target: [schema.chatRuntimes.threadId, schema.chatRuntimes.runtime], set: { sessionId }, setWhere: isNull(schema.chatRuntimes.sessionId) });
  if (accepted.length) await db.insert(schema.chatEvents).values(accepted.map(event => ({ id: `${sessionId}:${event.meta.id}`, threadId, sessionId, event, emittedAt: new Date(event.meta.at) }))).onConflictDoNothing();
}
export async function chatHistory(userId: string, threadId: string) {
  if (!await getThreadForUser(userId, threadId)) throw createError({ statusCode: 404, statusMessage: "Thread not found" });
  const events = await db.select({ sessionId: schema.chatEvents.sessionId, event: schema.chatEvents.event }).from(schema.chatEvents).innerJoin(schema.threads, eq(schema.chatEvents.threadId, schema.threads.id)).where(and(eq(schema.chatEvents.threadId, threadId), eq(schema.threads.userId, userId))).orderBy(asc(schema.chatEvents.emittedAt), asc(schema.chatEvents.id));
  return projectChatHistory(events);
}
