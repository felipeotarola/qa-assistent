import { z } from "zod";
import { browserActionSchema } from "../../../shared/browser";
import { browserAction, requireBrowserThread } from "../../utils/browser";
import { requireInternalRequest } from "../../utils/internal-api";

export default defineEventHandler(async (event) => {
  requireInternalRequest(event);
  const { userId, threadId, input, agentId } = await readValidatedBody(event, z.object({ userId: z.string().uuid(), threadId: z.string().uuid(), agentId: z.string().max(200).default('main'), input: browserActionSchema }).parse);
  await requireBrowserThread(userId, threadId);
  try { return await browserAction(userId, threadId, input, agentId); }
  catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status && [400, 403, 404, 409, 503].includes(status)) throw error;
    throw createError({ statusCode: 502, statusMessage: 'Webbläsartjänsten kunde inte slutföra åtgärden. Kontrollera körstatus och VPS-tjänsten.' });
  }
});
