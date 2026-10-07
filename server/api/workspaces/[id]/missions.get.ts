import { requireSessionUserId } from '../../../utils/session';
import { listMissions } from '../../../utils/missions';
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store');
  const workspaceId = getRouterParam(event, 'id')!;
  return listMissions(await requireSessionUserId(event), workspaceId);
});
