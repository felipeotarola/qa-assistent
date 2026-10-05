import { requireSessionUserId } from '../../../../../utils/session';
import { getOwnedShare, reportPrivacyHeaders } from '../../../../../utils/report-sharing';
export default defineEventHandler(async event => { reportPrivacyHeaders(event); return getOwnedShare(await requireSessionUserId(event), getRouterParam(event, 'id')!, getRouterParam(event, 'report')!); });
