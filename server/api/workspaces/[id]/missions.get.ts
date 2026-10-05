import { requireSessionUserId } from '../../../utils/session';
import { listMissions } from '../../../utils/missions';
import { refreshMissionReports, processMissionReport, notifyMissionReports } from '../../../utils/mission-reports';
export default defineEventHandler(async event => {
  const workspaceId = getRouterParam(event, 'id')!;
  const result = await listMissions(await requireSessionUserId(event), workspaceId);
  if (result.missions.length) event.waitUntil((async () => { if (await refreshMissionReports(workspaceId)) { await processMissionReport(); await notifyMissionReports(); } })().catch(() => console.warn('[mission] Workspace refresh deferred')));
  return result;
});
