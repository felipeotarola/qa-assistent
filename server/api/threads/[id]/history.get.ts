import { chatHistorySnapshot } from "../../../utils/chat-history";
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store');
  return chatHistorySnapshot(await requireSessionUserId(event), getRouterParam(event, "id")!);
});
