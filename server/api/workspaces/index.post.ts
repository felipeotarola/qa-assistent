import { z } from "zod";
import { db, schema } from "@nuxthub/db";
import { requireSessionUserId } from "../../utils/session";
export default defineEventHandler(async (event) => {
  const userId = await requireSessionUserId(event);
  const { name } = await readValidatedBody(event, z.object({ name: z.string().trim().min(1).max(100) }).parse);
  const workspace = { id: crypto.randomUUID(), name };
  await db.insert(schema.workspaces).values({ ...workspace, userId });
  return { workspace };
});
