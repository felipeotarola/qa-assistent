import { createHash } from "node:crypto";
import { and, eq, desc } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import type { EvidenceInput } from "../../shared/evidence";
import { ownedItem } from "./workspaces";
import { getThreadForUser } from "./threads";
export async function addEvidence(userId: string, workspaceId: string, itemId: string, input: EvidenceInput, threadId: string, captured = false, expectedVersion?: number) {
  const item = await ownedItem(userId, workspaceId, itemId);
  if (expectedVersion !== undefined && item.version !== expectedVersion) throw createError({ statusCode: 409, statusMessage: "Item changed. Read the latest version before linking evidence." });
  const thread = await getThreadForUser(userId, threadId);
  if (thread?.workspaceId !== workspaceId) throw createError({ statusCode: 404, statusMessage: "Thread not found" });
  const target = input.kind === "item" ? await ownedItem(userId, workspaceId, input.targetItemId) : null;
  if (target?.id === itemId) throw createError({ statusCode: 400, statusMessage: "Cannot link an item to itself" });
  const id = createHash("sha256").update(JSON.stringify([itemId, item.version, input, target?.version, threadId, captured])).digest("hex");
  await db.insert(schema.workspaceEvidence).values({ id, workspaceId, itemId, itemVersion: item.version, kind: captured ? "capture" : input.kind, label: input.label, url: input.kind === "source" ? input.url : null, targetItemId: target?.id, targetVersion: target?.version, threadId, observedAt: input.kind === "source" && input.observedAt ? new Date(input.observedAt) : null }).onConflictDoNothing();
  return { saved: true, id, itemVersion: item.version };
}
export async function evidenceForItem(userId: string, workspaceId: string, itemId: string) {
  await ownedItem(userId, workspaceId, itemId);
  return db.select().from(schema.workspaceEvidence).where(and(eq(schema.workspaceEvidence.workspaceId, workspaceId), eq(schema.workspaceEvidence.itemId, itemId))).orderBy(desc(schema.workspaceEvidence.createdAt));
}
