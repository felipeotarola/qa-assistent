import { z } from 'zod';
import { listBrowserJobs, browserJobAction } from '../../../utils/browser-jobs';
export default defineEventHandler(async event => {
  const userId = await requireSessionUserId(event);
  const { jobId } = await readValidatedBody(event, z.object({ jobId: z.string().uuid() }).parse);
  const job = (await listBrowserJobs(userId, getRouterParam(event, 'id')!)).find(j => j.id === jobId);
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Job not found' });
  return browserJobAction(userId, job.threadId, { action: 'cancel', jobId });
});
