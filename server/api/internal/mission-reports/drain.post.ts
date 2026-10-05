import { requireInternalRequest } from '../../../utils/internal-api';
import { refreshMissionReports, processMissionReport, notifyMissionReports } from '../../../utils/mission-reports';
export default defineEventHandler(async event => {
  requireInternalRequest(event);
  await refreshMissionReports(); await processMissionReport(); await notifyMissionReports();
  return { ok: true };
});
