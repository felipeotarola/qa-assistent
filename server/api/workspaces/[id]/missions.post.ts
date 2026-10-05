import { requireSessionUserId } from '../../../utils/session';
import { missionAction } from '../../../utils/missions';
import { processMissionReport } from '../../../utils/mission-reports';
import { getThreadForUser } from '../../../utils/threads';
export default defineEventHandler(async event => {
  const userId = await requireSessionUserId(event), workspaceId = getRouterParam(event, 'id')!;
  const body = await readBody(event);
  const thread = await getThreadForUser(userId, body.threadId);
  if (!thread || thread.workspaceId !== workspaceId) throw createError({ statusCode: 404 });
  const result = await missionAction(userId, workspaceId, thread.id, body);
  if (body.action === 'report') event.waitUntil(processMissionReport());
  return result;
});
