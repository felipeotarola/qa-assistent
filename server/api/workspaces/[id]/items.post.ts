import { itemWriteSchema } from "../../../../shared/workspace";
import { saveItem } from "../../../utils/workspaces";
import { requireSessionUserId } from "../../../utils/session";
export default defineEventHandler(async (event) => {
  const userId = await requireSessionUserId(event);
  const input = await readValidatedBody(event, itemWriteSchema.parse);
  return { item: await saveItem(userId, getRouterParam(event, "id")!, input, undefined, { provenance: { version: 1, origin: 'user', producer: 'user-authored', observedAt: null } }) };
});
