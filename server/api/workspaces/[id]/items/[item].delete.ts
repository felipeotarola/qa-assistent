import { setItemDeleted } from "../../../../utils/workspaces";
import { requireSessionUserId } from "../../../../utils/session";
export default defineEventHandler(async (event) => {
  return { item: await setItemDeleted(await requireSessionUserId(event), getRouterParam(event, "id")!, getRouterParam(event, "item")!, true) };
});
