import { listItems } from "../../../utils/workspaces";
import { requireSessionUserId } from "../../../utils/session";
export default defineEventHandler(async event => ({ items: await listItems(await requireSessionUserId(event), getRouterParam(event, "id")!) }));
