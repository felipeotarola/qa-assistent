import { requireWorkspace } from "../../../utils/workspaces";
import { requireSessionUserId } from "../../../utils/session";
export default defineEventHandler(async event => {
  const workspace = await requireWorkspace(await requireSessionUserId(event), getRouterParam(event, "id")!);
  return { order: workspace.cardOrder };
});
