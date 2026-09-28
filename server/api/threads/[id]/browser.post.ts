import { z } from "zod";
import { controlBrowser } from "../../../utils/browser";
import { requireSessionUserId } from "../../../utils/session";

export default defineEventHandler(async (event) => {
  const userId = await requireSessionUserId(event);
  const body = await readValidatedBody(event, z.object({ control: z.enum(["human", "agent", "close", "heartbeat"]) }).parse);
  try { return { browser: await controlBrowser(userId, getRouterParam(event, "id")!, body.control) }; }
  catch { throw createError({ statusCode: 502, statusMessage: "Could not change browser control. Please retry." }); }
});
