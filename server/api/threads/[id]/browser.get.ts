import { getBrowserView } from "../../../utils/browser";
import { requireSessionUserId } from "../../../utils/session";

export default defineEventHandler(async (event) => {
  const userId = await requireSessionUserId(event);
  return { browser: await getBrowserView(userId, getRouterParam(event, "id")!) };
});
