import { threadIdParamsSchema } from "~~/server/schemas/threads";
import { getThreadForUser } from "~~/server/utils/threads";
import { requireSessionUserId } from "~~/server/utils/session";
import { adoptLegacyChat } from "../../utils/legacy-chat";
import { chatHistory } from "../../utils/chat-history";

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, threadIdParamsSchema.parse);
  const userId = await requireSessionUserId(event);

  await adoptLegacyChat(event, userId, id);
  const thread = await getThreadForUser(userId, id);
  if (!thread) {
    throw createError({
      statusCode: 404,
      statusMessage: "Thread not found",
    });
  }

  return { thread: { ...thread, history: await chatHistory(userId, id) } };
});
