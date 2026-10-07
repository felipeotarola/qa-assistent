import { randomUUID } from 'node:crypto';
import { and, eq, desc, sql, inArray } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { missions, missionTasks, missionEvents, missionSnapshots, missionReports, missionWaits } from '../db/schema/missions';
import { missionActionSchema, sourceScopedLimitations, type MissionSnapshot, type MissionBinding } from '../../shared/mission';
import { missionMetrics } from '../../shared/mission-metrics';
import { DELIVERY_POLICY_VERSION } from '../../shared/mission-delivery';
import type { TestRun } from '../../shared/test-run';
import { runtimeScope } from '../../shared/runtime-scope';
import { requireWorkspace, publicItem, type WorkspaceDatabase } from './workspaces';
import { missionHash, readMissionSource } from './mission-sources';
import { missionRedactor, redactMissionValue } from './mission-redaction';
import { EVIDENCE_POLICY_VERSION } from '../../shared/evidence-provenance';
import { MISSION_REPORT_VERSION, REPORT_POLICY_ERROR, hasCurrentReportPolicy } from '../../shared/mission-report';
import { interimReportContext, isInterimReport } from './mission-interim-report';
function bindResult(mission: typeof missions.$inferSelect, task: typeof missionTasks.$inferSelect, result: import('../../shared/mission').WorkResult) {
  return { ...result, context: { resultId: `${result.sourceType}:${result.sourceId}`, missionId: mission.id, taskId: task.id, workspaceId: mission.workspaceId, runtime: mission.runtime, actor: task.actor, parentId: task.parentId, criterionIds: task.criterionIds } };
}
function deliveryTasks(mission: typeof missions.$inferSelect, tasks: (typeof missionTasks.$inferSelect)[]) {
  return mission.controllerVersion === 1 ? tasks.filter(task => task.planRevision === mission.planRevision && (task.spec?.kind !== 'report' || task.sources.length > 0)) : tasks;
}
function reportInputFingerprint(mission: typeof missions.$inferSelect, tasks: typeof missionTasks.$inferSelect[], selection: string, historicalNotes: Map<string, string>) {
  return missionHash({ config: mission.config, selection, historicalNotes: [...historicalNotes].sort(([a], [b]) => a.localeCompare(b)), tasks: tasks.map(task => ({
    id: task.id, title: task.title, actor: task.actor, parentId: task.parentId, criterionIds: task.criterionIds, dependsOn: task.dependsOn,
    // Finishing delivery changes the report task itself, not its input.
    state: task.spec?.kind === 'report' ? null : task.state, blockedReason: task.spec?.kind === 'report' ? null : task.blockedReason,
    sources: task.results,
  })).sort((a, b) => a.id.localeCompare(b.id)) });
}

/** Read-only content check. Does not reconcile state, wake a worker or queue a report. */
export async function missionReportIsStale(userId: string, workspaceId: string, snapshot: MissionSnapshot, connection?: WorkspaceDatabase) {
  const read = async (tx: WorkspaceDatabase) => {
    const mission = await ownedMission(userId, workspaceId, snapshot.missionId, tx);
    if (!snapshot.inputFingerprint) return mission.revision !== snapshot.revision;
    const tasks = deliveryTasks(mission, await tx.select().from(missionTasks).where(eq(missionTasks.missionId, mission.id)));
    try {
      for (const task of tasks) {
        const results = [];
        for (const ref of task.sources) results.push(bindResult(mission, task, await readMissionSource(tx, workspaceId, ref.type, ref.id)));
        task.results = results;
      }
      const selection = await selectedInputs(tx, mission, tasks);
      const views = tasks.map(task => ({ id: task.id, title: task.title, actor: task.actor, parentId: task.parentId, criterionIds: task.criterionIds, dependsOn: task.dependsOn, state: task.state, blockedReason: task.blockedReason, sources: task.results }));
      const projection = missionMetrics(selection.items, selection.runs, mission.config, views);
      const historicalNotes = await recoveredBrowserTaskNotes(tx, mission, tasks, projection.delivery);
      return reportInputFingerprint(mission, tasks, selection.fingerprint, historicalNotes) !== snapshot.inputFingerprint;
    } catch (error) { if ((error as { statusCode?: number }).statusCode === 404) return true; throw error; }
  };
  // A composed read projection can share its repeatable-read snapshot. The
  // default entry point retains its own transaction for existing callers.
  return connection ? read(connection) : db.transaction(read, { isolationLevel: 'repeatable read' });
}

async function selectedInputs(connection: WorkspaceDatabase, mission: typeof missions.$inferSelect, tasks: typeof missionTasks.$inferSelect[]) {
  const runIds = tasks.flatMap(t => t.sources.filter(s => s.type === 'test').map(s => s.id));
  const rows = runIds.length ? await connection.select().from(schema.testRuns).where(and(eq(schema.testRuns.workspaceId, mission.workspaceId), inArray(schema.testRuns.id, runIds))).orderBy(schema.testRuns.id) : [];
  // Explicit run references also need their current definitions for freshness.
  // Only the bound run IDs are loaded; newer runs are never adopted here.
  const itemIds = [...new Set([...mission.config.caseKeys.map(key => key.split(':')[0]!), ...rows.map(run => run.itemId)])];
  const itemRows = itemIds.length ? await connection.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.workspaceId, mission.workspaceId), inArray(schema.workspaceItems.id, itemIds))) : [];
  const items = itemRows.filter(i => !i.deletedAt && i.content.kind === 'test_plan').map(publicItem);
  const reviews = runIds.length ? await connection.select().from(schema.testRunReviews).where(inArray(schema.testRunReviews.runId, runIds)).orderBy(desc(schema.testRunReviews.createdAt), schema.testRunReviews.id) : [];
  const authors = reviews.length ? await connection.select({ id: schema.user.id, name: schema.user.name }).from(schema.user).where(inArray(schema.user.id, [...new Set(reviews.map(v => v.userId))])) : [];
  const runs: TestRun[] = rows.map(r => ({ ...r, startedAt: r.startedAt.toISOString(), finishedAt: iso(r.finishedAt), reviews: reviews.filter(v => v.runId === r.id).map(v => ({ ...v, authorName: authors.find(a => a.id === v.userId)?.name ?? 'Tidigare medlem', createdAt: v.createdAt.toISOString() })) }));
  return { items, runs, fingerprint: missionHash({ evidencePolicyVersion: EVIDENCE_POLICY_VERSION, deliveryPolicyVersion: DELIVERY_POLICY_VERSION, items: items.map(i => ({ id: i.id, version: i.version, content: i.content })).sort((a, b) => a.id.localeCompare(b.id)), runs }) };
}
/** Label only the original task-local note. Current coverage is still produced
 * by missionMetrics from freshly read, version-bound runs and assessments.
 * Neither original rows nor other source/evidence limitations are rewritten. */
async function recoveredBrowserTaskNotes(connection: WorkspaceDatabase, mission: typeof missions.$inferSelect,
  tasks: typeof missionTasks.$inferSelect[], delivery: MissionSnapshot['delivery']) {
  const notes = new Map<string, string>();
  if (mission.controllerVersion !== 1 || !delivery || !mission.mandate) return notes;
  const recoveries = tasks.filter(task => task.operationId?.startsWith('browser-remainder:') && task.state === 'completed');
  if (!recoveries.length) return notes;
  const events = await connection.select().from(missionEvents).where(and(eq(missionEvents.missionId, mission.id), eq(missionEvents.kind, 'browser_remainder_planned')));
  const attempts = await connection.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.missionId, mission.id), eq(schema.missionAttempts.runtime, mission.runtime)));
  if (!attempts.length) return notes;
  const runs = await connection.select().from(schema.testRuns).where(and(eq(schema.testRuns.workspaceId, mission.workspaceId), eq(schema.testRuns.runtime, mission.runtime), inArray(schema.testRuns.missionAttemptId, attempts.map(attempt => attempt.id))));
  const claims = await connection.select().from(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.missionId, mission.id));
  for (const task of recoveries) {
    const matches = events.filter(event => event.eventKey === task.operationId && event.payload.taskId === task.id);
    if (matches.length !== 1) continue;
    const event = matches[0]!, binding = event.payload;
    const source = tasks.find(row => row.id === binding.sourceTaskId), spec = source?.spec;
    if (!source?.blockedReason || !['blocked', 'failed'].includes(source.state!) || spec?.kind !== 'browser_tests' || spec.complement
      || source.operationId?.startsWith('browser-remainder:') || source.supplementRound !== 0 || source.planRevision !== mission.planRevision
      || task.spec?.kind !== 'browser_tests' || task.supplementRound !== 0 || task.planRevision !== mission.planRevision
      || binding.version !== 1 || binding.planRevision !== mission.planRevision || binding.mandateRevision !== mission.mandateRevision
      || binding.sourceSpecHash !== missionHash(spec) || task.operationId !== `browser-remainder:${source.id}`
      || missionHash(binding.caseKeys) !== missionHash(task.spec.caseKeys) || !task.spec.caseKeys.length
      || !spec.planVersions?.length || !spec.caseKeys.every(key => mission.config.caseKeys.includes(key))
      || !task.spec.caseKeys.every(key => spec.caseKeys.includes(key)) || missionHash(spec.target) !== missionHash(mission.config.target)
      || missionHash(task.spec) !== missionHash({ ...spec, caseKeys: task.spec.caseKeys,
        planVersions: spec.planVersions.filter(plan => task.spec?.kind === 'browser_tests' && task.spec.caseKeys.some(key => key.startsWith(`${plan.itemId}:`))) })) continue;
    const origins = attempts.filter(row => row.taskId === source.id), continuations = attempts.filter(row => row.taskId === task.id);
    const origin = origins.find(row => row.id === binding.sourceAttemptId), family = [...origins, ...continuations];
    if (!origin || !continuations.length || family.length > mission.mandate.limits.maxOperationAttempts
      || origin.attemptNo !== Math.max(...origins.map(row => row.attemptNo))
      || !origin.finishedAt || origin.finishedAt > task.createdAt || task.createdAt > event.createdAt
      || !mission.deadlineAt || event.createdAt >= mission.deadlineAt
      || family.some(row => row.planRevision !== mission.planRevision || row.mandateRevision !== mission.mandateRevision
        || row.kind !== 'browser_tests' || !['completed', 'failed'].includes(row.status) || row.cancelRequestedAt || !row.finishedAt || row.leaseUntil
        || row.operationId !== (row.taskId === source.id ? source.operationId : task.operationId)
        || row.createdAt >= row.deadlineAt || row.createdAt >= mission.deadlineAt!
        || (row.taskId === source.id ? row.finishedAt > event.createdAt : row.createdAt < event.createdAt))
      || claims.some(claim => family.some(row => row.id === claim.attemptId))) continue;
    const jobs = await connection.select().from(schema.browserJobs).where(and(eq(schema.browserJobs.runtime, mission.runtime), eq(schema.browserJobs.threadId, mission.threadId), inArray(schema.browserJobs.id, family.map(row => row.dispatchId))));
    if (jobs.length !== family.length || jobs.some(job => !['completed', 'failed'].includes(job.status) || job.dispatchLeaseUntil)) continue;
    const covered = spec.caseKeys.every(caseKey => {
      const current = delivery.cases.find(row => row.caseKey === caseKey);
      if (!current?.complete || !current.runId) return false;
      const originalRuns = runs.filter(run => `${run.itemId}:${run.caseId}` === caseKey).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
      const first = originalRuns[0], currentRun = originalRuns.find(run => run.id === current.runId);
      // Conservatively label only direct completed recovery. Later P3 chains
      // retain the original note until their own lineage is projected here.
      if (!first || currentRun?.id !== first.id || !currentRun.finishedAt) return false;
      const recovered = task.spec?.kind === 'browser_tests' && task.spec.caseKeys.includes(caseKey);
      const allowed = recovered ? continuations : origins;
      return allowed.some(attempt => attempt.id === currentRun.missionAttemptId && currentRun.startedAt >= attempt.createdAt
        && currentRun.finishedAt! <= attempt.deadlineAt && currentRun.finishedAt! <= mission.deadlineAt!)
        && (recovered ? first.startedAt >= event.createdAt : currentRun.finishedAt <= event.createdAt);
    });
    if (covered) notes.set(source.id, `Historisk notering för ${source.title}: ${source.blockedReason} En senare bunden fortsättning slutförde de då ostartade fallen. Aktuellt underlag innehåller avslutade och granskade körningar för deluppgiftens hela urval; observerade produktfel kvarstår som rapporterade utfall.`);
  }
  return notes;
}

async function syncSelection(connection: WorkspaceDatabase, mission: typeof missions.$inferSelect, fingerprint: string) {
  const [last] = await connection.select().from(missionEvents).where(and(eq(missionEvents.missionId, mission.id), eq(missionEvents.kind, 'selection'))).orderBy(desc(missionEvents.revision)).limit(1);
  return last?.payload.fingerprint === fingerprint ? mission : change(connection, mission, 'selection', { fingerprint });
}

/** Caller holds mission and workspace-content locks through the final commit. */
export async function currentMissionDelivery(connection: WorkspaceDatabase, missionId: string) {
  const [mission] = await connection.select().from(missions).where(and(eq(missions.id, missionId), eq(missions.runtime, runtimeScope())));
  if (!mission) throw createError({ statusCode: 404, statusMessage: 'Uppdraget hittades inte' });
  const tasks = deliveryTasks(mission, await connection.select().from(missionTasks).where(eq(missionTasks.missionId, mission.id)));
  const selection = await selectedInputs(connection, mission, tasks);
  const views = [];
  for (const task of tasks) {
    const sources = [];
    for (const source of task.sources) sources.push(bindResult(mission, task, await readMissionSource(connection, mission.workspaceId, source.type, source.id)));
    views.push({ ...task, sources });
  }
  return { config: mission.config, delivery: missionMetrics(selection.items, selection.runs, mission.config, views).delivery };
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
export function publicMission(mission: typeof missions.$inferSelect) {
  return { id: mission.id, workspaceId: mission.workspaceId, threadId: mission.threadId, config: mission.config, status: mission.status, revision: mission.revision,
    controllerVersion: mission.controllerVersion, intent: mission.intent, lifecycle: mission.lifecycle, phase: mission.phase, closureReason: mission.closureReason,
    mandateRevision: mission.mandateRevision, planRevision: mission.planRevision, deadlineAt: mission.deadlineAt, reportDeadlineAt: mission.reportDeadlineAt,
    heartbeatAt: mission.heartbeatAt, closedAt: mission.closedAt, createdAt: mission.createdAt, updatedAt: mission.updatedAt,
  };
}
export async function listMissions(userId: string, workspaceId: string) {
  await requireWorkspace(userId, workspaceId);
  const rows = await db.select().from(missions).where(and(eq(missions.workspaceId, workspaceId), eq(missions.runtime, runtimeScope()))).orderBy(desc(missions.updatedAt));
  const reports = rows.length ? await db.select({ id: missionReports.id, missionId: missionReports.missionId, status: missionReports.status, phase: missionReports.phase, error: missionReports.error, itemId: missionReports.itemId, createdAt: missionReports.createdAt, revision: missionSnapshots.revision, deleted: sql<boolean>`${missionReports.status} = 'completed' and (${schema.workspaceItems.id} is null or ${schema.workspaceItems.deletedAt} is not null)` }).from(missionReports).innerJoin(missionSnapshots, eq(missionSnapshots.id, missionReports.snapshotId)).leftJoin(schema.workspaceItems, eq(schema.workspaceItems.id, missionReports.itemId)).where(inArray(missionReports.missionId, rows.map(r => r.id))).orderBy(desc(missionSnapshots.revision), desc(missionReports.createdAt)) : [];
  const waits = rows.length ? await db.select().from(missionWaits).where(and(inArray(missionWaits.missionId, rows.map(r => r.id)), eq(missionWaits.state, 'waiting'))) : [];
  return { missions: rows.map(m => ({ ...publicMission(m), waits: waits.filter(w => w.missionId === m.id).map(w => ({ id: w.id, reason: w.definition.reason, question: w.definition.question, deadlineAt: w.deadlineAt, taskIds: w.definition.taskIds })), reports: reports.filter(r => r.missionId === m.id) })) };
}
/** Compatibility tool reads derive fresh results without becoming a second
 * writer of the controller's task cache, revisions or continuation events. */
async function readAutonomousMission(userId: string, workspaceId: string, missionId: string) {
  return db.transaction(async tx => {
    const mission = await ownedMission(userId, workspaceId, missionId, tx);
    const tasks = await tx.select().from(missionTasks).where(eq(missionTasks.missionId, missionId));
    for (const task of tasks) {
      const results = [];
      for (const source of task.sources) {
        try { results.push(bindResult(mission, task, await readMissionSource(tx, workspaceId, source.type, source.id))); }
        catch (error) {
          if ((error as { statusCode?: number }).statusCode !== 404) throw error;
          results.push(bindResult(mission, task, { schemaVersion: 2, sourceType: source.type, sourceId: source.id, attemptId: source.id,
            status: 'unknown', reportedOutcome: 'unknown', summary: 'Källan är inte längre tillgänglig.', evidence: [], limitations: ['Källan saknas.'],
            target: null, assessment: null, startedAt: null, finishedAt: null }));
        }
      }
      task.results = results;
    }
    const current = deliveryTasks(mission, tasks), selection = await selectedInputs(tx, mission, current);
    const views = current.map(task => ({ ...task, sources: task.results }));
    return { mission: publicMission(mission), tasks, delivery: missionMetrics(selection.items, selection.runs, mission.config, views).delivery };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
export async function missionAction(userId: string, workspaceId: string, threadId: string, input: unknown, options: { executionBinding?: boolean } = {}) {
  const action = missionActionSchema.parse(input);
  if (process.env.MISSIONS_ENABLED === 'false' && !['read', 'list'].includes(action.action)) throw createError({ statusCode: 503, statusMessage: 'Nya uppdragsändringar är tillfälligt pausade.' });
  await requireWorkspace(userId, workspaceId);
  const redact = await missionRedactor(db, workspaceId);
  if (action.action === 'create' || action.action === 'update') {
    if (action.config.target?.scope) throw createError({ statusCode: 400, statusMessage: 'Observationsscope skapas av den beständiga uppdragsstyrningen.' });
    action.config = redactMissionValue(action.config, redact);
    action.config.title = redact(action.config.title); action.config.goal = redact(action.config.goal); action.config.scope = redact(action.config.scope);
    action.config.criteria = action.config.criteria.map(c => ({ ...c, text: redact(c.text) }));
    if (action.action === 'update') action.reason = redact(action.reason);
  }
  if (action.action === 'task') action.task.title = redact(action.task.title);
  if (action.action === 'list') return listMissions(userId, workspaceId);
  if (action.action === 'report') {
    const mission = await ownedMission(userId, workspaceId, action.missionId);
    if (mission.controllerVersion === 1) throw createError({ statusCode: 409, statusMessage: 'Rapportleveransen drivs av uppdraget. Läs dess status eller starta ett separat rapportuppdrag för sparade resultat.' });
    return requestMissionReport(userId, workspaceId, action.missionId, action.retry);
  }
  if (action.action === 'read') {
    const mission = await ownedMission(userId, workspaceId, action.missionId);
    if (mission.controllerVersion === 1) return readAutonomousMission(userId, workspaceId, mission.id);
    await reconcileMission(userId, workspaceId, action.missionId);
    return db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mission:${action.missionId}`}, 0))`);
      const mission = await ownedMission(userId, workspaceId, action.missionId, tx);
      const tasks = await tx.select().from(missionTasks).where(eq(missionTasks.missionId, action.missionId));
      const selection = await selectedInputs(tx, mission, tasks);
      const views = tasks.map(t => ({ ...t, sources: t.results }));
      return { mission: publicMission(mission), tasks, delivery: missionMetrics(selection.items, selection.runs, mission.config, views).delivery };
    });
  }
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
    if (mission.controllerVersion === 1 && !(action.action === 'attach' && options.executionBinding)) throw createError({ statusCode: 409, statusMessage: 'Autonoma uppdrag ändras genom uppdragsstyrningen.' });
    // Execution attachment and closure share the mission lock. Historical source
    // references remain attachable; they are never authorization for new work.
    if (options.executionBinding && (action.action !== 'attach' || mission.status !== 'active' || mission.controllerVersion === 1 && !['accepted', 'running', 'waiting'].includes(mission.lifecycle!))) throw createError({ statusCode: 409, statusMessage: 'Nya körningar kräver ett aktivt uppdrag.' });
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
  return missionAction(userId, workspaceId, threadId, { action: 'attach', ...binding, sourceType, sourceId }, { executionBinding: true });
}
export async function validateMissionBinding(userId: string, workspaceId: string, binding: MissionBinding | undefined) {
  if (!binding) return;
  const mission = await ownedMission(userId, workspaceId, binding.missionId);
  const [task] = await db.select().from(missionTasks).where(and(eq(missionTasks.id, binding.taskId), eq(missionTasks.missionId, mission.id)));
  if (!task || mission.status !== 'active' || mission.controllerVersion === 1 && (!['accepted', 'running', 'waiting'].includes(mission.lifecycle!) || task.planRevision !== mission.planRevision)) throw createError({ statusCode: 409, statusMessage: 'Ange en deluppgift i ett aktivt uppdrag.' });
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
    const tasks = deliveryTasks(mission, await tx.select().from(missionTasks).where(eq(missionTasks.missionId, missionId)).orderBy(missionTasks.createdAt, missionTasks.id));
    for (const task of tasks) {
      const results = [];
      for (const source of task.sources) {
        try { results.push(bindResult(mission, task, await readMissionSource(tx, workspaceId, source.type, source.id))); }
        catch (e) { if ((e as { statusCode?: number }).statusCode !== 404) throw e; results.push({ schemaVersion: 2 as const, sourceType: source.type, sourceId: source.id, attemptId: source.id, status: 'unknown' as const, reportedOutcome: 'unknown' as const, summary: 'Källan är inte längre tillgänglig.', evidence: [], limitations: ['Källan saknas.'], target: null, assessment: null, startedAt: null, finishedAt: null }); }
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
type ReportExecution = { leaseToken: string; fence: number; mandateRevision: number; planRevision: number; attemptId: string };
export async function requestMissionReport(userId: string, workspaceId: string, missionId: string, retry = false, execution?: ReportExecution): Promise<{ reportId?: string; status: string; note?: string }> {
  for (let attempt = 0; ; attempt++) {
    try { return await queueMissionReport(userId, workspaceId, missionId, retry, execution); }
    catch (error) {
      const e = error as { code?: string; cause?: { code?: string } };
      if (attempt >= 2 || !['40001', '40P01'].includes(e.code ?? e.cause?.code ?? '')) throw error;
    }
  }
}
async function queueMissionReport(userId: string, workspaceId: string, missionId: string, retry: boolean, execution?: ReportExecution) {
  if (process.env.MISSION_REPORTS_ENABLED === 'false') throw createError({ statusCode: 503, statusMessage: 'Rapportgenerering är tillfälligt pausad.' });
  await reconcileMission(userId, workspaceId, missionId);
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mission:${missionId}`}, 0))`);
    let mission = await ownedMission(userId, workspaceId, missionId, tx);
    let purpose: 'interim' | 'final' = 'final';
    let interim: Awaited<ReturnType<typeof interimReportContext>> = null;
    if (mission.controllerVersion === 1) {
      const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
      if (!execution || mission.leaseToken !== execution.leaseToken || mission.fence !== execution.fence || mission.mandateRevision !== execution.mandateRevision || mission.planRevision !== execution.planRevision || !mission.leaseUntil || mission.leaseUntil <= new Date(clock!.now) || !['running', 'accepted', 'waiting'].includes(mission.lifecycle!)) throw createError({ statusCode: 409, statusMessage: 'Uppdragsstyrningens aktuella mandat krävs för rapportbeställningen.' });
      const [attempt] = await tx.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.id, execution.attemptId), eq(schema.missionAttempts.missionId, missionId)));
      if (!attempt || attempt.runtime !== mission.runtime || attempt.kind !== 'report' || attempt.mandateRevision !== mission.mandateRevision || attempt.planRevision !== mission.planRevision || attempt.cancelRequestedAt || !['dispatching', 'dispatch_unknown', 'running'].includes(attempt.status)) throw createError({ statusCode: 409, statusMessage: 'Rapportförsöket är inte längre aktuellt.' });
      const [task] = await tx.select().from(missionTasks).where(and(eq(missionTasks.id, attempt.taskId), eq(missionTasks.missionId, missionId)));
      if (!task || task.spec?.kind !== 'report' || task.state !== 'running' || attempt.deadlineAt <= new Date(clock!.now)) throw createError({ statusCode: 409, statusMessage: 'Rapportuppgiften är inte längre aktuell.' });
      purpose = isInterimReport(task.spec) ? 'interim' : 'final';
      interim = await interimReportContext(tx, mission, task);
    }
    // Queue row and executor binding commit together. A lost acknowledgement
    // cannot lose this identity or attach a report using timestamp guesses.
    const bindReport = async (reportId: string) => {
      if (execution) await tx.update(schema.missionAttempts).set({ executorResourceId: reportId, status: 'running', updatedAt: new Date() }).where(eq(schema.missionAttempts.id, execution.attemptId));
    };
    const tasks = deliveryTasks(mission, await tx.select().from(missionTasks).where(eq(missionTasks.missionId, missionId)).orderBy(missionTasks.createdAt, missionTasks.id));
    const selection = await selectedInputs(tx, mission, tasks);
    mission = await syncSelection(tx, mission, selection.fingerprint);
    const existing = await tx.select({ report: missionReports, snapshot: missionSnapshots }).from(missionReports).innerJoin(missionSnapshots, eq(missionSnapshots.id, missionReports.snapshotId)).where(eq(missionReports.missionId, missionId));
    const current = existing.filter(r => hasCurrentReportPolicy(r.report.version, r.snapshot.input));
    for (const old of existing.filter(r => !current.includes(r) && ['queued', 'running'].includes(r.report.status))) await tx.update(missionReports).set({ status: 'failed', phase: 'Bevispolicy uppdaterad', error: REPORT_POLICY_ERROR, finishedAt: new Date(), leaseToken: null, leaseUntil: null }).where(eq(missionReports.id, old.report.id));
    // A policy change invalidates a cached success, even for an empty mission.
    if (existing.some(r => r.snapshot.revision === mission.revision && !current.includes(r))) mission = await change(tx, mission, 'evidence-policy', { evidencePolicyVersion: EVIDENCE_POLICY_VERSION });
    // Purpose is immutable snapshot metadata. A progress artifact can never be
    // reused as final delivery, even when no evidence has changed meanwhile.
    if (current.some(r => r.snapshot.revision === mission.revision && (r.snapshot.input.reportPurpose ?? 'final') !== purpose)) mission = await change(tx, mission, 'report-purpose', { purpose });
    const taskViews = tasks.map(t => ({ id: t.id, title: t.title, actor: t.actor, parentId: t.parentId, criterionIds: t.criterionIds, dependsOn: t.dependsOn, state: t.state, blockedReason: t.blockedReason, sources: t.results }));
    const projection = missionMetrics(selection.items, selection.runs, mission.config, taskViews);
    const historicalNotes = await recoveredBrowserTaskNotes(tx, mission, tasks, projection.delivery);
    const inputFingerprint = reportInputFingerprint(mission, tasks, selection.fingerprint, historicalNotes);
    if (current.some(row => row.snapshot.revision === mission.revision && row.snapshot.input.inputFingerprint !== inputFingerprint)) {
      mission = await change(tx, mission, 'report-input', { inputFingerprint });
    }
    const match = current.find(r => r.snapshot.revision === mission.revision && (r.snapshot.input.reportPurpose ?? 'final') === purpose);
    if (match) { const restarting = retry && match.report.status === 'failed'; if (restarting) await tx.update(missionReports).set({ status: 'queued', attempts: 0, error: null, nextAttemptAt: new Date() }).where(eq(missionReports.id, match.report.id)); await bindReport(match.report.id); return { reportId: match.report.id, status: restarting ? 'queued' : match.report.status }; }
    if (current.some(r => ['queued', 'running'].includes(r.report.status))) return { status: 'waiting', note: 'Klara arbetar redan. Nyaste underlaget tas med i nästa rapport.' };
    const snapshot: MissionSnapshot = redactMissionValue({ schemaVersion: 2 as const, reportPurpose: purpose, inputFingerprint, missionId, workspaceId, revision: mission.revision, config: mission.config, status: mission.status, capturedAt: new Date().toISOString(), tasks: taskViews, tests: projection.tests, metrics: projection.metrics, delivery: projection.delivery,
      gaps: [...(interim ? ['Detta är en delrapport medan uppdraget fortsätter. Kvarstående frågor är inte besvarade och inget fortsatt mandat antas.', ...interim.waits.map(wait => `Väntar på svar till ${wait.deadlineAt.toISOString()}: ${wait.definition.question}`)] : []), ...projection.gaps, ...tasks.flatMap(t => [...(t.blockedReason ? [historicalNotes.get(t.id) ?? `${t.title}: ${t.blockedReason}`] : []), ...(!t.sources.length ? [`${t.title}: inget utförarjobb registrerat.`] : t.results.flatMap(r => sourceScopedLimitations(r, t.title)))])] }, await missionRedactor(tx, workspaceId));
    let [saved] = await tx.insert(missionSnapshots).values({ id: randomUUID(), missionId, revision: mission.revision, hash: missionHash(snapshot), input: snapshot }).onConflictDoNothing().returning();
    if (!saved) [saved] = await tx.select().from(missionSnapshots).where(and(eq(missionSnapshots.missionId, missionId), eq(missionSnapshots.revision, mission.revision)));
    const [report] = await tx.insert(missionReports).values({ id: randomUUID(), missionId, snapshotId: saved!.id, version: MISSION_REPORT_VERSION }).returning();
    await bindReport(report!.id);
    await tx.update(missions).set({ dirtySince: null }).where(eq(missions.id, missionId));
    return { reportId: report!.id, status: 'queued' };
  }, { isolationLevel: 'repeatable read' });
}
const iso = (v: Date | null) => v?.toISOString() ?? null;
