import { z } from 'zod';
import { requireInternalRequest } from '../../utils/internal-api';
import { getThreadForUser } from '../../utils/threads';
import { readOwnedReport } from '../../utils/mission-reports';
import { missionReportIsStale } from '../../utils/missions';
export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const body = z.object({ userId: z.string().uuid(), threadId: z.string().uuid(), reportId: z.string().uuid() }).parse(await readBody(event));
  const thread = await getThreadForUser(body.userId, body.threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404 });
  const { report, mission, snapshot } = await readOwnedReport(body.userId, thread.workspaceId, body.reportId);
  return { id: report.id, status: report.status, error: report.error, itemId: report.itemId, document: report.document, stale: await missionReportIsStale(mission.userId, mission.workspaceId, snapshot.input) };
});
