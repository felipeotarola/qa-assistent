import { missionRequestContextSchema } from '../../../shared/mission-request-context';
import { resolveMissionRequest } from '../../utils/chat-history';
import { z } from 'zod';
import { requireInternalRequest } from '../../utils/internal-api';
import { getThreadForUser } from '../../utils/threads';
import { controlMission } from '../../utils/mission-control';
import { runMissionController } from '../../utils/mission-controller';
export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const { userId, threadId, input, requestContext } = z.object({ userId: z.string().uuid(), threadId: z.string().uuid(), input: z.unknown(), requestContext: missionRequestContextSchema.optional() }).strict().parse(await readBody(event));
  const thread = await getThreadForUser(userId, threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404 });
  let command = input;
  let requestSource;
  if (input && typeof input === 'object' && 'action' in input && input.action === 'accept') {
    if (!requestContext || 'goal' in input) throw createError({ statusCode: 400, statusMessage: 'Admission requires an original user message, not a generated goal.' });
    const bound = await resolveMissionRequest(userId, threadId, requestContext);
    command = { ...input, goal: bound.goal };
    requestSource = bound.source;
  } else if (requestContext) throw createError({ statusCode: 400, statusMessage: 'Request context is only valid for admission.' });
  const mission = await controlMission(userId, thread.workspaceId, threadId, command, requestSource);
  // The scheduler is authoritative recovery; this kick only reduces latency.
  event.waitUntil(runMissionController(mission.id));
  return { missionId: mission.id, title: mission.config.title, lifecycle: mission.lifecycle, phase: mission.phase, mandateRevision: mission.mandateRevision, deadlineAt: mission.deadlineAt, background: true,
    note: 'Uppdraget är sparat. Visa en kort kvittens; inga manuella fortsättningar eller nya parallella jobb behövs.' };
});
