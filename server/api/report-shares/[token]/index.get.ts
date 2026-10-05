import { readSharedReport } from '../../../utils/report-sharing';
export default defineEventHandler(async event => readSharedReport(event, getRouterParam(event, 'token')!));
