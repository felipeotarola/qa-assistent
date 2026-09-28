import { and, eq, isNull, desc, sql } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import { getThreadForUser } from "./threads";
import { requireWorkspace } from "./workspaces";

/** Bounded discovery metadata, never credentials or entire private documents. */
export async function workspaceContext(userId: string, threadId: string) {
  const thread = await getThreadForUser(userId, threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: "Workspace not found" });
  const workspace = await requireWorkspace(userId, thread.workspaceId);
  const [items, destinations, operations, browsers] = await Promise.all([
    db.select({ id: schema.workspaceItems.id, title: schema.workspaceItems.title, kind: sql<string>`${schema.workspaceItems.content}->>'kind'`, version: schema.workspaceItems.version, updatedAt: schema.workspaceItems.updatedAt }).from(schema.workspaceItems).where(and(eq(schema.workspaceItems.workspaceId, workspace.id), isNull(schema.workspaceItems.deletedAt))).orderBy(desc(schema.workspaceItems.updatedAt), desc(schema.workspaceItems.id)).limit(26),
    db.select({ destination: schema.workspaceDestinations.destination }).from(schema.workspaceDestinations).where(eq(schema.workspaceDestinations.workspaceId, workspace.id)),
    db.select({ id: schema.externalOperations.id, provider: schema.externalOperations.provider, action: schema.externalOperations.action, state: schema.externalOperations.state, result: schema.externalOperations.result, createdAt: schema.externalOperations.createdAt }).from(schema.externalOperations).where(eq(schema.externalOperations.workspaceId, workspace.id)).orderBy(desc(schema.externalOperations.createdAt)).limit(5),
    db.select({ url: schema.workspaceBrowsers.url, title: schema.workspaceBrowsers.title, control: schema.workspaceBrowsers.control, expiresAt: schema.workspaceBrowsers.expiresAt }).from(schema.workspaceBrowsers).where(and(eq(schema.workspaceBrowsers.workspaceId, workspace.id), eq(schema.workspaceBrowsers.userId, userId))),
  ]);
  const browser = browsers[0];
  let page: string | null = null;
  try { const url = new URL(browser?.url || ""); if (["http:", "https:"].includes(url.protocol)) page = `${url.origin}${url.pathname}`; } catch { /* No known page. */ }
  return {
    workspace: { id: workspace.id, name: workspace.name },
    thread: { id: thread.id, title: thread.title },
    items: items.slice(0, 25), itemsTruncated: items.length > 25,
    destinations: destinations.map(row => row.destination),
    recentOperations: operations.map(row => ({ id: row.id, provider: row.provider, action: row.action, state: row.state, createdAt: row.createdAt, result: row.result ? { id: row.result.id, title: row.result.title, url: row.result.url } : null })),
    browser: browser ? { lastKnownPage: page, title: browser.title, control: browser.control, active: !!browser.expiresAt && browser.expiresAt > new Date() } : null,
  };
}
