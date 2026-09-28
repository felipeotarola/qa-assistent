import { z } from 'zod';
import { requireInternalRequest } from '../../utils/internal-api';
import { getThreadForUser } from '../../utils/threads';
import { requirementAction } from '../../utils/test-requirements';
export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const body = await readBody(event);
  const { userId, threadId } = z.object({ userId: z.string().uuid(), threadId: z.string().uuid() }).parse(body);
  const thread = await getThreadForUser(userId, threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: 'Workspace not found' });
  return requirementAction(userId, thread.workspaceId, body);
});
