import { z } from "zod";
import { browserActionSchema } from "../../../shared/browser";
import { browserAction, requireBrowserThread } from "../../utils/browser";
import { requireInternalRequest } from "../../utils/internal-api";

export default defineEventHandler(async (event) => {
  requireInternalRequest(event);
  const { userId, threadId, input, agentId, ...actor } = await readValidatedBody(event, z.object({ userId: z.string().uuid(), threadId: z.string().uuid(), agentId: z.string().max(200).default('main'), browserJobId: z.string().uuid().optional(), executorSessionId: z.string().min(1).max(200).optional(), callId: z.string().min(1).max(200).optional(), input: browserActionSchema }).strict().parse);
  await requireBrowserThread(userId, threadId);
  try { return await browserAction(userId, threadId, input, agentId, actor); }
  catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status && [400, 403, 404, 409, 503].includes(status)) throw error;
    throw createError({ statusCode: 502, statusMessage: 'Webbläsartjänsten kunde inte slutföra åtgärden. Kontrollera körstatus och VPS-tjänsten.' });
  }
});
