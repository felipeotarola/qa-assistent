import { and, eq, desc, sql, isNull, isNotNull } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import { createHash } from 'node:crypto';
import { put, del, workspaceStorageToken } from './evidence-storage';
import type { ItemContent } from "../../shared/workspace";
import { imageReferences, documentText } from "../../shared/workspace";
import { evidenceProvenanceSchema, type EvidenceProvenance } from '../../shared/evidence-provenance';
export type WorkspaceDatabase = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export type EvidenceWriteOptions = { provenance?: EvidenceProvenance | null };

export function workspaceBlobToken() {
  return workspaceStorageToken();
}

export async function requireWorkspace(userId: string, id: string, connection: WorkspaceDatabase = db) {
  const [workspace] = await connection.select().from(schema.workspaces).where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, userId)));
  if (!workspace) throw createError({ statusCode: 404, statusMessage: "Workspace not found" });
  return workspace;
}
export async function defaultWorkspace(userId: string) {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace:${userId}`}, 0))`);
    const [existing] = await tx.select().from(schema.workspaces).where(and(eq(schema.workspaces.userId, userId), isNull(schema.workspaces.archivedAt))).orderBy(schema.workspaces.createdAt).limit(1);
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    await tx.insert(schema.workspaces).values({ id, userId, name: "Mitt workspace" });
    return id;
  });
}
export async function listWorkspaces(userId: string) {
  const rows = await db.select({ id: schema.workspaces.id, name: schema.workspaces.name, archivedAt: schema.workspaces.archivedAt }).from(schema.workspaces).where(eq(schema.workspaces.userId, userId)).orderBy(schema.workspaces.createdAt);
  if (!rows.length) { await defaultWorkspace(userId); return listWorkspaces(userId); }
  return rows.map(row => ({ ...row, archivedAt: row.archivedAt?.toISOString() ?? null }));
}
export function publicItem(row: typeof schema.workspaceItems.$inferSelect) {
  return { id: row.id, workspaceId: row.workspaceId, title: row.title, content: row.content, version: row.version, updatedAt: row.updatedAt.toISOString() };
}
export async function listItems(userId: string, workspaceId: string, trash = false) {
  await requireWorkspace(userId, workspaceId);
  const reports = await db.select({ itemId: schema.missionReports.itemId, reportId: schema.missionReports.id }).from(schema.missionReports).innerJoin(schema.missions, eq(schema.missions.id, schema.missionReports.missionId)).where(eq(schema.missions.workspaceId, workspaceId));
  const links = await db.select({ itemId: schema.workspaceEvidence.itemId, sources: sql<number>`count(*) filter (where ${schema.workspaceEvidence.kind} in ('source', 'capture'))::int`, tickets: sql<number>`count(*) filter (where ${schema.workspaceEvidence.kind} = 'ticket')::int`, related: sql<number>`count(*) filter (where ${schema.workspaceEvidence.kind} = 'item')::int` }).from(schema.workspaceEvidence).where(eq(schema.workspaceEvidence.workspaceId, workspaceId)).groupBy(schema.workspaceEvidence.itemId);
  const counts = new Map(links.map(row => [row.itemId, { sources: row.sources, tickets: row.tickets, related: row.related }]));
  return (await db.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.workspaceId, workspaceId), trash ? isNotNull(schema.workspaceItems.deletedAt) : isNull(schema.workspaceItems.deletedAt))).orderBy(desc(schema.workspaceItems.updatedAt))).map(row => ({ ...publicItem(row), reportId: reports.find(r => r.itemId === row.id)?.reportId, evidenceSummary: counts.get(row.id) }));
}
export async function ownedItem(userId: string, workspaceId: string, itemId: string, connection: WorkspaceDatabase = db) {
  await requireWorkspace(userId, workspaceId, connection);
  const [item] = await connection.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.id, itemId), eq(schema.workspaceItems.workspaceId, workspaceId)));
  if (!item || item.deletedAt) throw createError({ statusCode: 404, statusMessage: "Item not found" });
  return item;
}
export async function saveItem(userId: string, workspaceId: string, input: { title: string; content: ItemContent; id?: string; expectedVersion?: number; blobPath?: string; threadId?: string }, connection: WorkspaceDatabase = db, options: EvidenceWriteOptions = {}) {
  await requireWorkspace(userId, workspaceId, connection);
  // Never infer provenance from content, links, thread identity or the previous
  // version. A writer must attest this version through a trusted call boundary.
  const provenance = options.provenance ? evidenceProvenanceSchema.parse(options.provenance) : null;
  return connection.transaction(async tx => {
    const id = input.id ?? crypto.randomUUID();
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspaceId}`}, 0))`);
    for (const ref of imageReferences(input.content)) {
      const [image] = await tx.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.id, ref.itemId), eq(schema.workspaceItems.workspaceId, workspaceId), isNull(schema.workspaceItems.deletedAt)));
      if (!image || image.content.kind !== "image") throw createError({ statusCode: 400, statusMessage: "Image must exist in the same workspace and not be in trash" });
    }
    if (input.content.kind === "text" && input.content.blocks) input.content.text = documentText(input.content.blocks);
    if (input.content.kind === "test_plan" || input.content.kind === 'diagram') {
      for (const source of input.content.sources) {
        const [origin] = await tx.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.id, source.itemId), eq(schema.workspaceItems.workspaceId, workspaceId)));
        const [snapshot] = await tx.select({ id: schema.workspaceItemVersions.id }).from(schema.workspaceItemVersions).where(and(eq(schema.workspaceItemVersions.itemId, source.itemId), eq(schema.workspaceItemVersions.version, source.version)));
        if (!origin || !snapshot || source.itemId === id) throw createError({ statusCode: 400, statusMessage: "Source must reference an existing version in this workspace" });
      }
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`item:${id}`}, 0))`);
    const [existing] = await tx.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.id, id));
    if (existing) {
      const [report] = await tx.select({ id: schema.missionReports.id }).from(schema.missionReports).where(eq(schema.missionReports.itemId, id));
      if (report) throw createError({ statusCode: 409, statusMessage: 'Klaras rapportversion är oföränderlig. Skapa en redigerbar kopia.' });
    }
    if (input.id && (!existing || existing.deletedAt || existing.workspaceId !== workspaceId)) throw createError({ statusCode: 404, statusMessage: "Item not found" });
    if (existing && existing.version !== input.expectedVersion) throw createError({ statusCode: 409, statusMessage: "Item changed. Reload before saving." });
    if (existing?.blobPath) throw createError({ statusCode: 400, statusMessage: "Uploaded files cannot be replaced with text" });
    if (existing && existing.content.kind !== input.content.kind) throw createError({ statusCode: 400, statusMessage: "Keep the object's content type when updating" });
    // Only an ordinary new plan version adopts the current parser. Reading or
    // starting an older case must keep its exact original snapshot semantics.
    const content: ItemContent = input.content.kind === 'test_plan'
      ? { ...input.content, cases: input.content.cases.map(testCase => ({ ...testCase, checksVersion: 2 })) }
      : input.content;
    const version = (existing?.version ?? 0) + 1;
    const values = { title: input.title, content, provenance, version, updatedAt: new Date() };
    const [saved] = existing
      ? await tx.update(schema.workspaceItems).set(values).where(eq(schema.workspaceItems.id, id)).returning()
      : await tx.insert(schema.workspaceItems).values({ id, workspaceId, ...values, blobPath: input.blobPath }).returning();
    await tx.insert(schema.workspaceItemVersions).values({ id: crypto.randomUUID(), itemId: id, version, title: input.title, content, provenance });
    if (input.threadId) {
      const [thread] = await tx.select().from(schema.threads).where(and(eq(schema.threads.id, input.threadId), eq(schema.threads.userId, userId), eq(schema.threads.workspaceId, workspaceId)));
      if (!thread) throw createError({ statusCode: 404, statusMessage: "Thread not found" });
      await tx.insert(schema.workspaceEvidence).values({ id: `origin:${id}:${version}`, workspaceId, itemId: id, itemVersion: version, kind: "origin", label: "Skapat eller uppdaterat i chatt", threadId: input.threadId });
    }
    return publicItem(saved!);
  });
}
export async function setItemDeleted(userId: string, workspaceId: string, itemId: string, deleted: boolean) {
  await requireWorkspace(userId, workspaceId);
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspaceId}`}, 0))`);
    if (deleted) {
      const evidenceRuns = await tx.execute(sql`select id from pat_test_runs where workspace_id = ${workspaceId} and result->'evidenceItemIds' @> ${JSON.stringify([itemId])}::jsonb limit 1`);
      if (evidenceRuns.length) throw createError({ statusCode: 409, statusMessage: "This file is evidence in a saved test run and must be retained." });
      const captures = await tx.execute(sql`select id from pat_test_captures where item_id = ${itemId} limit 1`);
      if (captures.length) throw createError({ statusCode: 409, statusMessage: 'This screenshot belongs to a test run and must be retained.' });
      const active = await tx.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.workspaceId, workspaceId), isNull(schema.workspaceItems.deletedAt)));
      if (active.some(item => imageReferences(item.content).some(ref => ref.itemId === itemId))) throw createError({ statusCode: 409, statusMessage: "Image is used in a document or table. Remove its references first." });
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`item:${itemId}`}, 0))`);
    const [item] = await tx.update(schema.workspaceItems).set({ deletedAt: deleted ? new Date() : null })
      .where(and(eq(schema.workspaceItems.id, itemId), eq(schema.workspaceItems.workspaceId, workspaceId))).returning();
    if (!item) throw createError({ statusCode: 404, statusMessage: "Item not found" });
    return publicItem(item);
  });
}

export async function saveFile(userId: string, workspaceId: string, name: string, mime: string, bytes: Buffer, threadId?: string, connection: WorkspaceDatabase = db, options: EvidenceWriteOptions = {}) {
  await requireWorkspace(userId, workspaceId, connection);
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw createError({ statusCode: 413, statusMessage: "Files must be between 1 byte and 4 MB" });
  const filename = name.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 150) || "file";
  const safeImage = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime);
  const token = workspaceBlobToken();
  const blob = await put(`pat/workspaces/${workspaceId}/${crypto.randomUUID()}/${filename}`, bytes, { token, access: "private", contentType: mime, addRandomSuffix: true });
  try {
    const provenance: EvidenceProvenance = { ...(options.provenance ?? { version: 1, origin: 'unknown', producer: 'unknown', observedAt: null }), sha256: createHash('sha256').update(bytes).digest('hex') };
    return await saveItem(userId, workspaceId, { title: filename, content: { kind: safeImage ? "image" : "file", filename, mime, size: bytes.length }, blobPath: blob.pathname, threadId }, connection, { provenance });
  }
  catch (error) { await del(blob.pathname, { token }).catch(() => {}); throw error; }
}
