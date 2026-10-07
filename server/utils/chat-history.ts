import { and, eq, asc, desc, isNull, inArray, sql } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import type { MessageStreamEvent } from "eve/client";
import { archivedEventTypes, projectChatHistory } from "../../shared/chat-history";
import { getThreadForUser } from "./threads";
import { runtimeScope } from '../../shared/runtime-scope';
import { bindMissionRequest, missionRequestContextSchema, trustedRequestMessage, type RequestMessageRow } from '../../shared/mission-request-context';

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

async function requireRequestRoot(userId: string, threadId: string, sessionId: string, runtime: string) {
  const thread = await getThreadForUser(userId, threadId);
  if (!thread || runtime !== runtimeScope() || thread.sessionId !== sessionId) {
    throw createError({ statusCode: 409, statusMessage: 'The current chat runtime is not registered.' });
  }
  const roots = await db.select({ threadId: schema.chatRuntimes.threadId }).from(schema.chatRuntimes)
    .where(and(eq(schema.chatRuntimes.sessionId, sessionId), eq(schema.chatRuntimes.runtime, runtime)));
  if (roots.length !== 1 || roots[0]!.threadId !== threadId) {
    throw createError({ statusCode: 409, statusMessage: 'Ambiguous chat runtime binding.' });
  }
}

function requestRows(threadId: string) {
  return db.select({ id: schema.chatEvents.id, sessionId: schema.chatEvents.sessionId,
    runtime: schema.chatRuntimes.runtime, event: schema.chatEvents.event }).from(schema.chatEvents)
    .innerJoin(schema.chatRuntimes, and(eq(schema.chatEvents.threadId, schema.chatRuntimes.threadId), eq(schema.chatEvents.sessionId, schema.chatRuntimes.sessionId)))
    .where(and(eq(schema.chatEvents.threadId, threadId), sql`${schema.chatEvents.event}->>'type' = 'message.received'`)).$dynamic();
}

/** Existing immutable archive rows are the source, not the model's goal text. */
export async function resolveMissionRequest(userId: string, threadId: string, value: unknown) {
  const context = missionRequestContextSchema.parse(value);
  await requireRequestRoot(userId, threadId, context.sessionId, context.runtime);
  const rows = await requestRows(threadId).where(and(eq(schema.chatEvents.threadId, threadId),
    sql`${schema.chatEvents.event}->>'type' = 'message.received'`,
    sql`((${schema.chatEvents.sessionId} = ${context.sessionId} and ${schema.chatEvents.event}->'data'->>'turnId' = ${context.turnId})
      or ${context.priorUserMessageIds.length ? inArray(schema.chatEvents.id, context.priorUserMessageIds) : sql`false`})`)).limit(20);
  const [latest] = await db.select({ event: schema.chatEvents.event }).from(schema.chatEvents)
    .where(and(eq(schema.chatEvents.threadId, threadId), eq(schema.chatEvents.sessionId, context.sessionId),
      sql`${schema.chatEvents.event}->>'type' = 'turn.started'`))
    .orderBy(desc(sql`case when jsonb_typeof(${schema.chatEvents.event}->'data'->'sequence') = 'number' then (${schema.chatEvents.event}->'data'->>'sequence')::numeric else -1 end`)).limit(1);
  if (latest?.event.type !== 'turn.started' || latest.event.data.turnId !== context.turnId) {
    throw createError({ statusCode: 409, statusMessage: 'The user request does not belong to the current turn.' });
  }
  try { return bindMissionRequest(rows as RequestMessageRow[], userId, threadId, context); }
  catch { throw createError({ statusCode: 409, statusMessage: 'The original user request or its prior references could not be verified in full.' }); }
}

/** A bounded lookup index is data only; admission rechecks selected originals. */
export async function priorRequestMessages(userId: string, threadId: string, sessionId: string, runtime: string, turnId: string) {
  await requireRequestRoot(userId, threadId, sessionId, runtime);
  const rows = await requestRows(threadId).orderBy(desc(schema.chatEvents.emittedAt), desc(schema.chatEvents.id)).limit(32);
  const selected: { requestMessageId: string; text: string }[] = [];
  let length = 0;
  for (const row of rows) {
    const message = trustedRequestMessage(row as RequestMessageRow, userId, threadId);
    if (!message || (message.source.sessionId === sessionId && message.source.turnId === turnId)) continue;
    if (length + message.text.length > 10000 || selected.length === 8) break;
    selected.unshift({ requestMessageId: message.id, text: message.text });
    length += message.text.length;
  }
  return selected;
}
