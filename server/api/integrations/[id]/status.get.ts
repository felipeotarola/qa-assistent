import { getConnector } from "../../../connectors";
import { probeStatus } from "../../../utils/connect";
import { requireSessionUserId } from "../../../utils/session";
export default defineEventHandler(async event => {
  const userId = await requireSessionUserId(event);
  return probeStatus(getConnector(getRouterParam(event, "id") || ""), userId);
});
