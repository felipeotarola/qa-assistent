import { and, eq, desc, sql, isNull, isNotNull } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import { put, del } from "@vercel/blob";
import type { ItemContent } from "../../shared/workspace";
import { imageReferences } from "../../shared/workspace";

export function workspaceBlobToken() {
  const token = process.env.WORKSPACE_BLOB_READ_WRITE_TOKEN;
  if (!token) throw createError({ statusCode: 503, statusMessage: "Configure WORKSPACE_BLOB_READ_WRITE_TOKEN for a private Blob store" });
  return token;
}

export async function requireWorkspace(userId: string, id: string) {
  const [workspace] = await db.select().from(schema.workspaces).where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, userId)));
  if (!workspace) throw createError({ statusCode: 404, statusMessage: "Workspace not found" });
  return workspace;
}
export async function defaultWorkspace(userId: string) {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace:${userId}`}, 0))`);
    const [existing] = await tx.select().from(schema.workspaces).where(eq(schema.workspaces.userId, userId)).orderBy(schema.workspaces.createdAt).limit(1);
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    await tx.insert(schema.workspaces).values({ id, userId, name: "Mitt workspace" });
    return id;
  });
}
export async function listWorkspaces(userId: string) {
  await defaultWorkspace(userId);
  return db.select({ id: schema.workspaces.id, name: schema.workspaces.name }).from(schema.workspaces).where(eq(schema.workspaces.userId, userId)).orderBy(schema.workspaces.createdAt);
}
export function publicItem(row: typeof schema.workspaceItems.$inferSelect) {
  return { id: row.id, workspaceId: row.workspaceId, title: row.title, content: row.content, version: row.version, updatedAt: row.updatedAt.toISOString() };
}
export async function listItems(userId: string, workspaceId: string, trash = false) {
  await requireWorkspace(userId, workspaceId);
  return (await db.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.workspaceId, workspaceId), trash ? isNotNull(schema.workspaceItems.deletedAt) : isNull(schema.workspaceItems.deletedAt))).orderBy(desc(schema.workspaceItems.updatedAt))).map(publicItem);
}
export async function ownedItem(userId: string, workspaceId: string, itemId: string) {
  await requireWorkspace(userId, workspaceId);
  const [item] = await db.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.id, itemId), eq(schema.workspaceItems.workspaceId, workspaceId)));
  if (!item || item.deletedAt) throw createError({ statusCode: 404, statusMessage: "Item not found" });
  return item;
}
export async function saveItem(userId: string, workspaceId: string, input: { title: string; content: ItemContent; id?: string; expectedVersion?: number; blobPath?: string }) {
  await requireWorkspace(userId, workspaceId);
  return db.transaction(async tx => {
    const id = input.id ?? crypto.randomUUID();
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspaceId}`}, 0))`);
    for (const ref of imageReferences(input.content)) {
      const [image] = await tx.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.id, ref.itemId), eq(schema.workspaceItems.workspaceId, workspaceId), isNull(schema.workspaceItems.deletedAt)));
      if (!image || image.content.kind !== "image") throw createError({ statusCode: 400, statusMessage: "Image must exist in the same workspace and not be in trash" });
    }
    if (input.content.kind === "text" && input.content.blocks) input.content.text = input.content.blocks.filter(b => b.kind !== "image").map(b => b.text).join("\n\n");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`item:${id}`}, 0))`);
    const [existing] = await tx.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.id, id));
    if (input.id && (!existing || existing.deletedAt || existing.workspaceId !== workspaceId)) throw createError({ statusCode: 404, statusMessage: "Item not found" });
    if (existing && existing.version !== input.expectedVersion) throw createError({ statusCode: 409, statusMessage: "Item changed. Reload before saving." });
    if (existing?.blobPath) throw createError({ statusCode: 400, statusMessage: "Uploaded files cannot be replaced with text" });
    if (existing && existing.content.kind !== input.content.kind) throw createError({ statusCode: 400, statusMessage: "Keep the object's content type when updating" });
    const version = (existing?.version ?? 0) + 1;
    const values = { title: input.title, content: input.content, version, updatedAt: new Date() };
    const [saved] = existing
      ? await tx.update(schema.workspaceItems).set(values).where(eq(schema.workspaceItems.id, id)).returning()
      : await tx.insert(schema.workspaceItems).values({ id, workspaceId, ...values, blobPath: input.blobPath }).returning();
    await tx.insert(schema.workspaceItemVersions).values({ id: crypto.randomUUID(), itemId: id, version, title: input.title, content: input.content });
    return publicItem(saved!);
  });
}
export async function setItemDeleted(userId: string, workspaceId: string, itemId: string, deleted: boolean) {
  await requireWorkspace(userId, workspaceId);
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspaceId}`}, 0))`);
    if (deleted) {
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

export async function saveFile(userId: string, workspaceId: string, name: string, mime: string, bytes: Buffer) {
  await requireWorkspace(userId, workspaceId);
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw createError({ statusCode: 413, statusMessage: "Files must be between 1 byte and 4 MB" });
  const filename = name.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 150) || "file";
  const safeImage = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime);
  const token = workspaceBlobToken();
  const blob = await put(`pat/workspaces/${workspaceId}/${crypto.randomUUID()}/${filename}`, bytes, { token, access: "private", contentType: mime, addRandomSuffix: true });
  try {
    return await saveItem(userId, workspaceId, { title: filename, content: { kind: safeImage ? "image" : "file", filename, mime, size: bytes.length }, blobPath: blob.pathname });
  }
  catch (error) { await del(blob.pathname, { token }).catch(() => {}); throw error; }
}
