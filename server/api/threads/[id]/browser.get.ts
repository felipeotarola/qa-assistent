import { getBrowserView, listBrowserViews } from "../../../utils/browser";
import { requireSessionUserId } from "../../../utils/session";

export default defineEventHandler(async (event) => {
  const userId = await requireSessionUserId(event);
  const threadId = getRouterParam(event, 'id')!;
  const selected = getQuery(event).sessionId;
  const browser = await getBrowserView(userId, threadId, typeof selected === 'string' ? selected : undefined);
  return { browser, browsers: await listBrowserViews(userId, threadId) };
});
