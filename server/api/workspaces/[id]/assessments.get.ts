import { requireSessionUserId } from '../../../utils/session';
import { listAssessments, autoReviewEnabled } from '../../../utils/result-assessments';
import { z } from 'zod';
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store');
  const id = getRouterParam(event, 'id')!;
  const runId = z.string().uuid().optional().parse(getQuery(event).runId);
  const assessments = await listAssessments(await requireSessionUserId(event), id, runId);
  // The scheduler and explicit review requests own queue execution. Opening
  // Testing must not drive autonomous or historical work as a hidden effect.
  return { workspaceId: id, autoEnabled: autoReviewEnabled(id), assessments };
});
