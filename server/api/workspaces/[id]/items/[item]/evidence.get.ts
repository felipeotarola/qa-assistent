import { requireSessionUserId } from "../../../../../utils/session";
import { evidenceForItem } from "../../../../../utils/evidence";
export default defineEventHandler(async event => {
  const userId = await requireSessionUserId(event);
  return { links: await evidenceForItem(userId, getRouterParam(event, "id") || "", getRouterParam(event, "item") || "") };
});

