import { requireSessionUserId } from '../../../utils/session';
import { listAssessments, autoReviewEnabled } from '../../../utils/result-assessments';
import { z } from 'zod';
import { processReviewQueue } from '../../../utils/result-review-worker';
import { notifyReviewedResults } from '../../../utils/result-review-notifications';
export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!;
  const runId = z.string().uuid().optional().parse(getQuery(event).runId);
  const assessments = await listAssessments(await requireSessionUserId(event), id, runId);
  // Reconcile already-authorized jobs while the UI is open, including local dev
  // where Eve cron is not scheduled. Production cron also works with no open UI.
  if (assessments.some(a => a.notificationPending || ['queued', 'running'].includes(a.status))) {
    event.waitUntil(processReviewQueue().then(() => notifyReviewedResults()).catch(() => console.warn('[result-review] Reconciliation deferred')));
  }
  return { workspaceId: id, autoEnabled: autoReviewEnabled(id), assessments };
});
