import { z } from 'zod';
import { requireSessionUserId } from '../../../utils/session';
import { requestReview } from '../../../utils/result-assessments';
import { processReviewQueue } from '../../../utils/result-review-worker';
export default defineEventHandler(async event => {
  const { runId } = z.object({ runId: z.string().uuid() }).parse(await readBody(event));
  await requestReview(await requireSessionUserId(event), getRouterParam(event, 'id')!, runId);
  event.waitUntil(processReviewQueue().catch(() => { console.warn('[result-review] Queue kick failed; durable job retained'); }));
  setResponseStatus(event, 202);
  return { queued: true };
});
