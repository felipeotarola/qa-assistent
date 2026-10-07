import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import type { MissionTaskSpec } from '../../shared/mission-control';
import { runtimeScope } from '../../shared/runtime-scope';
import { addMissionTask, autonomyEnabled, currentMandate, lockMission, recordMissionEvent, type ControlledMission } from './mission-control';
import { claimedMission, databaseNow, type MissionLease } from './mission-attempts';
import { requireWorkspace, type WorkspaceDatabase } from './workspaces';
import { readMissionSource } from './mission-sources';

type Task = typeof schema.missionTasks.$inferSelect;
export const isInterimReport = (spec: MissionTaskSpec | null | undefined) => spec?.kind === 'report' && spec.purpose === 'interim';
const operation = (revision: number) => `report:interim:${revision}`;
const denied = () => createError({ statusCode: 409, statusMessage: 'Delrapportens väntan eller mandat gäller inte längre.', data: { code: 'interim_obsolete' } });

/** Call while holding the mission lock. A stored wait is a condition, never an
 * authorization to extend work. The exact original set must still be pending. */
export async function interimReportContext(connection: WorkspaceDatabase, mission: ControlledMission, task: Task) {
  if (!isInterimReport(task.spec)) return null;
  const now = await databaseNow(connection);
  if (!autonomyEnabled() || mission.runtime !== runtimeScope() || !['accepted', 'running', 'waiting'].includes(mission.lifecycle!)
    || mission.phase === 'report' || task.planRevision !== mission.planRevision || !mission.deadlineAt || mission.deadlineAt <= now) throw denied();
  const [event] = await connection.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, operation(mission.planRevision!))));
  const ids = event?.payload.waitIds;
  if (!event || event.payload.taskId !== task.id || event.payload.mandateRevision !== mission.mandateRevision || !Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw denied();
  const waits = await connection.select().from(schema.missionWaits).where(and(eq(schema.missionWaits.missionId, mission.id), inArray(schema.missionWaits.id, ids as string[])));
  // Re-read the clock after SQL waits. Answering any original question makes
  // the frozen progress report obsolete; a new question cannot adopt it.
  const checkedAt = await databaseNow(connection);
  if (waits.length !== ids.length || waits.some(wait => wait.state !== 'waiting' || wait.deadlineAt <= checkedAt || wait.definition.mandateRevision !== mission.mandateRevision || wait.definition.planRevision !== mission.planRevision)
    || mission.deadlineAt <= checkedAt) throw denied();
  return { waits, deadlineAt: new Date(Math.min(mission.deadlineAt.getTime(), ...waits.map(wait => wait.deadlineAt.getTime()))) };
}

/** One optional progress report per plan, reusing the normal snapshot/writer.
 * It neither changes phase nor closes/cancels any independent work. */
export async function proposeInterimReport(lease: MissionLease) {
  return db.transaction(async tx => {
    const mission = await claimedMission(tx, lease), mandate = currentMandate(mission);
    if (!autonomyEnabled() || process.env.MISSION_REPORTS_ENABLED === 'false' || mandate.intent === 'report_only' || mandate.limits.maxReportAttempts < 2 || mission.phase === 'report') return null;
    const now = await databaseNow(tx);
    if (!mission.deadlineAt || mission.deadlineAt <= now) return null;
    const tasks = await tx.select().from(schema.missionTasks).where(and(eq(schema.missionTasks.missionId, mission.id), eq(schema.missionTasks.planRevision, mission.planRevision!)));
    if (tasks.some(task => task.spec?.kind === 'report')) return null;
    const waits = (await tx.select().from(schema.missionWaits).where(and(eq(schema.missionWaits.missionId, mission.id), eq(schema.missionWaits.state, 'waiting'))))
      .filter(wait => wait.deadlineAt > now && wait.definition.planRevision === mission.planRevision && wait.definition.mandateRevision === mission.mandateRevision);
    const waitingIds = new Set(waits.flatMap(wait => wait.definition.taskIds));
    if (!waits.length) return null;
    let hasCompletedEvidence = false;
    for (const task of tasks.filter(task => task.state === 'completed' && task.spec?.kind !== 'report' && !waitingIds.has(task.id))) {
      for (const ref of task.sources) {
        try {
          const result = await readMissionSource(tx, mission.workspaceId, ref.type, ref.id);
          if (['completed', 'failed'].includes(result.status) && result.evidence.length > 0) hasCompletedEvidence = true;
        } catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
      }
    }
    if (!hasCompletedEvidence) return null;
    await claimedMission(tx, lease);
    const readyAt = await databaseNow(tx);
    if (mission.deadlineAt <= readyAt || waits.some(wait => wait.deadlineAt <= readyAt)) return null;
    const task = await addMissionTask(tx, mission, { operationId: operation(mission.planRevision!), title: 'Klara sammanställer en delrapport', spec: { kind: 'report', purpose: 'interim', sourceRefs: [], partial: true } });
    await recordMissionEvent(tx, mission, 'interim_report_requested', { taskId: task.id, waitIds: waits.map(wait => wait.id).sort(), mandateRevision: mission.mandateRevision }, operation(mission.planRevision!));
    return task;
  });
}

/** Revoke only this optional delivery. Its old provider receipt can still be
 * accounted, but a late writer loses its queue lease and cannot save material. */
export async function abandonInterimReport(lease: MissionLease, taskId: string, reason: string) {
  return db.transaction(async tx => {
    // Cleanup is permitted while paused/cancelling, but still belongs to the
    // exact current controller lease, owner and runtime.
    await lockMission(tx, lease.missionId);
    const [mission] = await tx.select().from(schema.missions).where(and(eq(schema.missions.id, lease.missionId), eq(schema.missions.runtime, runtimeScope())));
    if (!mission || mission.lifecycle === 'closed' || mission.leaseToken !== lease.leaseToken || mission.fence !== lease.fence || mission.mandateRevision !== lease.mandateRevision || mission.planRevision !== lease.planRevision || !mission.leaseUntil || mission.leaseUntil <= await databaseNow(tx)) throw denied();
    await requireWorkspace(mission.userId, mission.workspaceId, tx);
    const [task] = await tx.select().from(schema.missionTasks).where(and(eq(schema.missionTasks.id, taskId), eq(schema.missionTasks.missionId, mission.id)));
    if (!task || !isInterimReport(task.spec) || !['pending', 'ready', 'running'].includes(task.state!)) return;
    const now = await databaseNow(tx);
    const attempts = await tx.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.missionId, mission.id), eq(schema.missionAttempts.taskId, task.id)));
    for (const attempt of attempts) {
      if (attempt.executorResourceId) await tx.update(schema.missionReports).set({ status: 'failed', phase: 'Delrapport avbruten', error: reason, finishedAt: now, leaseToken: null, leaseUntil: null })
        .where(and(eq(schema.missionReports.id, attempt.executorResourceId), eq(schema.missionReports.missionId, mission.id), inArray(schema.missionReports.status, ['queued', 'running'])));
      if (['reserved', 'dispatching', 'dispatch_unknown', 'running'].includes(attempt.status)) await tx.update(schema.missionAttempts).set({ status: 'cancelled', cancelRequestedAt: now, error: reason, finishedAt: now, leaseToken: null, leaseUntil: null, updatedAt: now }).where(eq(schema.missionAttempts.id, attempt.id));
    }
    await tx.update(schema.missionTasks).set({ state: 'cancelled', blockedReason: reason, updatedAt: now }).where(eq(schema.missionTasks.id, task.id));
    await recordMissionEvent(tx, mission, 'interim_report_abandoned', { taskId, reason }, `interim-abandoned:${task.id}`);
  });
}
