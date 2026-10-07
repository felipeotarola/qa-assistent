import { and, desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { missionMandateSchema } from '../../shared/mission-control';
import { runtimeScope } from '../../shared/runtime-scope';
import type { WorkspaceDatabase } from './workspaces';
import { combineProviderUsage, type ProviderUsage } from '../../shared/provider-usage';
import { interimReportContext, isInterimReport } from './mission-interim-report';

type QueueKind = 'review' | 'report';
export type QueueExecution = { status: 'legacy' } | { status: 'deferred' | 'obsolete'; reason: string }
  | { status: 'allowed'; missionId: string; attemptId: string; deadlineAt: Date; maxTries: number; remainingToolCalls: number; remainingTokens: number; reportPurpose?: 'interim' | 'final' };
const active = ['dispatching', 'dispatch_unknown', 'running'];
const prefix = 'server:queue-model:';
const stopped = (reason: string): QueueExecution => ({ status: 'obsolete', reason });
function measuredCalls(ids: string[]) {
  return ids.filter(id => id.startsWith(`${prefix}usage:`)).flatMap(id => {
    try { return [JSON.parse(id.slice(`${prefix}usage:`.length)) as { key: string; tokens: number | null; toolCalls: number | null; provider?: ProviderUsage }]; }
    catch { return []; }
  });
}

/** Caller holds a transaction. Queue leases are not execution permission: an
 * autonomous job must still belong to the exact currently authorized attempt. */
export async function queueExecution(connection: WorkspaceDatabase, kind: QueueKind, jobId: string): Promise<QueueExecution> {
  let missionId: string, originId: string | null = null;
  if (kind === 'review') {
    const [row] = await connection.select({ job: schema.resultAssessments, run: schema.testRuns }).from(schema.resultAssessments)
      .innerJoin(schema.testRuns, eq(schema.testRuns.id, schema.resultAssessments.runId)).where(eq(schema.resultAssessments.id, jobId));
    if (!row || row.job.runtime !== runtimeScope()) return stopped('Granskningsjobbet saknas i aktuell körmiljö.');
    if (!row.run.missionAttemptId) return { status: 'legacy' };
    originId = row.run.missionAttemptId;
    const [origin] = await connection.select().from(schema.missionAttempts).where(eq(schema.missionAttempts.id, originId));
    if (!origin || origin.runtime !== runtimeScope()) return stopped('Testets ursprungliga körförsök saknas.');
    missionId = origin.missionId;
  } else {
    const [job] = await connection.select().from(schema.missionReports).where(eq(schema.missionReports.id, jobId));
    if (!job) return stopped('Rapportjobbet saknas.');
    missionId = job.missionId;
  }
  await connection.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mission:${missionId}`}, 0))`);
  const [mission] = await connection.select().from(schema.missions).where(eq(schema.missions.id, missionId));
  if (!mission || mission.runtime !== runtimeScope()) return stopped('Uppdraget saknas i aktuell körmiljö.');
  if (mission.controllerVersion !== 1) return { status: 'legacy' };
  const [workspace] = await connection.select().from(schema.workspaces).where(eq(schema.workspaces.id, mission.workspaceId));
  if (!workspace || workspace.userId !== mission.userId) return stopped('Uppdragets användare har inte längre åtkomst till workspacet.');
  if (mission.lifecycle === 'closed') return stopped('Uppdraget är avslutat.');
  if (mission.lifecycle === 'paused' || process.env.MISSIONS_ENABLED === 'false' || process.env.AUTONOMOUS_MISSIONS_ENABLED !== 'true') return { status: 'deferred', reason: 'Uppdragets modellarbete är pausat.' };
  const mandate = missionMandateSchema.parse(mission.mandate);
  const [clock] = await connection.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
  const now = new Date(clock!.now);
  const rows = await connection.select({ attempt: schema.missionAttempts, task: schema.missionTasks }).from(schema.missionAttempts)
    .innerJoin(schema.missionTasks, eq(schema.missionTasks.id, schema.missionAttempts.taskId))
    .where(and(eq(schema.missionAttempts.missionId, missionId), eq(schema.missionAttempts.kind, kind))).orderBy(desc(schema.missionAttempts.createdAt));
  let runId: string | undefined;
  if (kind === 'review') {
    const [job] = await connection.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.id, jobId));
    const [origin] = await connection.select().from(schema.missionAttempts).where(eq(schema.missionAttempts.id, originId!));
    if (!job || job.userId !== mission.userId || job.workspaceId !== mission.workspaceId || !origin || origin.mandateRevision !== mission.mandateRevision || origin.planRevision !== mission.planRevision || origin.cancelRequestedAt) return stopped('Testets mandat är inte längre aktuellt.');
    const [run] = await connection.select().from(schema.testRuns).where(eq(schema.testRuns.id, job.runId));
    if (!run?.finishedAt || run.finishedAt > origin.deadlineAt) return stopped('Testets resultat sparades efter körförsökets deadline. Historiken bevaras men startar ingen automatisk granskning.');
    runId = job.runId;
  }
  const bound = rows.find(({ attempt, task }) => kind === 'report' ? attempt.executorResourceId === jobId && active.includes(attempt.status)
    : task.spec?.kind === 'review' && task.spec.runIds.includes(runId!) && task.sources.some(s => s.type === 'test' && s.id === runId) && active.includes(attempt.status));
  if (!bound) return stopped('Köjobbet saknar ett aktivt, exakt uppdragsförsök.');
  const { attempt, task } = bound;
  // A cancellation may finish its already queued, read-only final report. It
  // cannot authorize a new review or a new report job.
  const interim = kind === 'report' && isInterimReport(task.spec);
  const cancellingReport = kind === 'report' && !interim && mission.lifecycle === 'cancelling';
  if (attempt.runtime !== runtimeScope() || task.planRevision !== mission.planRevision || attempt.planRevision !== mission.planRevision
    || !cancellingReport && (attempt.mandateRevision !== mission.mandateRevision || attempt.cancelRequestedAt || task.state !== 'running')
    || !['accepted', 'running', 'waiting'].includes(mission.lifecycle!) && !cancellingReport) return stopped('Köjobbets mandat återkallades.');
  let interimDeadline: Date | undefined;
  if (interim) {
    try { interimDeadline = (await interimReportContext(connection, mission, task))!.deadlineAt; }
    catch (error) { if ((error as { data?: { code?: string } }).data?.code !== 'interim_obsolete') throw error; return stopped('Delrapportens väntan eller mandat gäller inte längre.'); }
  }
  const deadlineAt = new Date(Math.min(attempt.deadlineAt.getTime(), interimDeadline?.getTime() ?? Infinity, kind === 'report'
    ? Math.min(mission.reportDeadlineAt?.getTime() ?? Infinity, Date.parse(mandate.deadlineAt) + mandate.limits.reportDeliveryMs)
    : mission.deadlineAt?.getTime() ?? 0));
  if (deadlineAt <= now) return stopped('Köjobbets tidsbudget är slut.');
  const waits = await connection.select().from(schema.missionWaits).where(and(eq(schema.missionWaits.missionId, missionId), eq(schema.missionWaits.state, 'waiting')));
  if (waits.some(wait => wait.definition.planRevision === mission.planRevision && wait.definition.taskIds.includes(task.id))) return { status: 'deferred', reason: 'Köjobbet väntar på användaren.' };
  return { status: 'allowed', missionId, attemptId: attempt.id, deadlineAt, maxTries: interim ? 1 : kind === 'report' ? mandate.limits.maxReportAttempts : mandate.limits.maxOperationAttempts,
    ...(kind === 'report' ? { reportPurpose: interim ? 'interim' as const : 'final' as const } : {}),
    remainingTokens: Math.max(0, attempt.reservedTokens - (attempt.usage?.tokens ?? 0)),
    remainingToolCalls: Math.max(0, attempt.reservedToolCalls - Math.max(attempt.toolCalls, attempt.usage?.toolCalls ?? 0)) };
}

export type QueueModelCall = { execution: Extract<QueueExecution, { status: 'allowed' }>; key: string };
/** Mark admission immediately before the model, not when claiming the queue.
 * A crash before this marker remains safely retryable. Read-only reports may
 * reserve another finite physical attempt after charging an unknown old call;
 * the queue lease still fences exactly one final artifact. */
export async function beginQueueModel(kind: QueueKind, jobId: string, invocation: number, leaseToken: string) {
  return db.transaction(async tx => {
    const execution = await queueExecution(tx, kind, jobId);
    if (execution.status !== 'allowed') return { execution, call: null };
    const [job] = kind === 'review' ? await tx.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.id, jobId))
      : await tx.select().from(schema.missionReports).where(eq(schema.missionReports.id, jobId));
    const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
    if (!job || job.status !== 'running' || job.leaseToken !== leaseToken || !job.leaseUntil || job.leaseUntil <= new Date(clock!.now)) return { execution: stopped('Modellförsökets kölease är inte längre aktuell.'), call: null };
    const [attempt] = await tx.select().from(schema.missionAttempts).where(eq(schema.missionAttempts.id, execution.attemptId));
    const ids = attempt!.toolCallIds, key = `${kind}:${jobId}:${invocation}`;
    const calls = ids.filter(id => id.startsWith(`${prefix}start:`)).map(id => id.slice(`${prefix}start:`.length));
    const pending = calls.filter(call => !ids.includes(`${prefix}done:${call}`));
    const unfinished = pending.length > 0;
    const previousCalls = ids.filter(id => id.startsWith(`${prefix}start:${kind}:${jobId}:`)).length;
    if (kind !== 'report' && (unfinished || ids.includes(`${prefix}unknown`)) || previousCalls >= execution.maxTries
      || kind !== 'report' && (attempt!.usage?.tokens ?? 0) >= attempt!.reservedTokens) {
      if (unfinished) await tx.update(schema.missionAttempts).set({ usage: { tokens: null, toolCalls: null, durationMs: attempt!.usage?.durationMs ?? null }, toolCallIds: [...new Set([...ids, `${prefix}unknown`])] }).where(eq(schema.missionAttempts.id, attempt!.id));
      const reason = kind !== 'report' && (unfinished || ids.includes(`${prefix}unknown`))
        ? 'Tidigare modellanrops förbrukning är okänd. Inget nytt anrop startas.'
        : previousCalls >= execution.maxTries
          ? 'Tillåtna modellförsök är förbrukade.'
          : 'Modellanropets tokenbudget är förbrukad.';
      return { execution: stopped(reason), call: null };
    }
    const marker = `${prefix}start:${key}`;
    if (ids.includes(marker)) return { execution: stopped('Detta modellförsök har redan skickats.'), call: null };
    let reservedTokens = attempt!.reservedTokens, reservedToolCalls = attempt!.reservedToolCalls;
    const markers: string[] = [];
    if (kind === 'report') {
      if (pending.some(call => ids.includes(`${prefix}lease:${call}:${leaseToken}`))) return { execution: stopped('Ett rapportanrop pågår redan med samma kölease.'), call: null };
      const [mission] = await tx.select().from(schema.missions).where(eq(schema.missions.id, execution.missionId));
      const limits = missionMandateSchema.parse(mission!.mandate).limits, measured = measuredCalls(ids);
      const unknown = calls.filter(call => ids.includes(`${prefix}charged-unknown:${call}`) || pending.includes(call) || !measured.some(m => m.key === call && m.tokens !== null));
      const known = measured.filter(m => !unknown.includes(m.key));
      reservedTokens = known.reduce((sum, m) => sum + m.tokens!, 0) + (unknown.length + 1) * limits.tokensPerAttempt;
      reservedToolCalls = known.reduce((sum, m) => sum + (m.toolCalls ?? limits.toolCallsPerAttempt), 0) + (unknown.length + 1) * limits.toolCallsPerAttempt;
      const others = await tx.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.missionId, execution.missionId), eq(schema.missionAttempts.kind, 'report')));
      const reportAttempts = limits.maxReportAttempts - (execution.reportPurpose === 'interim' ? 1 : 0);
      if (others.reduce((sum, row) => sum + row.toolCallIds.filter(id => id.startsWith(`${prefix}start:`)).length, 0) >= reportAttempts) return { execution: stopped('Rapportleveransens antal modellförsök är förbrukat.'), call: null };
      const charge = (row: typeof schema.missionAttempts.$inferSelect, metric: 'tokens' | 'toolCalls') => {
        const reserved = metric === 'tokens' ? row.reservedTokens : row.reservedToolCalls, actual = row.usage?.[metric];
        return actual == null || ['reserved', ...active].includes(row.status) ? Math.max(reserved, actual ?? 0) : actual;
      };
      if (others.filter(a => a.id !== attempt!.id).reduce((sum, a) => sum + charge(a, 'tokens'), 0) + reservedTokens > reportAttempts * limits.tokensPerAttempt
        || others.filter(a => a.id !== attempt!.id).reduce((sum, a) => sum + charge(a, 'toolCalls'), 0) + reservedToolCalls > reportAttempts * limits.toolCallsPerAttempt) return { execution: stopped('Rapportens totala leveransbudget är förbrukad.'), call: null };
      for (const call of unknown) if (!ids.includes(`${prefix}charged-unknown:${call}`)) markers.push(`${prefix}charged-unknown:${call}`);
      if (unknown.length && !ids.includes(`${prefix}unknown`)) markers.push(`${prefix}unknown`);
      // This new physical call owns only its fresh read reservation; previous
      // unknown calls are already charged and cannot lend it their allowance.
      execution.remainingToolCalls = limits.toolCallsPerAttempt;
      execution.remainingTokens = limits.tokensPerAttempt;
    }
    await tx.update(schema.missionAttempts).set({ reservedTokens, reservedToolCalls, toolCallIds: [...ids, ...markers, marker, `${prefix}lease:${key}:${leaseToken}`],
      usage: markers.some(id => id.startsWith(`${prefix}charged-unknown:`)) ? { tokens: null, toolCalls: null, durationMs: attempt!.usage?.durationMs ?? null } : attempt!.usage ?? { tokens: 0, toolCalls: 0, durationMs: 0 },
    }).where(eq(schema.missionAttempts.id, attempt!.id));
    return { execution, call: { execution, key } satisfies QueueModelCall };
  });
}

/** Usage is historical accounting, so it is accepted even after cancellation.
 * Marker IDs never increment the executor's tool-call count. */
export async function settleQueueModel(call: QueueModelCall | null, usage: { tokens: number | null; durationMs: number; toolCalls?: number; provider?: ProviderUsage } | null) {
  if (!call) return;
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mission:${call.execution.missionId}`}, 0))`);
    const [attempt] = await tx.select().from(schema.missionAttempts).where(eq(schema.missionAttempts.id, call.execution.attemptId));
    const done = `${prefix}done:${call.key}`;
    if (!attempt || attempt.toolCallIds.includes(done)) return;
    const unknown = usage?.tokens == null || attempt.toolCallIds.includes(`${prefix}unknown`);
    const unknownTools = usage === null || attempt.toolCallIds.includes(`${prefix}unknown`) && attempt.usage?.toolCalls == null;
    const provider = combineProviderUsage([...measuredCalls(attempt.toolCallIds).flatMap(value => value.provider ? [value.provider] : []), ...(usage?.provider ? [usage.provider] : [])]);
    await tx.update(schema.missionAttempts).set({
      toolCallIds: [...attempt.toolCallIds, done, `${prefix}usage:${JSON.stringify({ key: call.key, tokens: usage?.tokens ?? null, toolCalls: usage?.toolCalls ?? (usage ? 0 : null), ...(usage?.provider ? { provider: usage.provider } : {}) })}`, ...(unknown ? [`${prefix}unknown`] : [])],
      usage: { tokens: unknown ? null : (attempt.usage?.tokens ?? 0) + usage!.tokens!, toolCalls: unknownTools ? null : Math.max(attempt.toolCalls, (attempt.usage?.toolCalls ?? 0) + (usage?.toolCalls ?? 0)), durationMs: (attempt.usage?.durationMs ?? 0) + (usage?.durationMs ?? 0), ...(provider ? { provider } : {}) },
    }).where(eq(schema.missionAttempts.id, attempt.id));
  });
}
