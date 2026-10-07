import { randomUUID } from 'node:crypto';
import { and, eq, desc, sql, inArray } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { getThreadForUser } from './threads';
import { runtimeScope } from '../../shared/runtime-scope';
import { appOrigin, internalHeaders } from '../../agent/lib/internal-api';
import { resolveChatModel, resolveReasoning } from '../../shared/chat-models';
import type { MissionBinding } from '../../shared/mission-binding';
import { irisActiveStates, irisTerminalStates, irisModelUsage, irisModelReceiptSchema, IRIS_MODEL_LEDGER_PREFIX, IRIS_MAX_MODEL_CALLS, type IrisEvent } from '../../shared/browser-job';
import { bindMissionSource, validateMissionBinding } from './missions';
import { autonomyEnabled, lockMission } from './mission-control';
import type { WorkspaceDatabase } from './workspaces';

type Job = typeof schema.browserJobs.$inferSelect;
type JobInput = { action: 'start' | 'status' | 'cancel'; jobId: string; task?: string; parentSessionId?: string; model?: string; reasoning?: string; mission?: MissionBinding };
const terminal = (status: string) => irisTerminalStates.some(value => value === status);
function view(job: Job) {
  const { dispatchLeaseToken: _token, dispatchLeaseUntil: _until, ...publicJob } = job;
  return { ...publicJob, status: job.status === 'dispatching' ? 'dispatch_unknown' : job.status,
    retryableDispatch: !job.sessionId && (job.status === 'starting' || job.status === 'dispatching' && !!job.dispatchLeaseUntil && job.dispatchLeaseUntil <= new Date()), name: 'Iris', background: true };
}
async function origin(connection: WorkspaceDatabase, userId: string, workspaceId: string, jobId: string) {
  const [value] = await connection.select({ attempt: schema.missionAttempts, mission: schema.missions, task: schema.missionTasks }).from(schema.missionAttempts)
    .innerJoin(schema.missions, eq(schema.missions.id, schema.missionAttempts.missionId))
    .innerJoin(schema.missionTasks, and(eq(schema.missionTasks.id, schema.missionAttempts.taskId), eq(schema.missionTasks.missionId, schema.missions.id)))
    .where(eq(schema.missionAttempts.dispatchId, jobId));
  if (value && (value.attempt.runtime !== runtimeScope() || value.mission.runtime !== runtimeScope() || value.mission.workspaceId !== workspaceId || value.mission.userId !== userId)) throw createError({ statusCode: 404, statusMessage: 'Iris attempt not found' });
  return value ?? null;
}
async function current(connection: WorkspaceDatabase, value: Awaited<ReturnType<typeof origin>>) {
  if (!value) return true;
  if (!autonomyEnabled()) return false;
  const [clock] = await connection.execute<{ now: string }>(sql`select clock_timestamp()::text as now`), now = new Date(clock!.now);
  const { attempt, mission, task } = value;
  const authorized = mission.controllerVersion === 1 && mission.status === 'active' && ['accepted', 'running', 'waiting'].includes(mission.lifecycle!)
    && !!mission.deadlineAt && mission.deadlineAt > now && attempt.kind === 'browser_tests' && task.spec?.kind === 'browser_tests' && task.state === 'running'
    && task.planRevision === mission.planRevision && attempt.planRevision === mission.planRevision && attempt.mandateRevision === mission.mandateRevision
    && ['dispatching', 'dispatch_unknown', 'running'].includes(attempt.status) && !attempt.cancelRequestedAt && attempt.deadlineAt > now;
  if (!authorized) return false;
  const waits = await connection.select().from(schema.missionWaits).where(and(eq(schema.missionWaits.missionId, mission.id), eq(schema.missionWaits.state, 'waiting')));
  return !waits.some(wait => wait.definition.planRevision === mission.planRevision && wait.definition.taskIds.includes(task.id));
}
async function lockJob(connection: WorkspaceDatabase, userId: string, workspaceId: string, jobId: string) {
  const initial = await origin(connection, userId, workspaceId, jobId);
  if (initial) await lockMission(connection, initial.mission.id);
  await connection.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspaceId}`}, 0))`);
  await connection.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`iris:${workspaceId}:${runtimeScope()}`}, 0))`);
  await connection.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`iris-job:${jobId}`}, 0))`);
  return origin(connection, userId, workspaceId, jobId);
}
async function ownedJob(connection: WorkspaceDatabase, threadId: string, jobId: string) {
  const [job] = await connection.select().from(schema.browserJobs).where(and(eq(schema.browserJobs.id, jobId), eq(schema.browserJobs.threadId, threadId), eq(schema.browserJobs.runtime, runtimeScope())));
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Iris job not found' });
  return job;
}
/** Channel observations never grant permission to restart an executor. */
export async function recordBrowserJobEvent(input: IrisEvent) {
  const thread = await getThreadForUser(input.userId, input.threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: 'Workspace not found' });
  const outcome = await db.transaction(async tx => {
    const execution = await lockJob(tx, input.userId, thread.workspaceId!, input.jobId);
    let job = await ownedJob(tx, input.threadId, input.jobId);
    if (input.kind === 'dispatch') {
      const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
      if (job.status !== 'dispatching' || job.dispatchLeaseToken !== input.dispatchLeaseToken || !job.dispatchLeaseUntil || job.dispatchLeaseUntil <= new Date(clock!.now) || !await current(tx, execution)) return { allowed: false, job, notify: false };
      // The first channel admission owns source.send. Recovery after this
      // transition only resolves durable session state; it never sends again.
      const [saved] = await tx.update(schema.browserJobs).set({ status: 'dispatch_unknown', updatedAt: new Date() }).where(eq(schema.browserJobs.id, job.id)).returning();
      return { allowed: true, job: saved!, notify: false };
    }
    if (job.sessionId && job.sessionId !== input.sessionId) throw createError({ statusCode: 409, statusMessage: 'Iris executor session cannot change.' });
    if (!job.sessionId && !['dispatch_unknown', 'running', 'cancelling'].includes(job.status)) throw createError({ statusCode: 409, statusMessage: 'Iris dispatch has not been admitted.' });
    if (input.kind === 'model_started' || input.kind === 'model_finished') {
      if (!job.sessionId) throw createError({ statusCode: 409, statusMessage: 'Iris modellen kräver sin bundna session.' });
      // Legacy chat jobs do not acquire a new autonomous mandate implicitly.
      if (!execution) return { allowed: true, job, notify: false };
      const { attempt } = execution;
      const start = `${IRIS_MODEL_LEDGER_PREFIX}start:${input.modelCallId}`;
      if (input.kind === 'model_started') {
        const usage = irisModelUsage(attempt.toolCallIds);
        if (terminal(job.status) || job.status === 'cancelling' || !await current(tx, execution)
          || usage.invalid || usage.unknownCalls || usage.providerCalls >= IRIS_MAX_MODEL_CALLS
          || (usage.tokens ?? Infinity) >= attempt.reservedTokens || attempt.toolCallIds.includes(start)) {
          throw createError({ statusCode: 409, statusMessage: 'Iris modellbudget är slut, tidigare förbrukning är okänd eller mandatet har återkallats.' });
        }
        await tx.update(schema.missionAttempts).set({ toolCallIds: [...attempt.toolCallIds, start],
          usage: { tokens: null, toolCalls: attempt.toolCalls, durationMs: usage.durationMs }, updatedAt: new Date() }).where(eq(schema.missionAttempts.id, attempt.id));
      } else {
        // Historical accounting remains writable after cancellation/closure;
        // it never grants another provider call or rewrites test results.
        if (!attempt.toolCallIds.includes(start)) throw createError({ statusCode: 409, statusMessage: 'Modellkvittot saknar en antagen fysisk invokation.' });
        const receipt = irisModelReceiptSchema.parse({ callId: input.modelCallId, ...input.modelUsage, durationMs: input.modelDurationMs,
          ...(input.modelFailure ? { failure: input.modelFailure } : {}),
        });
        const marker = `${IRIS_MODEL_LEDGER_PREFIX}usage:${JSON.stringify(receipt)}`;
        const previous = attempt.toolCallIds.filter(id => id.startsWith(`${IRIS_MODEL_LEDGER_PREFIX}usage:`)).find(id => {
          try { return JSON.parse(id.slice(`${IRIS_MODEL_LEDGER_PREFIX}usage:`.length)).callId === input.modelCallId; } catch { return false; }
        });
        if (previous && previous !== marker) throw createError({ statusCode: 409, statusMessage: 'Modellens förbrukningskvitto är oföränderligt.' });
        if (!previous) {
          const ids = [...attempt.toolCallIds, marker], usage = irisModelUsage(ids);
          await tx.update(schema.missionAttempts).set({ toolCallIds: ids, usage: { tokens: usage.tokens, toolCalls: attempt.toolCalls, durationMs: usage.durationMs }, updatedAt: new Date() }).where(eq(schema.missionAttempts.id, attempt.id));
        }
      }
      return { allowed: true, job, notify: false };
    }
    if (input.kind === 'started' && (terminal(job.status) || job.status === 'cancelling' || !await current(tx, execution))) throw createError({ statusCode: 409, statusMessage: 'Iris execution is no longer authorized.' });
    const wasTerminal = terminal(job.status);
    const status = wasTerminal ? job.status : input.kind === 'settled' ? input.status! : job.status === 'cancelling' ? 'cancelling' : 'running';
    const [saved] = await tx.update(schema.browserJobs).set({ sessionId: input.sessionId, status, updatedAt: new Date(),
      ...(input.report !== undefined && (!wasTerminal || !job.report) ? { report: input.report } : {}),
      ...(terminal(status) ? { dispatchLeaseToken: null, dispatchLeaseUntil: null } : {}),
    }).where(eq(schema.browserJobs.id, job.id)).returning();
    job = saved!;
    if (execution) await tx.update(schema.missions).set({ nextWakeAt: new Date() }).where(eq(schema.missions.id, execution.mission.id));
    return { allowed: true, job, notify: !execution && !wasTerminal && input.kind === 'settled' && input.status !== 'cancelled' };
  });
  // Legacy chat notifications remain; autonomous continuation belongs solely
  // to the mission controller. HTTP never holds database locks.
  if (outcome.notify) await fetch(`${appOrigin()}/eve/v1/workers/iris/notify`, { method: 'POST', headers: internalHeaders(), signal: AbortSignal.timeout(15000), body: JSON.stringify({ ...view(outcome.job), userId: input.userId, jobId: outcome.job.id }) }).catch(() => undefined);
  return { allowed: outcome.allowed, job: view(outcome.job) };
}
async function observeWorker(userId: string, threadId: string, job: Job, action: 'start' | 'status' | 'cancel', dispatchLeaseToken?: string) {
  const response = await fetch(`${appOrigin()}/eve/v1/workers/iris`, { method: 'POST', headers: internalHeaders(), signal: AbortSignal.timeout(30000), body: JSON.stringify({ action, jobId: job.id, task: job.task, userId, threadId, model: job.model, reasoning: job.reasoning, ...(dispatchLeaseToken ? { dispatchLeaseToken } : {}) }) });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Iris receipt unavailable');
  const result = await response.json() as { sessionId?: string; status?: string; report?: string };
  if (typeof result.sessionId === 'string') await recordBrowserJobEvent({ userId, threadId, jobId: job.id, sessionId: result.sessionId,
    kind: terminal(result.status ?? '') ? 'settled' : 'receipt', ...(terminal(result.status ?? '') ? { status: result.status as 'completed' | 'failed' | 'cancelled' } : {}),
    ...(typeof result.report === 'string' ? { report: result.report.slice(0, 50000) } : {}),
  });
}
export async function browserJobAction(userId: string, threadId: string, input: JobInput) {
  const thread = await getThreadForUser(userId, threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: 'Workspace not found' });
  const workspaceId = thread.workspaceId;
  const initialOrigin = await origin(db, userId, workspaceId, input.jobId);
  if (input.action === 'start' && !initialOrigin) await validateMissionBinding(userId, workspaceId, input.mission);
  const prepared = await db.transaction(async tx => {
    const execution = await lockJob(tx, userId, workspaceId, input.jobId);
    const [existing] = await tx.select().from(schema.browserJobs).where(eq(schema.browserJobs.id, input.jobId));
    if (existing && (existing.threadId !== threadId || existing.runtime !== runtimeScope())) throw createError({ statusCode: 404, statusMessage: 'Iris job not found' });
    if (execution && input.mission && (input.mission.missionId !== execution.mission.id || input.mission.taskId !== execution.task.id)) throw createError({ statusCode: 409, statusMessage: 'Iris execution binding cannot change.' });
    if (!execution && input.mission) {
      const [mission] = await tx.select().from(schema.missions).where(eq(schema.missions.id, input.mission.missionId));
      if (mission?.controllerVersion === 1) throw createError({ statusCode: 409, statusMessage: 'Autonomous Iris jobs require their exact attempt dispatch ID.' });
    }
    let job = existing;
    if (input.action === 'start' && !job) {
      if (!input.task || !input.parentSessionId && !execution) throw createError({ statusCode: 400, statusMessage: 'Task and parent session required' });
      if (!await current(tx, execution)) throw createError({ statusCode: 409, statusMessage: 'Iris execution is no longer authorized.' });
      const active = await tx.select({ id: schema.browserJobs.id }).from(schema.browserJobs).innerJoin(schema.threads, eq(schema.threads.id, schema.browserJobs.threadId))
        .where(and(eq(schema.threads.workspaceId, workspaceId), eq(schema.browserJobs.runtime, runtimeScope()), inArray(schema.browserJobs.status, [...irisActiveStates])));
      if (active.length) throw createError({ statusCode: 409, statusMessage: 'Iris already owns an active task in this workspace.' });
      [job] = await tx.insert(schema.browserJobs).values({ id: input.jobId, threadId, runtime: runtimeScope(), parentSessionId: input.parentSessionId ?? `mission:${execution!.mission.id}`, task: input.task,
        model: resolveChatModel(input.model), reasoning: resolveReasoning(input.reasoning),
      }).returning();
    }
    if (!job) throw createError({ statusCode: 404, statusMessage: 'Iris job not found' });
    if (input.action === 'start' && (input.task !== job.task || input.parentSessionId !== undefined && input.parentSessionId !== job.parentSessionId || input.model !== undefined && resolveChatModel(input.model) !== job.model || input.reasoning !== undefined && resolveReasoning(input.reasoning) !== job.reasoning)) throw createError({ statusCode: 409, statusMessage: 'Iris job ID already belongs to another request.' });
    if (input.action === 'cancel' && !terminal(job.status)) {
      // A dispatch not admitted by the channel cannot have started. Revoking
      // the lease here also rejects delayed HTTP requests with the old token.
      const status = ['starting', 'dispatching'].includes(job.status) ? 'cancelled' : 'cancelling';
      [job] = await tx.update(schema.browserJobs).set({ status, dispatchLeaseToken: null, dispatchLeaseUntil: null, updatedAt: new Date() }).where(eq(schema.browserJobs.id, job.id)).returning();
    }
    return { job: job!, binding: execution ? { missionId: execution.mission.id, taskId: execution.task.id } : input.mission, current: await current(tx, execution) };
  });
  let job = prepared.job;
  if (input.action === 'start' && prepared.binding && prepared.current && !terminal(job.status)) await bindMissionSource(userId, workspaceId, threadId, prepared.binding, 'browser', job.id);
  if (terminal(job.status)) return view(job);
  try {
    if (input.action === 'status' || input.action === 'cancel' || job.status !== 'starting') {
      await observeWorker(userId, threadId, job, input.action === 'cancel' ? 'cancel' : 'status');
      job = await ownedJob(db, threadId, job.id);
    }
    if (input.action === 'start') {
      const claimed = await db.transaction(async tx => {
        const execution = await lockJob(tx, userId, workspaceId, job.id);
        const fresh = await ownedJob(tx, threadId, job.id);
        const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`), now = new Date(clock!.now);
        if (fresh.sessionId || !['starting', 'dispatching'].includes(fresh.status) || fresh.dispatchLeaseUntil && fresh.dispatchLeaseUntil > now) return null;
        if (!await current(tx, execution)) throw createError({ statusCode: 409, statusMessage: 'Iris execution is no longer authorized.' });
        const [saved] = await tx.update(schema.browserJobs).set({ status: 'dispatching', dispatchLeaseToken: randomUUID(), dispatchLeaseUntil: new Date(now.getTime() + 90000), updatedAt: now }).where(eq(schema.browserJobs.id, job.id)).returning();
        return saved!;
      });
      if (claimed) await observeWorker(userId, threadId, claimed, 'start', claimed.dispatchLeaseToken!);
    }
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 409) throw error;
    console.warn('[iris] Executor receipt unavailable; reconciling the same job', { jobId: job.id, action: input.action, error: error instanceof Error ? error.name : 'UnknownError' });
  }
  return view(await ownedJob(db, threadId, job.id));
}
export async function listBrowserJobs(userId: string, workspaceId: string) {
  const { requireWorkspace } = await import('./workspaces');
  await requireWorkspace(userId, workspaceId);
  const jobs = await db.select({ job: schema.browserJobs }).from(schema.browserJobs).innerJoin(schema.threads, eq(schema.threads.id, schema.browserJobs.threadId))
    .where(and(eq(schema.threads.workspaceId, workspaceId), eq(schema.browserJobs.runtime, runtimeScope()))).orderBy(desc(schema.browserJobs.createdAt)).limit(10);
  return jobs.map(({ job }) => view(job));
}
