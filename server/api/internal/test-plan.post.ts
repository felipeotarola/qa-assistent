import { z } from "zod";
import { requireInternalRequest } from "../../utils/internal-api";
import { getThreadForUser } from "../../utils/threads";
import { publishTestPlan, testPlanPublication } from "../../utils/test-plan-publication";
export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const body = await readValidatedBody(event, z.object({ userId: z.string().uuid(), threadId: z.string().uuid(), itemId: z.string().uuid(), action: z.enum(["status", "publish"]), expectedVersion: z.number().int().positive().optional() }).parse);
  const thread = await getThreadForUser(body.userId, body.threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: "Workspace not found" });
  if (body.action === "status") return testPlanPublication(body.userId, thread.workspaceId, body.itemId);
  if (!body.expectedVersion) throw createError({ statusCode: 400, statusMessage: "Read the plan and provide expectedVersion" });
  return publishTestPlan(body.userId, thread.workspaceId, body.itemId, body.expectedVersion, body.threadId);
});
