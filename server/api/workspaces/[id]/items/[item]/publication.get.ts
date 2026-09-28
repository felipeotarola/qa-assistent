import { requireSessionUserId } from "../../../../../utils/session";
import { testPlanPublication } from "../../../../../utils/test-plan-publication";
export default defineEventHandler(async event => testPlanPublication(await requireSessionUserId(event), getRouterParam(event, "id")!, getRouterParam(event, "item")!));
