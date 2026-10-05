import { z } from 'zod';
import { requireInternalRequest } from '../../utils/internal-api';
import { getThreadForUser } from '../../utils/threads';
import { processReviewQueue } from '../../utils/result-review-worker';
import { testRunAction } from '../../utils/test-runs';
import { bindMissionSource, validateMissionBinding, sourceMissionBinding } from '../../utils/missions';
import { missionBindingSchema } from '../../../shared/mission-binding';
export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const body = await readBody(event);
  const { userId, threadId } = z.object({ userId: z.string().uuid(), threadId: z.string().uuid() }).parse(body);
  const thread = await getThreadForUser(userId, threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: 'Workspace not found' });
  if (body.action === 'start' && body.browserJobId) {
    const inherited = await sourceMissionBinding(thread.workspaceId, 'browser', z.string().uuid().parse(body.browserJobId));
    if (inherited) { if (body.mission && (body.mission.missionId !== inherited.missionId || body.mission.taskId !== inherited.taskId)) throw createError({ statusCode: 409, statusMessage: 'Iris task binding cannot be changed.' }); body.mission = inherited; }
  }
  if (body.action === 'start' && body.mission) await validateMissionBinding(userId, thread.workspaceId, missionBindingSchema.parse(body.mission));
  const result = await testRunAction(userId, thread.workspaceId, threadId, body);
  if (body.action === 'start' && body.mission && result && 'id' in result) await bindMissionSource(userId, thread.workspaceId, threadId, missionBindingSchema.parse(body.mission), 'test', result.id);
  if (body.action === 'finish' || body.action === 'assess') event.waitUntil(processReviewQueue().catch(() => console.warn('[result-review] Queue kick deferred')));
  return result;
});
