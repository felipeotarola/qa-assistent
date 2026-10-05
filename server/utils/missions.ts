import { randomUUID } from 'node:crypto';
import { and, eq, desc, sql, inArray } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { missions, missionTasks, missionEvents, missionSnapshots, missionReports } from '../db/schema/missions';
import { missionActionSchema, type MissionSnapshot, type MissionBinding } from '../../shared/mission';
import { missionMetrics } from '../../shared/mission-metrics';
import type { TestRun } from '../../shared/test-run';
import { runtimeScope } from '../../shared/runtime-scope';
import { requireWorkspace, publicItem, type WorkspaceDatabase } from './workspaces';
import { missionHash, readMissionSource } from './mission-sources';
import { missionRedactor, redactMissionValue } from './mission-redaction';
function bindResult(mission: typeof missions.$inferSelect, task: typeof missionTasks.$inferSelect, result: import('../../shared/mission').WorkResult) {
  return { ...result, context: { resultId: `${result.sourceType}:${result.sourceId}`, missionId: mission.id, taskId: task.id, workspaceId: mission.workspaceId, runtime: mission.runtime, actor: task.actor, parentId: task.parentId, criterionIds: task.criterionIds } };
}

async function selectedInputs(connection: WorkspaceDatabase, mission: typeof missions.$inferSelect, tasks: typeof missionTasks.$inferSelect[]) {
  const itemRows = await connection.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, mission.workspaceId));
  const items = itemRows.filter(i => !i.deletedAt && i.content.kind === 'test_plan' && mission.config.caseKeys.some(key => key.startsWith(`${i.id}:`))).map(publicItem);
  const runIds = tasks.flatMap(t => t.sources.filter(s => s.type === 'test').map(s => s.id));
  const rows = runIds.length ? await connection.select().from(schema.testRuns).where(and(eq(schema.testRuns.workspaceId, mission.workspaceId), inArray(schema.testRuns.id, runIds))).orderBy(schema.testRuns.id) : [];
  const reviews = runIds.length ? await connection.select().from(schema.testRunReviews).where(inArray(schema.testRunReviews.runId, runIds)).orderBy(desc(schema.testRunReviews.createdAt), schema.testRunReviews.id) : [];
  const authors = reviews.length ? await connection.select({ id: schema.user.id, name: schema.user.name }).from(schema.user).where(inArray(schema.user.id, [...new Set(reviews.map(v => v.userId))])) : [];
  const runs: TestRun[] = rows.map(r => ({ ...r, startedAt: r.startedAt.toISOString(), finishedAt: iso(r.finishedAt), reviews: reviews.filter(v => v.runId === r.id).map(v => ({ ...v, authorName: authors.find(a => a.id === v.userId)?.name ?? 'Tidigare medlem', createdAt: v.createdAt.toISOString() })) }));
  return { items, runs, fingerprint: missionHash({ items: items.map(i => ({ id: i.id, version: i.version, content: i.content })).sort((a, b) => a.id.localeCompare(b.id)), runs }) };
}
async function syncSelection(connection: WorkspaceDatabase, mission: typeof missions.$inferSelect, fingerprint: string) {
  const [last] = await connection.select().from(missionEvents).where(and(eq(missionEvents.missionId, mission.id), eq(missionEvents.kind, 'selection'))).orderBy(desc(missionEvents.revision)).limit(1);
  return last?.payload.fingerprint === fingerprint ? mission : change(connection, mission, 'selection', { fingerprint });
}

export async function ownedMission(userId: string, workspaceId: string, id: string, connection: WorkspaceDatabase = db) {
  await requireWorkspace(userId, workspaceId, connection);
  const [mission] = await connection.select().from(missions).where(and(eq(missions.id, id), eq(missions.workspaceId, workspaceId), eq(missions.userId, userId), eq(missions.runtime, runtimeScope())));
  if (!mission) throw createError({ statusCode: 404, statusMessage: 'Uppdraget hittades inte' });
  return mission;
}
async function change(connection: WorkspaceDatabase, mission: typeof missions.$inferSelect, kind: string, payload: Record<string, unknown>) {
  const [updated] = await connection.update(missions).set({ revision: mission.revision + 1, updatedAt: new Date(), dirtySince: mission.dirtySince ?? new Date() }).where(eq(missions.id, mission.id)).returning();
  await connection.insert(missionEvents).values({ id: randomUUID(), missionId: mission.id, revision: updated!.revision, kind, payload });
  return updated!;
}
export async function listMissions(userId: string, workspaceId: string) {
  await requireWorkspace(userId, workspaceId);
  const rows = await db.select().from(missions).where(and(eq(missions.workspaceId, workspaceId), eq(missions.runtime, runtimeScope()))).orderBy(desc(missions.updatedAt));
  const reports = rows.length ? await db.select({ id: missionReports.id, missionId: missionReports.missionId, status: missionReports.status, phase: missionReports.phase, error: missionReports.error, itemId: missionReports.itemId, createdAt: missionReports.createdAt, revision: missionSnapshots.revision, deleted: sql<boolean>`${missionReports.status} = 'completed' and (${schema.workspaceItems.id} is null or ${schema.workspaceItems.deletedAt} is not null)` }).from(missionReports).innerJoin(missionSnapshots, eq(missionSnapshots.id, missionReports.snapshotId)).leftJoin(schema.workspaceItems, eq(schema.workspaceItems.id, missionReports.itemId)).where(inArray(missionReports.missionId, rows.map(r => r.id))).orderBy(desc(missionSnapshots.revision), desc(missionReports.createdAt)) : [];
  return { missions: rows.map(m => ({ ...m, reports: reports.filter(r => r.missionId === m.id) })) };
}
export async function missionAction(userId: string, workspaceId: string, threadId: string, input: unknown) {
  const action = missionActionSchema.parse(input);
  if (process.env.MISSIONS_ENABLED === 'false' && !['read', 'list'].includes(action.action)) throw createError({ statusCode: 503, statusMessage: 'Nya uppdragsändringar är tillfälligt pausade.' });
  await requireWorkspace(userId, workspaceId);
  const redact = await missionRedactor(db, workspaceId);
  if (action.action === 'create' || action.action === 'update') {
    action.config = redactMissionValue(action.config, redact);
    action.config.title = redact(action.config.title); action.config.goal = redact(action.config.goal); action.config.scope = redact(action.config.scope);
    action.config.criteria = action.config.criteria.map(c => ({ ...c, text: redact(c.text) }));
    if (action.action === 'update') action.reason = redact(action.reason);
  }
  if (action.action === 'task') action.task.title = redact(action.task.title);
  if (action.action === 'list') return listMissions(userId, workspaceId);
  if (action.action === 'report') return requestMissionReport(userId, workspaceId, action.missionId, action.retry);
  if (action.action === 'read') { await reconcileMission(userId, workspaceId, action.missionId); return { mission: await ownedMission(userId, workspaceId, action.missionId), tasks: await db.select().from(missionTasks).where(eq(missionTasks.missionId, action.missionId)) }; }
  return db.transaction(async tx => {
    if (action.action === 'create') {
      const [row] = await tx.insert(missions).values({ id: randomUUID(), workspaceId, userId, threadId, runtime: runtimeScope(), requestId: action.requestId, config: action.config }).onConflictDoNothing().returning();
      if (row) { await tx.insert(missionEvents).values({ id: randomUUID(), missionId: row.id, revision: 1, kind: 'created', payload: { config: action.config } }); return row; }
      const [existing] = await tx.select().from(missions).where(and(eq(missions.workspaceId, workspaceId), eq(missions.runtime, runtimeScope()), eq(missions.requestId, action.requestId)));
      if (missionHash(existing?.config) !== missionHash(action.config)) throw createError({ statusCode: 409, statusMessage: 'Request already used for another mission' });
      return existing;
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mission:${action.missionId}`}, 0))`);
    let mission = await ownedMission(userId, workspaceId, action.missionId, tx);
    if (action.action === 'update') {
      if (mission.revision !== action.expectedRevision) throw createError({ statusCode: 409, statusMessage: 'Uppdraget ändrades. Läs om före uppdatering.' });
      const tasks = await tx.select().from(missionTasks).where(eq(missionTasks.missionId, mission.id));
      if (tasks.some(t => t.criterionIds.some(id => !action.config.criteria.some(c => c.id === id)))) throw createError({ statusCode: 409, statusMessage: 'Behåll kriterier som används av deluppgifter.' });
      if (action.status === 'closed' && tasks.some(t => !t.results.length || t.results.some(r => ['planned', 'running', 'unknown'].includes(r.status)))) throw createError({ statusCode: 409, statusMessage: 'Avsluta eller avbryt registrerade deluppgifter först.' });
      mission = await change(tx, mission, 'config', { config: action.config, reason: action.reason, status: action.status });
      const [saved] = await tx.update(missions).set({ config: action.config, status: action.status }).where(eq(missions.id, mission.id)).returning(); return saved;
    }
    const tasks = await tx.select().from(missionTasks).where(eq(missionTasks.missionId, mission.id));
    if (action.action === 'task') {
      if (tasks.length >= 200 && !tasks.some(t => t.requestId === action.requestId)) throw createError({ statusCode: 409, statusMessage: 'Avgränsa uppdraget till högst 200 deluppgifter.' });
      if (action.task.criterionIds.some(id => !mission.config.criteria.some(c => c.id === id)) || [...action.task.dependsOn, ...(action.task.parentId ? [action.task.parentId] : [])].some(id => !tasks.some(t => t.id === id))) throw createError({ statusCode: 400, statusMessage: 'Unknown criteria or task dependency' });
      const [task] = await tx.insert(missionTasks).values({ id: randomUUID(), missionId: mission.id, requestId: action.requestId, ...action.task }).onConflictDoNothing().returning();
      if (task) { await change(tx, mission, 'task', { taskId: task.id }); return task; }
      const existing = tasks.find(t => t.requestId === action.requestId);
      if (!existing || missionHash({ title: existing.title, actor: existing.actor, parentId: existing.parentId ?? null, dependsOn: existing.dependsOn, criterionIds: existing.criterionIds }) !== missionHash({ ...action.task, parentId: action.task.parentId ?? null })) throw createError({ statusCode: 409, statusMessage: 'Request already used' });
      return existing;
    }
    const task = tasks.find(t => t.id === action.taskId);
    if (!task) throw createError({ statusCode: 404, statusMessage: 'Task not in mission' });
    const result = bindResult(mission, task, await readMissionSource(tx, workspaceId, action.sourceType, action.sourceId));
    if (tasks.some(t => t.id !== task.id && t.sources.some(s => s.type === action.sourceType && s.id === action.sourceId))) throw createError({ statusCode: 409, statusMessage: 'Job already attached to another task in this mission' });
    if (task.sources.some(s => s.type === action.sourceType && s.id === action.sourceId)) return task;
    const [saved] = await tx.update(missionTasks).set({ sources: [...task.sources, { type: action.sourceType, id: action.sourceId }], results: [...task.results, result] }).where(eq(missionTasks.id, task.id)).returning();
    await change(tx, mission, 'source', { taskId: task.id, result }); return saved;
  });
}
export async function bindMissionSource(userId: string, workspaceId: string, threadId: string, binding: MissionBinding | undefined, sourceType: 'test' | 'setup' | 'browser' | 'repository' | 'research', sourceId: string) {
  if (!binding) return;
  return missionAction(userId, workspaceId, threadId, { action: 'attach', ...binding, sourceType, sourceId });
}
export async function validateMissionBinding(userId: string, workspaceId: string, binding: MissionBinding | undefined) {
  if (!binding) return;
  const mission = await ownedMission(userId, workspaceId, binding.missionId);
  const [task] = await db.select().from(missionTasks).where(and(eq(missionTasks.id, binding.taskId), eq(missionTasks.missionId, mission.id)));
  if (!task || mission.status !== 'active') throw createError({ statusCode: 409, statusMessage: 'Ange en deluppgift i ett aktivt uppdrag.' });
}
export async function sourceMissionBinding(workspaceId: string, sourceType: string, sourceId: string) {
  const rows = await db.select({ missionId: missions.id, taskId: missionTasks.id }).from(missionTasks).innerJoin(missions, eq(missions.id, missionTasks.missionId)).where(and(eq(missions.workspaceId, workspaceId), eq(missions.runtime, runtimeScope()), sql`${missionTasks.sources} @> ${JSON.stringify([{ type: sourceType, id: sourceId }])}::jsonb`));
  if (rows.length > 1) throw createError({ statusCode: 409, statusMessage: 'Välj uppdrag uttryckligen; jobbet tillhör flera uppdrag.' });
  return rows[0];
}
export async function reconcileMission(userId: string, workspaceId: string, missionId: string) {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mission:${missionId}`}, 0))`);
    let mission = await ownedMission(userId, workspaceId, missionId, tx);
    const tasks = await tx.select().from(missionTasks).where(eq(missionTasks.missionId, missionId)).orderBy(missionTasks.createdAt, missionTasks.id);
    for (const task of tasks) {
      const results = [];
      for (const source of task.sources) {
        try { results.push(bindResult(mission, task, await readMissionSource(tx, workspaceId, source.type, source.id))); }
        catch (e) { if ((e as { statusCode?: number }).statusCode !== 404) throw e; results.push({ schemaVersion: 1 as const, sourceType: source.type, sourceId: source.id, attemptId: source.id, status: 'unknown' as const, reportedOutcome: 'unknown' as const, summary: 'Källan är inte längre tillgänglig.', evidence: [], limitations: ['Källan saknas.'], target: null, assessment: null, startedAt: null, finishedAt: null }); }
      }
      if (missionHash(results) !== missionHash(task.results)) {
        await tx.update(missionTasks).set({ results }).where(eq(missionTasks.id, task.id));
        mission = await change(tx, mission, 'results', { taskId: task.id, results });
      }
    }
    const selection = await selectedInputs(tx, mission, tasks);
    return syncSelection(tx, mission, selection.fingerprint);
  });
}
export async function requestMissionReport(userId: string, workspaceId: string, missionId: string, retry = false): Promise<{ reportId?: string; status: string; note?: string }> {
  for (let attempt = 0; ; attempt++) {
    try { return await queueMissionReport(userId, workspaceId, missionId, retry); }
    catch (error) {
      const e = error as { code?: string; cause?: { code?: string } };
      if (attempt >= 2 || !['40001', '40P01'].includes(e.code ?? e.cause?.code ?? '')) throw error;
    }
  }
}
async function queueMissionReport(userId: string, workspaceId: string, missionId: string, retry: boolean) {
  if (process.env.MISSION_REPORTS_ENABLED === 'false') throw createError({ statusCode: 503, statusMessage: 'Rapportgenerering är tillfälligt pausad.' });
  await reconcileMission(userId, workspaceId, missionId);
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mission:${missionId}`}, 0))`);
    let mission = await ownedMission(userId, workspaceId, missionId, tx);
    const tasks = await tx.select().from(missionTasks).where(eq(missionTasks.missionId, missionId)).orderBy(missionTasks.createdAt, missionTasks.id);
    const selection = await selectedInputs(tx, mission, tasks);
    mission = await syncSelection(tx, mission, selection.fingerprint);
    const existing = await tx.select({ report: missionReports, snapshot: missionSnapshots }).from(missionReports).innerJoin(missionSnapshots, eq(missionSnapshots.id, missionReports.snapshotId)).where(eq(missionReports.missionId, missionId));
    const match = existing.find(r => r.snapshot.revision === mission.revision);
    if (match) { const restarting = retry && match.report.status === 'failed'; if (restarting) await tx.update(missionReports).set({ status: 'queued', attempts: 0, error: null, nextAttemptAt: new Date() }).where(eq(missionReports.id, match.report.id)); return { reportId: match.report.id, status: restarting ? 'queued' : match.report.status }; }
    if (existing.some(r => ['queued', 'running'].includes(r.report.status))) return { status: 'waiting', note: 'Klara arbetar redan. Nyaste underlaget tas med i nästa rapport.' };
    const taskViews = tasks.map(t => ({ id: t.id, title: t.title, actor: t.actor, parentId: t.parentId, criterionIds: t.criterionIds, dependsOn: t.dependsOn, sources: t.results }));
    const projection = missionMetrics(selection.items, selection.runs, mission.config, taskViews);
    const snapshot: MissionSnapshot = redactMissionValue({ schemaVersion: 1 as const, missionId, workspaceId, revision: mission.revision, config: mission.config, status: mission.status, capturedAt: new Date().toISOString(), tasks: taskViews, tests: projection.tests, metrics: projection.metrics,
      gaps: [...projection.gaps, ...tasks.flatMap(t => !t.sources.length ? [`${t.title}: inget utförarjobb registrerat.`] : t.results.flatMap(r => r.limitations))] }, await missionRedactor(tx, workspaceId));
    let [saved] = await tx.insert(missionSnapshots).values({ id: randomUUID(), missionId, revision: mission.revision, hash: missionHash(snapshot), input: snapshot }).onConflictDoNothing().returning();
    if (!saved) [saved] = await tx.select().from(missionSnapshots).where(and(eq(missionSnapshots.missionId, missionId), eq(missionSnapshots.revision, mission.revision)));
    const [report] = await tx.insert(missionReports).values({ id: randomUUID(), missionId, snapshotId: saved!.id, version: '1' }).returning();
    await tx.update(missions).set({ dirtySince: null }).where(eq(missions.id, missionId));
    return { reportId: report!.id, status: 'queued' };
  }, { isolationLevel: 'repeatable read' });
}
const iso = (v: Date | null) => v?.toISOString() ?? null;
