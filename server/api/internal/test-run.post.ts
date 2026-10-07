import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { requireInternalRequest } from '../../utils/internal-api';
import { getThreadForUser } from '../../utils/threads';
import { processReviewQueue } from '../../utils/result-review-worker';
import { testRunAction } from '../../utils/test-runs';
import { bindMissionSource, validateMissionBinding, sourceMissionBinding } from '../../utils/missions';
import { missionBindingSchema } from '../../../shared/mission-binding';
import { runtimeScope } from '../../../shared/runtime-scope';
import { testRunActionSchema } from '../../../shared/test-run';
import { accountMissionTestReceipt, authorizeMissionOperation } from '../../utils/mission-attempts';
export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const body = await readBody(event);
  const { userId, threadId } = z.object({ userId: z.string().uuid(), threadId: z.string().uuid() }).parse(body);
  const thread = await getThreadForUser(userId, threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: 'Workspace not found' });
  // Only the internal agent adapter opts in. Manual owner/UI execution keeps its existing contract.
  // Keep this gate closed even when the broader mission kill switch pauses new admission.
  const requireAutonomousStart = body.action === 'start' && process.env.AUTONOMOUS_MISSIONS_ENABLED === 'true';
  let execution: { attemptId: string; dispatchId: string } | undefined;
  if (body.browserJobId) {
    const jobId = z.string().uuid().parse(body.browserJobId);
    const trusted = z.object({ executorSessionId: z.string().min(1).max(200), callId: z.string().min(1).max(200) }).safeParse(body);
    if (!trusted.success) throw createError({ statusCode: 409, statusMessage: 'Iris exakta utförarsession krävs.' });
    // browserJobId is injected by Iris's authenticated channel attributes. The
    // tool's model schema never supplies an attempt ID or this trusted context.
    const [job] = await db.select().from(schema.browserJobs).where(and(eq(schema.browserJobs.id, jobId), eq(schema.browserJobs.threadId, threadId), eq(schema.browserJobs.runtime, runtimeScope())));
    if (!job) throw createError({ statusCode: 404, statusMessage: 'Iris job not found' });
    if (!job.sessionId || job.sessionId !== trusted.data.executorSessionId) throw createError({ statusCode: 409, statusMessage: 'Iris utförarsession får inte ersättas.' });
    if (body.action === 'assess') throw createError({ statusCode: 409, statusMessage: 'Iris får inte beställa granskningar.' });
    const [origin] = await db.select({ attempt: schema.missionAttempts, mission: schema.missions, task: schema.missionTasks }).from(schema.missionAttempts)
      .innerJoin(schema.missions, eq(schema.missionAttempts.missionId, schema.missions.id))
      .innerJoin(schema.missionTasks, eq(schema.missionAttempts.taskId, schema.missionTasks.id))
      .where(and(eq(schema.missionAttempts.dispatchId, job.id), eq(schema.missionAttempts.runtime, runtimeScope()), eq(schema.missions.runtime, runtimeScope()), eq(schema.missions.workspaceId, thread.workspaceId), eq(schema.missions.userId, userId)));
    if (origin) execution = { attemptId: origin.attempt.id, dispatchId: origin.attempt.dispatchId };
    if (body.action === 'start') {
      const inherited = origin ? { missionId: origin.mission.id, taskId: origin.attempt.taskId } : await sourceMissionBinding(thread.workspaceId, 'browser', job.id);
      if (inherited) {
        const supplied = body.mission && missionBindingSchema.parse(body.mission);
        if (supplied && (supplied.missionId !== inherited.missionId || supplied.taskId !== inherited.taskId)) throw createError({ statusCode: 409, statusMessage: 'Iris task binding cannot be changed.' });
        body.mission = inherited;
      }
    }
    const parsed = testRunActionSchema.safeParse(body);
    if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Ogiltig testkörning.' });
    const action = parsed.data;
    const [savedRun] = action.action === 'start'
      ? await db.select().from(schema.testRuns).where(and(eq(schema.testRuns.workspaceId, thread.workspaceId), eq(schema.testRuns.requestId, action.requestId)))
      : action.action === 'finish' ? await db.select().from(schema.testRuns).where(and(eq(schema.testRuns.workspaceId, thread.workspaceId), eq(schema.testRuns.id, action.runId))) : [];
    if (action.action === 'finish' && (!savedRun || savedRun.threadId !== threadId || (savedRun.missionAttemptId ?? null) !== (execution?.attemptId ?? null))) throw createError({ statusCode: 409, statusMessage: 'Resultatet måste tillhöra Iris ursprungliga uppdrag.' });
    const [clock] = await db.execute<{ now: string }>(sql`select clock_timestamp()::text as now`), now = new Date(clock!.now);
    const current = !origin || origin.mission.status === 'active' && ['accepted', 'running', 'waiting'].includes(origin.mission.lifecycle!)
      && !!origin.mission.deadlineAt && origin.mission.deadlineAt > now && origin.task.state === 'running'
      && origin.task.planRevision === origin.mission.planRevision && origin.attempt.planRevision === origin.mission.planRevision && origin.attempt.mandateRevision === origin.mission.mandateRevision
      && ['dispatching', 'dispatch_unknown', 'running'].includes(origin.attempt.status) && !origin.attempt.cancelRequestedAt && origin.attempt.deadlineAt > now;
    if (action.action === 'start' && !savedRun && (!current || !['running', 'dispatch_unknown'].includes(job.status))) throw createError({ statusCode: 409, statusMessage: 'Iris har inte ett aktivt körmandat.' });
    if (execution && current && (action.action === 'list' || action.action === 'start' && !savedRun)) {
      await authorizeMissionOperation({ userId, workspaceId: thread.workspaceId, ...execution, callId: trusted.data.callId, tool: 'test_run', input: action });
    }
  }
  if (body.action === 'start' && body.mission && !execution && !requireAutonomousStart) await validateMissionBinding(userId, thread.workspaceId, missionBindingSchema.parse(body.mission));
  const result = await testRunAction(userId, thread.workspaceId, threadId, body, { execution, requireAutonomousStart });
  if (execution && body.action === 'finish' && result && !Array.isArray(result) && 'id' in result) await accountMissionTestReceipt({ userId, workspaceId: thread.workspaceId, ...execution, runId: result.id });
  if (body.browserJobId && Array.isArray(result)) return result.filter(run => execution ? run.missionAttemptId === execution.attemptId : !run.missionAttemptId && run.threadId === threadId);
  const historical = result && !Array.isArray(result) && 'executionCurrent' in result && result.executionCurrent === false;
  if (body.action === 'start' && body.mission && (!requireAutonomousStart || execution) && !historical && result && 'id' in result) await bindMissionSource(userId, thread.workspaceId, threadId, missionBindingSchema.parse(body.mission), 'test', result.id);
  if (!execution && !historical && (body.action === 'finish' || body.action === 'assess')) event.waitUntil(processReviewQueue().catch(() => console.warn('[result-review] Queue kick deferred')));
  return result;
});
