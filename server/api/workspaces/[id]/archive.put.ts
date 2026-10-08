import { z } from 'zod';
import { requireSessionUserId } from '../../../utils/session';
import { setWorkspaceArchived } from '../../../utils/workspace-archive';

export default defineEventHandler(async event => {
  const userId = await requireSessionUserId(event);
  const { archived } = await readValidatedBody(event, z.object({ archived: z.boolean() }).strict().parse);
  return setWorkspaceArchived(userId, getRouterParam(event, 'id')!, archived);
});
