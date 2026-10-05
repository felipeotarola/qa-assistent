import { and, eq, asc, isNull, inArray } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import type { MessageStreamEvent } from "eve/client";
import { archivedEventTypes, projectChatHistory } from "../../shared/chat-history";
import { getThreadForUser } from "./threads";

export async function saveChatEvents(userId: string, threadId: string, sessionId: string, events: MessageStreamEvent[], runtime?: string) {
  if (!await getThreadForUser(userId, threadId)) throw createError({ statusCode: 404, statusMessage: "Thread not found" });
  const accepted = events.filter(e => archivedEventTypes.has(e.type) && e.meta?.id && e.meta.at);
  if (runtime) await db.insert(schema.chatRuntimes).values({ threadId, runtime, sessionId }).onConflictDoUpdate({ target: [schema.chatRuntimes.threadId, schema.chatRuntimes.runtime], set: { sessionId }, setWhere: isNull(schema.chatRuntimes.sessionId) });
  const [binding] = await db.select().from(schema.chatRuntimes).where(and(eq(schema.chatRuntimes.threadId, threadId), eq(schema.chatRuntimes.sessionId, sessionId))).limit(1);
  // Self-delegated agents can inherit root hooks. Only the registered root
  // runtime may append to the user transcript; child streams stay in Eve.
  if (!binding) return;
  if (accepted.length) await db.insert(schema.chatEvents).values(accepted.map(event => ({ id: `${sessionId}:${event.meta.id}`, threadId, sessionId, event, emittedAt: new Date(event.meta.at) }))).onConflictDoNothing();
}
export async function chatHistory(userId: string, threadId: string) {
  return (await chatHistorySnapshot(userId, threadId)).messages;
}
export async function chatHistorySnapshot(userId: string, threadId: string) {
  const thread = await getThreadForUser(userId, threadId);
  if (!thread) throw createError({ statusCode: 404, statusMessage: "Thread not found" });
  const roots = db.select({ sessionId: schema.chatRuntimes.sessionId }).from(schema.chatRuntimes).where(eq(schema.chatRuntimes.threadId, threadId));
  const events = await db.select({ sessionId: schema.chatEvents.sessionId, event: schema.chatEvents.event }).from(schema.chatEvents).innerJoin(schema.threads, eq(schema.chatEvents.threadId, schema.threads.id)).where(and(eq(schema.chatEvents.threadId, threadId), eq(schema.threads.userId, userId), inArray(schema.chatEvents.sessionId, roots))).orderBy(asc(schema.chatEvents.emittedAt), asc(schema.chatEvents.id));
  const cursors = new Map<string, string>();
  for (const row of events) cursors.set(row.sessionId, row.event.meta.id);
  const acceptedMessageIds = events.flatMap(({ event }) => {
    if (event.type !== 'message.received') return [];
    const id = (event.data as typeof event.data & { clientMessageId?: string }).clientMessageId;
    return typeof id === 'string' ? [id] : [];
  });
  return { messages: projectChatHistory(events), cursors: [...cursors].map(([sessionId, eventId]) => ({ sessionId, eventId })), sessionId: thread.sessionId, acceptedMessageIds };
}

export async function isChatRoot(userId: string, threadId: string, sessionId: string) {
  if (!await getThreadForUser(userId, threadId)) throw createError({ statusCode: 404, statusMessage: "Thread not found" });
  const [binding] = await db.select({ sessionId: schema.chatRuntimes.sessionId }).from(schema.chatRuntimes).where(and(eq(schema.chatRuntimes.threadId, threadId), eq(schema.chatRuntimes.sessionId, sessionId))).limit(1);
  return !!binding;
}
