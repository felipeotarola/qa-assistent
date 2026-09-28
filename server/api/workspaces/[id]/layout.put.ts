import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import { requireWorkspace } from "../../../utils/workspaces";
import { requireSessionUserId } from "../../../utils/session";
const input = z.object({ order: z.array(z.union([z.literal("browser"), z.string().uuid()])).max(5000).refine(ids => new Set(ids).size === ids.length) });
export default defineEventHandler(async event => {
  const userId = await requireSessionUserId(event);
  const id = getRouterParam(event, "id")!;
  await requireWorkspace(userId, id);
  const { order } = await readValidatedBody(event, input.parse);
  const items = await db.select({ id: schema.workspaceItems.id }).from(schema.workspaceItems).where(and(eq(schema.workspaceItems.workspaceId, id), isNull(schema.workspaceItems.deletedAt)));
  const allowed = new Set(["browser", ...items.map(item => item.id)]);
  if (order.some(item => !allowed.has(item))) throw createError({ statusCode: 409, statusMessage: "Workspace changed. Refresh before reordering." });
  await db.update(schema.workspaces).set({ cardOrder: order }).where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, userId)));
  return { order };
});
