import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import { contentSchema } from "../../../shared/workspace";
import { evidenceInputSchema } from "../../../shared/evidence";
import { addEvidence, evidenceForItem } from "../../utils/evidence";
import { requireInternalRequest } from "../../utils/internal-api";
import { getThreadForUser } from "../../utils/threads";
import { listItems, ownedItem, publicItem, requireWorkspace, saveItem, saveFile } from "../../utils/workspaces";
import { captureWorkspaceBrowser } from "../../utils/browser";

const inputSchema = z.object({
  action: z.enum(["list", "read", "create", "update", "save_file", "screenshot", "link", "evidence"]),
  evidence: evidenceInputSchema.optional(),
  sessionId: z.string().min(1).max(200).optional(),
  version: z.number().int().positive().optional(),
  itemId: z.string().uuid().optional(), title: z.string().min(1).max(200).optional(),
  content: contentSchema.optional(), expectedVersion: z.number().int().positive().optional(),
  filename: z.string().max(150).optional(), text: z.string().max(200000).optional(),
});
export default defineEventHandler(async (event) => {
  requireInternalRequest(event);
  const { userId, threadId, agentId, input } = await readValidatedBody(event, z.object({ userId: z.string().uuid(), threadId: z.string().uuid(), agentId: z.string().min(1).max(200).default('main'), input: inputSchema }).parse);
  const thread = await getThreadForUser(userId, threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: "Workspace not found" });
  const workspaceId = thread.workspaceId;
  const workspace = await requireWorkspace(userId, workspaceId);
  switch (input.action) {
    case "evidence": return { links: await evidenceForItem(userId, workspaceId, input.itemId ?? "") };
    case "link": {
      if (!input.itemId || !input.evidence || !input.expectedVersion) throw createError({ statusCode: 400, statusMessage: "itemId, expectedVersion and evidence required" });
      return addEvidence(userId, workspaceId, input.itemId, input.evidence, threadId, false, input.expectedVersion);
    }
    case "list": return { workspace: { id: workspace.id, name: workspace.name }, items: (await listItems(userId, workspaceId)).map(({ id, title, content, version }) => ({ id, title, kind: content.kind, version })) };
    case "read": {
      const item = publicItem(await ownedItem(userId, workspaceId, input.itemId ?? ""));
      if (input.version === undefined) return { item };
      const [snapshot] = await db.select().from(schema.workspaceItemVersions).where(and(eq(schema.workspaceItemVersions.itemId, item.id), eq(schema.workspaceItemVersions.version, input.version)));
      if (!snapshot) throw createError({ statusCode: 404, statusMessage: "Source version not found" });
      return { item: { ...item, title: snapshot.title, content: snapshot.content, version: snapshot.version }, historical: true };
    }
    case "create":
    case "update": {
      if (!input.content || (input.action === "create" && !input.title) || (input.action === "update" && (!input.itemId || !input.expectedVersion))) throw createError({ statusCode: 400, statusMessage: "Create requires title/content. Update requires itemId/content/expectedVersion; title is optional." });
      const title = input.title ?? (await ownedItem(userId, workspaceId, input.itemId!)).title;
      return { item: await saveItem(userId, workspaceId, { title, content: input.content, threadId, ...(input.action === "update" ? { id: input.itemId, expectedVersion: input.expectedVersion } : {}) }) };
    }
    case "save_file": {
      if (!input.filename || input.text === undefined) throw createError({ statusCode: 400, statusMessage: "Filename and text required" });
      return { item: await saveFile(userId, workspaceId, input.filename, "text/plain", Buffer.from(input.text), threadId) };
    }
    case "screenshot": {
      const bytes = await captureWorkspaceBrowser(userId, threadId, { agentId, sessionId: input.sessionId });
      return { item: await saveFile(userId, workspaceId, `${input.title || "Skärmbild"}.png`, "image/png", bytes, threadId) };
    }
  }
});
