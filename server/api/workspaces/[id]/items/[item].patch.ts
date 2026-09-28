import { z } from "zod";
import { itemWriteSchema } from "../../../../../shared/workspace";
import { saveItem } from "../../../../utils/workspaces";
import { requireSessionUserId } from "../../../../utils/session";
export default defineEventHandler(async (event) => {
  const userId = await requireSessionUserId(event);
  const input = await readValidatedBody(event, itemWriteSchema.extend({ expectedVersion: z.number().int().positive() }).parse);
  return { item: await saveItem(userId, getRouterParam(event, "id")!, { ...input, id: getRouterParam(event, "item")! }) };
});
