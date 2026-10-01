import { z } from 'zod';
import { requireInternalRequest } from '../../utils/internal-api';
import { getThreadForUser } from '../../utils/threads';
import { sandboxScope } from '../../utils/sandbox-scope';
import { repositoryRunner } from '../../utils/repositories';

export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const body = z.object({
    userId: z.string().uuid(), threadId: z.string().uuid(), sessionKey: z.string().min(1).max(300),
    action: z.enum(['start', 'status', 'cancel']), jobId: z.string().uuid(), task: z.string().min(1).max(12000).optional(),
  }).parse(await readBody(event));
  const thread = await getThreadForUser(body.userId, body.threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: 'Workspace not found' });
  return repositoryRunner('/codex', { ...body, ...sandboxScope(body.userId, body.threadId, body.sessionKey), workspaceId: thread.workspaceId });
});
