import { z } from 'zod';
import { requireSessionUserId } from '../../../../utils/session';
import { readMissionDetail } from '../../../../utils/mission-presentation';

export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store');
  const userId = await requireSessionUserId(event);
  const route = z.object({ workspaceId: z.string().uuid(), missionId: z.string().uuid() }).safeParse({ workspaceId: getRouterParam(event, 'id'), missionId: getRouterParam(event, 'missionId') });
  if (!route.success) throw createError({ statusCode: 400, statusMessage: 'Ogiltigt workspace eller uppdrag.' });
  return readMissionDetail(userId, route.data.workspaceId, route.data.missionId);
});
