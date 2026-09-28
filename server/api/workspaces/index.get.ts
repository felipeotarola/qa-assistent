import { listWorkspaces } from "../../utils/workspaces";
import { requireSessionUserId } from "../../utils/session";
export default defineEventHandler(async event => ({ workspaces: await listWorkspaces(await requireSessionUserId(event)) }));
