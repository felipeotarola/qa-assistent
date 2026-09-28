import { z } from "zod";
import { browserActionSchema } from "../../../shared/browser";
import { browserAction, requireBrowserThread } from "../../utils/browser";
import { requireInternalRequest } from "../../utils/internal-api";

export default defineEventHandler(async (event) => {
  requireInternalRequest(event);
  const { userId, threadId, input } = await readValidatedBody(event, z.object({ userId: z.string().uuid(), threadId: z.string().uuid(), input: browserActionSchema }).parse);
  await requireBrowserThread(userId, threadId);
  try { return await browserAction(userId, threadId, input); }
  catch { throw createError({ statusCode: 502, statusMessage: "Browser session could not start. Check Browserbase quota and project configuration, then retry." }); }
});
