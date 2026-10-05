import { requireSessionUserId } from '../../../../../utils/session';
import { manageReportShare, requireReportMutation, reportPrivacyHeaders } from '../../../../../utils/report-sharing';
export default defineEventHandler(async event => {
  reportPrivacyHeaders(event); requireReportMutation(event);
  return manageReportShare(await requireSessionUserId(event), getRouterParam(event, 'id')!, getRouterParam(event, 'report')!, await readBody(event));
});
