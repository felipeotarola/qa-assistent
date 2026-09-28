import { z } from "zod";
import { externalInputSchema } from "../../../shared/external";
import { requireInternalRequest } from "../../utils/internal-api";
import { getThreadForUser } from "../../utils/threads";
import { externalOperation } from "../../utils/external";
export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const body = await readValidatedBody(event, z.object({ userId: z.string().uuid(), threadId: z.string().uuid(), callId: z.string().min(1).max(300), input: externalInputSchema }).parse);
  const thread = await getThreadForUser(body.userId, body.threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: "Workspace not found" });
  return externalOperation(body.userId, thread.workspaceId, `${body.threadId}:${body.callId}`, body.input);
});
