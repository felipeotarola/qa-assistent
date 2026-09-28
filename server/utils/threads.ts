import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import type { ThreadRecord, ThreadSummary } from "#shared/types/thread";
import { truncateThreadTitle } from "#shared/types/thread";
import { defaultWorkspace, requireWorkspace } from "./workspaces";
import { runtimeScope } from "../../shared/runtime-scope";

function rowToSummary(row: typeof schema.threads.$inferSelect): ThreadSummary {
  return {
    id: row.id,
    title: row.title,
    workspaceId: row.workspaceId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

async function rowToRecord(row: typeof schema.threads.$inferSelect): Promise<ThreadRecord> {
  const [binding] = await db.select().from(schema.chatRuntimes).where(and(eq(schema.chatRuntimes.threadId, row.id), eq(schema.chatRuntimes.runtime, runtimeScope())));
  return {
    ...rowToSummary(row),
    sessionId: binding?.sessionId ?? null,
  };
}

export async function listThreadsForUser(userId: string): Promise<ThreadSummary[]> {
  const rows = await db.select()
    .from(schema.threads)
    .where(eq(schema.threads.userId, userId))
    .orderBy(desc(schema.threads.updatedAt));

  return rows.map(rowToSummary);
}

export async function getThreadForUser(userId: string, id: string) {
  const [row] = await db.select()
    .from(schema.threads)
    .where(and(
      eq(schema.threads.id, id),
      eq(schema.threads.userId, userId),
    ))
    .limit(1);

  return row ? rowToRecord(row) : undefined;
}

export async function createThreadForUser(
  userId: string,
  input: { id?: string; title?: string; workspaceId?: string },
) {
  const id = input.id ?? crypto.randomUUID();
  const title = input.title?.trim() || "New chat";
  const workspaceId = input.workspaceId ?? await defaultWorkspace(userId);
  await requireWorkspace(userId, workspaceId);

  await db.insert(schema.threads).values({
    id,
    userId,
    workspaceId,
    title: truncateThreadTitle(title),
  });

  const created = await getThreadForUser(userId, id);
  if (!created) {
    throw createError({
      statusCode: 500,
      statusMessage: "Failed to create thread",
    });
  }

  return created;
}

export async function updateThreadForUser(
  userId: string,
  id: string,
  patch: {
    title?: string;
    sessionId?: string;
  },
) {
  const existing = await getThreadForUser(userId, id);
  if (!existing) {
    return undefined;
  }
  if (patch.sessionId !== undefined && patch.sessionId !== existing.sessionId) {
    throw createError({ statusCode: 409, statusMessage: "Session is not registered to this chat in this environment. Reload the chat." });
  }

  await db.update(schema.threads)
    .set({
      updatedAt: new Date(),
      ...(patch.title !== undefined ? { title: truncateThreadTitle(patch.title) } : {}),
    })
    .where(and(
      eq(schema.threads.id, id),
      eq(schema.threads.userId, userId),
    ));

  return getThreadForUser(userId, id);
}

export async function deleteThreadForUser(userId: string, id: string) {
  const existing = await getThreadForUser(userId, id);
  if (!existing) {
    return false;
  }

  await db.delete(schema.threads)
    .where(and(
      eq(schema.threads.id, id),
      eq(schema.threads.userId, userId),
    ));

  return true;
}
