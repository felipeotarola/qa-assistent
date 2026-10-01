import { z } from 'zod';
import { requireInternalRequest } from '../../utils/internal-api';
import { browserJobAction } from '../../utils/browser-jobs';
export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const body = await readValidatedBody(event, z.object({ userId: z.string().uuid(), threadId: z.string().uuid(), action: z.enum(['start', 'status', 'cancel']), jobId: z.string().uuid(), task: z.string().max(16000).optional(), parentSessionId: z.string().max(200).optional(), model: z.string().optional(), reasoning: z.string().optional() }).parse);
  return browserJobAction(body.userId, body.threadId, body);
});
