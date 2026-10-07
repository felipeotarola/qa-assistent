import { z } from 'zod';
import { requireSessionUserId } from '../../../utils/session';
import { listMissionPresentations } from '../../../utils/mission-presentation';

export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store');
  const userId = await requireSessionUserId(event);
  const workspace = z.string().uuid().safeParse(getRouterParam(event, 'id'));
  const query = z.object({ limit: z.coerce.number().int().min(1).max(50).default(30) }).strict().safeParse(getQuery(event));
  if (!workspace.success || !query.success) throw createError({ statusCode: 400, statusMessage: 'Ogiltigt workspace eller antal uppdrag.' });
  return listMissionPresentations(userId, workspace.data, query.data.limit);
});
