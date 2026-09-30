import { chatHistorySnapshot } from "../../../utils/chat-history";
export default defineEventHandler(async event => chatHistorySnapshot(await requireSessionUserId(event), getRouterParam(event, "id")!));
