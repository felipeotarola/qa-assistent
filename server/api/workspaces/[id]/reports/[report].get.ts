import { requireSessionUserId } from '../../../../utils/session';
import { readOwnedReport } from '../../../../utils/mission-reports';
export default defineEventHandler(async event => {
  const { report, mission, snapshot } = await readOwnedReport(await requireSessionUserId(event), getRouterParam(event, 'id')!, getRouterParam(event, 'report')!);
  return { id: report.id, status: report.status, phase: report.phase, error: report.error, itemId: report.itemId, document: report.document, stale: mission.revision !== snapshot.revision };
});
