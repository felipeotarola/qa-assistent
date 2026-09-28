import { z } from "zod";
import { requireInternalRequest } from "../../utils/internal-api";
import { workspaceContext } from "../../utils/workspace-context";
export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const { userId, threadId } = await readValidatedBody(event, z.object({ userId: z.string().uuid(), threadId: z.string().uuid() }).parse);
  setHeader(event, "Cache-Control", "no-store");
  return workspaceContext(userId, threadId);
});
