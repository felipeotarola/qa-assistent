import { z } from 'zod';
import { requireInternalRequest } from '../../utils/internal-api';
import { getThreadForUser } from '../../utils/threads';
import { readQualityReport, saveQuality } from '../../utils/quality';
export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const body = await readBody(event);
  const value = z.object({ userId: z.string().uuid(), threadId: z.string().uuid(), action: z.enum(['read', 'update']) }).parse(body);
  const thread = await getThreadForUser(value.userId, value.threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: 'Workspace not found' });
  return value.action === 'read' ? readQualityReport(value.userId, thread.workspaceId) : saveQuality(value.userId, thread.workspaceId, body);
});
