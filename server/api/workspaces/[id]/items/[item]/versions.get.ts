import { eq, desc } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import { ownedItem } from "../../../../../utils/workspaces";
import { requireSessionUserId } from "../../../../../utils/session";
export default defineEventHandler(async (event) => {
  const item = await ownedItem(await requireSessionUserId(event), getRouterParam(event, "id")!, getRouterParam(event, "item")!);
  return { versions: await db.select().from(schema.workspaceItemVersions).where(eq(schema.workspaceItemVersions.itemId, item.id)).orderBy(desc(schema.workspaceItemVersions.version)) };
});
