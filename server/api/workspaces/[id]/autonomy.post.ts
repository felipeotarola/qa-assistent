import { z } from 'zod';
import { requireSessionUserId } from '../../../utils/session';
import { controlMission } from '../../../utils/mission-control';
export default defineEventHandler(async event => {
  const userId = await requireSessionUserId(event), workspaceId = z.string().uuid().parse(getRouterParam(event, 'id'));
  const { threadId, input } = z.object({ threadId: z.string().uuid(), input: z.unknown() }).strict().parse(await readBody(event));
  const mission = await controlMission(userId, workspaceId, threadId, input);
  return { id: mission.id, lifecycle: mission.lifecycle, phase: mission.phase, mandateRevision: mission.mandateRevision, closureReason: mission.closureReason };
});
