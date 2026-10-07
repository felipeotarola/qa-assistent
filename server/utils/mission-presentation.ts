import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { missions, missionAttempts, missionResourceClaims, missionWaits, missionReports, missionSnapshots, missionTasks, missionEvents } from '../db/schema/missions';
import { presentMission, type MissionPresentation, type MissionReportPresentation, type MissionDetailPresentation } from '../../shared/mission-presentation';
import { missionTelemetry } from '../../shared/mission-telemetry';
import { runtimeScope } from '../../shared/runtime-scope';
import { requireWorkspace, type WorkspaceDatabase } from './workspaces';
import { missionReportIsStale, ownedMission } from './missions';
import { missionRedactor } from './mission-redaction';
import { autonomyEnabled } from './mission-control';

type Mission = typeof missions.$inferSelect;
async function project(connection: WorkspaceDatabase, userId: string, workspaceId: string, rows: Mission[]) {
  if (!rows.length) return [];
  const ids = rows.map(m => m.id);
  // Ownership/runtime is checked on the parent mission. Never hide a leftover
  // physical claim merely because its executor carries an older runtime tag.
  const attempts = await connection.select().from(missionAttempts).where(inArray(missionAttempts.missionId, ids));
  const claims = await connection.select().from(missionResourceClaims).where(and(inArray(missionResourceClaims.missionId, ids), eq(missionResourceClaims.workspaceId, workspaceId)));
  const waits = await connection.select().from(missionWaits).where(and(inArray(missionWaits.missionId, ids), eq(missionWaits.state, 'waiting')));
  const reports = await connection.selectDistinctOn([missionReports.missionId], { report: { id: missionReports.id, missionId: missionReports.missionId, status: missionReports.status }, snapshot: { missionId: missionSnapshots.missionId, input: missionSnapshots.input }, item: { id: schema.workspaceItems.id, deletedAt: schema.workspaceItems.deletedAt } })
    .from(missionReports).innerJoin(missionSnapshots, eq(missionSnapshots.id, missionReports.snapshotId))
    .leftJoin(schema.workspaceItems, and(eq(schema.workspaceItems.id, missionReports.itemId), eq(schema.workspaceItems.workspaceId, workspaceId)))
    .where(inArray(missionReports.missionId, ids)).orderBy(missionReports.missionId, desc(missionSnapshots.revision), desc(missionReports.createdAt), desc(missionReports.id));
  const redact = await missionRedactor(connection, workspaceId);
  // Raw executor identifiers may have accidentally been echoed into model text.
  // They are neither UI routing identifiers nor useful user-facing status.
  const privateValues = [...new Set([
    ...rows.flatMap(m => [m.leaseToken, m.requestHash]),
    ...attempts.flatMap(a => [a.id, a.dispatchId, a.leaseToken, a.executorResourceId]),
    ...claims.flatMap(c => [c.id, c.poolKey, c.resourceKey, c.leaseToken, c.executorResourceId]),
  ].filter((value): value is string => !!value && value.length >= 6))].sort((a, b) => b.length - a.length);
  const text = (value: string, max: number) => privateValues.reduce((result, secret) => result.split(secret).join('[intern referens]'), redact(value)).slice(0, max);
  const [clock] = await connection.execute<{ now: string }>(sql`select transaction_timestamp()::text as now`);
  const now = new Date(clock!.now), result: MissionPresentation[] = [];
  for (const mission of rows) {
    if (mission.controllerVersion !== 1 || !mission.lifecycle || !mission.phase || !mission.intent || !mission.mandateRevision || !mission.planRevision) throw createError({ statusCode: 409, statusMessage: 'Uppdragets styrningsversion kan inte visas.' });
    const latest = reports.find(row => row.report.missionId === mission.id);
    let report: MissionReportPresentation | null = null;
    if (latest) {
      const status = ['queued', 'running', 'completed', 'failed'].includes(latest.report.status) ? latest.report.status as MissionReportPresentation['status'] : 'unknown';
      const deleted = status === 'completed' && (!latest.item?.id || latest.item.deletedAt !== null);
      let freshness: MissionReportPresentation['freshness'] = status === 'completed' && !deleted ? 'unknown' : 'not_applicable';
      if (freshness === 'unknown' && latest.snapshot.missionId === mission.id && latest.snapshot.input.missionId === mission.id && /^[a-f0-9]{64}$/.test(latest.snapshot.input.inputFingerprint ?? '')) {
        freshness = await missionReportIsStale(userId, workspaceId, latest.snapshot.input, connection) ? 'stale' : 'current';
      }
      report = { id: latest.report.id, itemId: !deleted && latest.item?.id ? latest.item.id : null, status, freshness, deleted };
    }
    result.push(presentMission({ mission: { ...mission, title: text(mission.config.title, 200), intent: mission.intent, lifecycle: mission.lifecycle,
      phase: mission.phase, mandateRevision: mission.mandateRevision, planRevision: mission.planRevision },
    attempts: attempts.filter(a => a.missionId === mission.id), claims: claims.filter(c => c.missionId === mission.id),
    waits: waits.filter(w => w.missionId === mission.id).map(w => ({ ...w, definition: { ...w.definition, question: text(w.definition.question, 3000) } })),
    report, autonomyEnabled: autonomyEnabled(), now }));
  }
  return result;
}

/** Authenticated read-only projection. It neither calls executors nor reconciles
 * missions. Report freshness shares the same repeatable-read SQL snapshot. */
export async function readMissionPresentation(userId: string, workspaceId: string, missionId: string) {
  return db.transaction(async tx => {
    const mission = await ownedMission(userId, workspaceId, missionId, tx);
    if (mission.controllerVersion !== 1) throw createError({ statusCode: 404, statusMessage: 'Det autonoma uppdraget hittades inte.' });
    return (await project(tx, userId, workspaceId, [mission]))[0]!;
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/** Numeric diagnostics for one already-owned mission. Every query follows its
 * persisted membership; unrelated workspace runs, reports and events are never
 * scanned into its totals. Historical physical claims remain visible. */
async function telemetry(connection: WorkspaceDatabase, mission: Mission, now: string) {
  const attempts = await connection.select().from(missionAttempts).where(and(eq(missionAttempts.missionId, mission.id), eq(missionAttempts.runtime, mission.runtime)));
  const tasks = await connection.select({ id: missionTasks.id, state: missionTasks.state, sources: missionTasks.sources }).from(missionTasks).where(eq(missionTasks.missionId, mission.id));
  const waits = await connection.select({ id: missionWaits.id, state: missionWaits.state, deadlineAt: missionWaits.deadlineAt }).from(missionWaits).where(eq(missionWaits.missionId, mission.id));
  const resources = await connection.select({ id: missionResourceClaims.id, owner: missionResourceClaims.owner, state: missionResourceClaims.state, expiresAt: missionResourceClaims.expiresAt }).from(missionResourceClaims)
    .where(and(eq(missionResourceClaims.missionId, mission.id), eq(missionResourceClaims.workspaceId, mission.workspaceId)));
  const events = await connection.select({ id: missionEvents.id, kind: missionEvents.kind }).from(missionEvents).where(and(eq(missionEvents.missionId, mission.id), inArray(missionEvents.kind, ['late_executor_receipt', 'dispatch_unknown', 'wait_expired'])));
  const reports = await connection.select({ id: missionReports.id, status: missionReports.status, createdAt: missionReports.createdAt, usage: missionReports.usage }).from(missionReports).where(eq(missionReports.missionId, mission.id));
  const runIds = [...new Set(tasks.flatMap(task => task.sources.filter(source => source.type === 'test').map(source => source.id)))];
  const membership = or(runIds.length ? inArray(schema.testRuns.id, runIds) : undefined,
    attempts.length ? inArray(schema.testRuns.missionAttemptId, attempts.map(attempt => attempt.id)) : undefined);
  const reviews = membership ? await connection.select({ id: schema.resultAssessments.id, status: schema.resultAssessments.status, createdAt: schema.resultAssessments.createdAt })
    .from(schema.resultAssessments).innerJoin(schema.testRuns, eq(schema.testRuns.id, schema.resultAssessments.runId))
    .where(and(membership, eq(schema.testRuns.workspaceId, mission.workspaceId), eq(schema.testRuns.runtime, mission.runtime),
      eq(schema.resultAssessments.workspaceId, mission.workspaceId), eq(schema.resultAssessments.runtime, mission.runtime), eq(schema.resultAssessments.userId, mission.userId))) : [];
  return missionTelemetry({ now, mission, attempts, tasks, waits, resources, events, reports, reviews });
}

/** Session GET boundary uses one database snapshot for status, content freshness
 * and diagnostics. It cannot claim work, reconcile, or drain a queue. */
export async function readMissionDetail(userId: string, workspaceId: string, missionId: string): Promise<MissionDetailPresentation> {
  return db.transaction(async tx => {
    const mission = await ownedMission(userId, workspaceId, missionId, tx);
    if (mission.controllerVersion !== 1) throw createError({ statusCode: 404, statusMessage: 'Det autonoma uppdraget hittades inte.' });
    const presentation = (await project(tx, userId, workspaceId, [mission]))[0]!;
    return { mission: presentation, telemetry: await telemetry(tx, mission, presentation.observedAt) };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/** Bounded workspace summary; historical/manual missions stay in their existing
 * view and are not adopted by the autonomous controller through a read. */
export async function listMissionPresentations(userId: string, workspaceId: string, limit = 30) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw createError({ statusCode: 400, statusMessage: 'Ogiltigt antal uppdrag.' });
  return db.transaction(async tx => {
    await requireWorkspace(userId, workspaceId, tx);
    const rows = await tx.select().from(missions).where(and(eq(missions.workspaceId, workspaceId), eq(missions.userId, userId), eq(missions.runtime, runtimeScope()), eq(missions.controllerVersion, 1)))
      .orderBy(desc(missions.updatedAt), desc(missions.id)).limit(limit + 1);
    return { missions: await project(tx, userId, workspaceId, rows.slice(0, limit)), hasMore: rows.length > limit };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
