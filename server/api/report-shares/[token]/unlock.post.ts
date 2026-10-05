import { unlockReportShare } from '../../../utils/report-sharing';
export default defineEventHandler(async event => unlockReportShare(event, getRouterParam(event, 'token')!, await readBody(event)));
