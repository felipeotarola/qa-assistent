import { readSharedReport } from '../../../utils/report-sharing';
export default defineEventHandler(async event => {
  const id = getQuery(event).evidenceId;
  if (typeof id !== 'string') throw createError({ statusCode: 400 });
  return readSharedReport(event, getRouterParam(event, 'token')!, id);
});
