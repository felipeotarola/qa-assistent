import { z } from "zod";
import { requireSessionUserId } from "../../../../../utils/session";
import { publishTestPlan } from "../../../../../utils/test-plan-publication";
export default defineEventHandler(async event => {
  const userId = await requireSessionUserId(event);
  const { expectedVersion } = await readValidatedBody(event, z.object({ expectedVersion: z.number().int().positive() }).parse);
  return publishTestPlan(userId, getRouterParam(event, "id")!, getRouterParam(event, "item")!, expectedVersion);
});
