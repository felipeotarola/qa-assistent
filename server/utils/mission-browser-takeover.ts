import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { schema } from '@nuxthub/db';
import { browserTakeoverReceiptSchema, browserTakeoverRunId, type BrowserTakeoverReceipt, type BrowserTakeoverScope } from '../../shared/mission-browser-return';
import { runtimeScope } from '../../shared/runtime-scope';
import { missionMandateSchema, MISSION_CONTROLLER_VERSION } from '../../shared/mission-control';
import { assertBrowserLock, browserLockSignal } from './browser-lock';
import { autonomyEnabled, lockMission, recordMissionEvent, type ControlledMission } from './mission-control';
import { missionHash } from './mission-sources';
import { browserAttemptAssignment } from './mission-browser-return';
import type { WorkspaceDatabase } from './workspaces';

type Assignment = typeof schema.browserAssignments.$inferSelect;
type Attempt = typeof schema.missionAttempts.$inferSelect;
type Task = typeof schema.missionTasks.$inferSelect;
type Claim = typeof schema.missionResourceClaims.$inferSelect;
const key = (id: string) => `browser-human-takeover:${id}`;
const denied = () => createError({ statusCode: 409, statusMessage: 'Övertagandet tillhör inte det ursprungliga testförsöket.' });
const digest = (row: Assignment) => row.projectId?.startsWith('self-hosted-policy-v1:') ? row.projectId.slice('self-hosted-policy-v1:'.length)
  : row.projectId?.startsWith('vps-preview-policy-v1:') ? row.projectId.split(':')[2] : undefined;
async function clock(connection: WorkspaceDatabase) {
  const [row] = await connection.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
  return new Date(row!.now);
}

function scope(mission: ControlledMission, task: Task, attempt: Attempt, assignment: Assignment, claim: Claim): BrowserTakeoverScope | null {
  const policyDigest = digest(assignment);
  if (!policyDigest || !assignment.sessionId || mission.controllerVersion !== MISSION_CONTROLLER_VERSION
    || !missionMandateSchema.safeParse(mission.mandate).success || task.spec?.kind !== 'browser_tests'
    || mission.runtime !== runtimeScope() || attempt.runtime !== mission.runtime || claim.runtime !== mission.runtime
    || mission.workspaceId !== assignment.workspaceId || mission.userId !== assignment.userId || mission.threadId !== assignment.threadId
    || task.missionId !== mission.id || task.planRevision !== mission.planRevision || attempt.kind !== 'browser_tests'
    || attempt.missionId !== mission.id || attempt.taskId !== task.id || attempt.planRevision !== mission.planRevision || attempt.mandateRevision !== mission.mandateRevision
    || attempt.requestHash !== missionHash({ spec: task.spec, planRevision: mission.planRevision, mandateRevision: mission.mandateRevision })
    || claim.attemptId !== attempt.id || claim.missionId !== mission.id || claim.workspaceId !== mission.workspaceId
    || claim.resourceKey !== `browser:${mission.workspaceId}` || claim.executorResourceId !== assignment.sessionId || claim.fence !== attempt.fence) return null;
  return { version: 1, missionId: mission.id, userId: mission.userId, workspaceId: mission.workspaceId, threadId: mission.threadId,
    sourceAttemptId: attempt.id, sourceDispatchId: attempt.dispatchId, taskId: task.id, assignmentId: assignment.id,
    physicalSessionId: assignment.sessionId, claimId: claim.id, runtime: mission.runtime, fence: attempt.fence,
    planRevision: attempt.planRevision, mandateRevision: attempt.mandateRevision, requestHash: attempt.requestHash,
    policyDigest, deadlineAt: attempt.deadlineAt.toISOString() };
}

/** Caller holds the browser lock. Snapshot the one active run before HTTP, in
 * a short browser -> mission transaction. No network await holds row locks. */
export async function captureBrowserTakeover(connection: WorkspaceDatabase, assignment: Assignment) {
  if (!browserLockSignal() || !autonomyEnabled() || assignment.control !== 'agent' || !digest(assignment) || !assignment.sessionId) return null;
  await assertBrowserLock();
  const claims = await connection.select().from(schema.missionResourceClaims).where(and(eq(schema.missionResourceClaims.workspaceId, assignment.workspaceId),
    eq(schema.missionResourceClaims.runtime, runtimeScope()), eq(schema.missionResourceClaims.executorResourceId, assignment.sessionId)));
  if (claims.length !== 1) return null;
  const origin = claims[0]!;
  return connection.transaction(async tx => {
    await lockMission(tx, origin.missionId);
    const [mission] = await tx.select().from(schema.missions).where(eq(schema.missions.id, origin.missionId));
    const [attempt] = await tx.select().from(schema.missionAttempts).where(eq(schema.missionAttempts.id, origin.attemptId));
    const [claim] = await tx.select().from(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.id, origin.id));
    if (!mission || !attempt || !claim) return null;
    const [task] = await tx.select().from(schema.missionTasks).where(eq(schema.missionTasks.id, attempt.taskId));
    const [current] = await tx.select().from(schema.browserAssignments).where(eq(schema.browserAssignments.id, assignment.id));
    const now = await clock(tx);
    const bound = task && current ? scope(mission, task, attempt, current, claim) : null;
    if (!bound || !current || current.control !== 'agent' || current.sessionId !== assignment.sessionId || !current.expiresAt || current.expiresAt <= now
      || !autonomyEnabled() || !['running', 'waiting'].includes(mission.lifecycle!) || mission.phase === 'report'
      || !mission.deadlineAt || mission.deadlineAt <= now || attempt.deadlineAt <= now || attempt.cancelRequestedAt
      || !['dispatching', 'dispatch_unknown', 'running'].includes(attempt.status) || task!.state !== 'running'
      || !attempt.leaseUntil || attempt.leaseUntil <= now
      || claim.state !== 'claimed' || claim.owner !== 'agent' || claim.expiresAt <= now || claim.leaseToken !== attempt.leaseToken) return null;
    const [job] = await tx.select().from(schema.browserJobs).where(and(eq(schema.browserJobs.id, attempt.dispatchId), eq(schema.browserJobs.runtime, mission.runtime), eq(schema.browserJobs.threadId, mission.threadId)));
    if (!job?.sessionId || !['running', 'dispatch_unknown'].includes(job.status)
      || (await browserAttemptAssignment(tx, mission, attempt, job.sessionId))?.id !== current.id) return null;
    const spec = task?.spec;
    if (spec?.kind !== 'browser_tests') return null;
    const runs = await tx.select().from(schema.testRuns).where(eq(schema.testRuns.missionAttemptId, attempt.id));
    const active = runs.filter(run => !run.finishedAt || !run.result);
    // No run or ambiguous active runs records a boundary without retry rights.
    const only = active.length === 1 ? active[0]! : null;
    const run = only && !only.finishedAt && !only.result && only.workspaceId === mission.workspaceId && only.threadId === mission.threadId
      && only.runtime === mission.runtime && only.startedAt <= now && spec.caseKeys.includes(`${only.itemId}:${only.caseId}`)
      && spec.planVersions?.some(plan => plan.itemId === only.itemId && plan.version === only.planVersion) ? only : null;
    await assertBrowserLock();
    return browserTakeoverReceiptSchema.parse({ ...bound, id: randomUUID(), requestedAt: now.toISOString(), confirmedAt: now.toISOString(),
      run: run ? { id: run.id, itemId: run.itemId, caseId: run.caseId, planVersion: run.planVersion, startedAt: run.startedAt.toISOString() } : null });
  });
}

/** Only call after the existing physical human ACK and assignment patch. A
 * crash/lost ACK leaves no additional retry authority. Never infer login state. */
export async function recordBrowserTakeover(connection: WorkspaceDatabase, assignment: Assignment, pending: BrowserTakeoverReceipt | null) {
  if (!pending || !browserLockSignal()) return;
  await assertBrowserLock();
  await connection.transaction(async tx => {
    await lockMission(tx, pending.missionId);
    const [mission] = await tx.select().from(schema.missions).where(eq(schema.missions.id, pending.missionId));
    const [attempt] = await tx.select().from(schema.missionAttempts).where(eq(schema.missionAttempts.id, pending.sourceAttemptId));
    const [claim] = await tx.select().from(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.id, pending.claimId));
    const [task] = await tx.select().from(schema.missionTasks).where(eq(schema.missionTasks.id, pending.taskId));
    const [current] = await tx.select().from(schema.browserAssignments).where(eq(schema.browserAssignments.id, assignment.id));
    const now = await clock(tx), bound = mission && attempt && claim && task && current ? scope(mission, task, attempt, current, claim) : null;
    if (!bound || !mission || !attempt || !claim || !current || current.control !== 'human'
      || !current.expiresAt || current.expiresAt <= now || Object.entries(bound).some(([field, value]) => pending[field as keyof BrowserTakeoverScope] !== value)
      || !autonomyEnabled() || !['running', 'waiting'].includes(mission.lifecycle!) || mission.phase === 'report'
      || !mission.deadlineAt || mission.deadlineAt <= now || attempt.deadlineAt <= now || attempt.cancelRequestedAt
      || !['dispatching', 'dispatch_unknown', 'running', 'completed', 'failed'].includes(attempt.status)
      || claim.state !== 'claimed' || claim.expiresAt <= now) return;
    await assertBrowserLock();
    await recordMissionEvent(tx, mission, 'browser_human_takeover', { takeover: { ...pending, confirmedAt: now.toISOString() } }, key(pending.id));
    await assertBrowserLock();
  });
}

/** Caller already holds the mission lock. Only the latest acknowledged human
 * boundary for this original attempt can nominate its own active-at-take run. */
export async function browserTakeoverContinuation(connection: WorkspaceDatabase, mission: ControlledMission, task: Task, attempt: Attempt,
  assignment: Assignment, claim: Claim, before: Date, requireSettled = true, beforeRevision?: number) {
  const [event] = await connection.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id),
    eq(schema.missionEvents.kind, 'browser_human_takeover'), sql`${schema.missionEvents.payload}->'takeover'->>'sourceAttemptId' = ${attempt.id}`))
    .orderBy(desc(schema.missionEvents.revision)).limit(1);
  if (!event) return null;
  const parsed = browserTakeoverReceiptSchema.safeParse(event.payload.takeover), bound = scope(mission, task, attempt, assignment, claim);
  if (!parsed.success || !bound || event.eventKey !== key(parsed.data.id)
    || beforeRevision !== undefined && event.revision >= beforeRevision) throw denied();
  const takeover = parsed.data;
  const runs = takeover.run ? await connection.select().from(schema.testRuns).where(eq(schema.testRuns.id, takeover.run.id)) : [];
  let runId: string | null;
  try { runId = browserTakeoverRunId(takeover, bound, runs, before, requireSettled); }
  catch { throw denied(); }
  if (!runId) return null;
  if (task.spec?.kind !== 'browser_tests' || !task.spec.caseKeys.includes(`${takeover.run!.itemId}:${takeover.run!.caseId}`)
    || !task.spec.planVersions?.some(plan => plan.itemId === takeover.run!.itemId && plan.version === takeover.run!.planVersion)) throw denied();
  return { eventId: event.id, runId };
}
