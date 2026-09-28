import { chatHistory } from "../../../utils/chat-history";
export default defineEventHandler(async event => ({ messages: await chatHistory(await requireSessionUserId(event), getRouterParam(event, "id")!) }));
