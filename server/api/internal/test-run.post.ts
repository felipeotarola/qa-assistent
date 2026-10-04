import { z } from 'zod';
import { requireInternalRequest } from '../../utils/internal-api';
import { getThreadForUser } from '../../utils/threads';
import { processReviewQueue } from '../../utils/result-review-worker';
import { testRunAction } from '../../utils/test-runs';
export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const body = await readBody(event);
  const { userId, threadId } = z.object({ userId: z.string().uuid(), threadId: z.string().uuid() }).parse(body);
  const thread = await getThreadForUser(userId, threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: 'Workspace not found' });
  const result = await testRunAction(userId, thread.workspaceId, threadId, body);
  if (body.action === 'finish' || body.action === 'assess') event.waitUntil(processReviewQueue().catch(() => console.warn('[result-review] Queue kick deferred')));
  return result;
});
