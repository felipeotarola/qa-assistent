import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@nuxthub/db';
import { missionComplementSchema, nextComplementRound, type MissionComplement } from '../../shared/mission-complement';
import { currentAssessmentSchema, reviewGaps, validateAssessment } from '../../shared/result-assessment';
import { sameTarget } from '../../shared/test-target';
import { runtimeScope } from '../../shared/runtime-scope';
import type { WorkspaceDatabase } from './workspaces';
import { autonomyEnabled, currentMandate, addMissionTask, recordMissionEvent, type ControlledMission } from './mission-control';
import { hashReview, readCurrentRunAssessment } from './result-assessments';
import { missionHash } from './mission-sources';

type Task = typeof schema.missionTasks.$inferSelect;
const terminal = new Set(['completed', 'failed']);
const remainderPrefix = 'browser-remainder:';

/** Generic recovery cannot replace an authentication-dependent browser after
 * its exact return failed, or while its human prerequisite remains unanswered.
 * Walk only saved server lineage in the current epoch; unrelated work and old
 * waits do not become a mission-wide prohibition. Caller holds mission lock. */
async function blockedBrowserReturnLineage(tx: WorkspaceDatabase, mission: ControlledMission, task: Task) {
  const events = await tx.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), inArray(schema.missionEvents.kind, ['browser_return_invalidated', 'browser_remainder_planned'])));
  const waits = await tx.select().from(schema.missionWaits).where(eq(schema.missionWaits.missionId, mission.id));
  const unresolved = waits.filter(wait => wait.definition.reason === 'human_browser'
    && wait.definition.planRevision === mission.planRevision && wait.definition.mandateRevision === mission.mandateRevision
    && (wait.state !== 'answered' || wait.answer?.kind !== 'browser_returned' || !wait.answeredAt
      || wait.answeredAt < wait.createdAt || wait.answeredAt >= wait.deadlineAt));
  if (!unresolved.length && !events.some(event => event.kind === 'browser_return_invalidated')) return false;
  const attempts = await tx.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.missionId, mission.id), eq(schema.missionAttempts.runtime, runtimeScope()),
    eq(schema.missionAttempts.planRevision, mission.planRevision!), eq(schema.missionAttempts.mandateRevision, mission.mandateRevision!)));
  const tasks = await tx.select().from(schema.missionTasks).where(and(eq(schema.missionTasks.missionId, mission.id), eq(schema.missionTasks.planRevision, mission.planRevision!)));
  const visited = new Set<string>();
  let current: Task | undefined = task;
  while (current) {
    if (visited.has(current.id) || current.spec?.kind !== 'browser_tests') return true;
    visited.add(current.id);
    const id = current.id;
    if (unresolved.some(wait => wait.definition.taskIds.includes(id)) || events.some(event => event.kind === 'browser_return_invalidated'
      && event.payload.taskId === id && event.eventKey === `browser-return-invalidated:${event.payload.attemptId}`
      && attempts.some(attempt => attempt.id === event.payload.attemptId && attempt.taskId === id))) return true;
    let sourceTaskId: string, sourceAttemptId: string;
    if (current.spec.complement) {
      sourceTaskId = current.spec.complement.sourceTaskId;
      sourceAttemptId = current.spec.complement.sourceAttemptId;
    } else if (current.operationId?.startsWith(remainderPrefix)) {
      const binding = events.find(event => event.kind === 'browser_remainder_planned' && event.eventKey === current!.operationId)?.payload;
      if (!binding || binding.taskId !== id || binding.planRevision !== mission.planRevision || binding.mandateRevision !== mission.mandateRevision
        || typeof binding.sourceTaskId !== 'string' || typeof binding.sourceAttemptId !== 'string') return true;
      sourceTaskId = binding.sourceTaskId;
      sourceAttemptId = binding.sourceAttemptId;
    } else return false;
    current = tasks.find(source => source.id === sourceTaskId);
    if (!current || !attempts.some(attempt => attempt.id === sourceAttemptId && attempt.taskId === sourceTaskId)) return true;
  }
  return false;
}

/** Executor recovery is distinct from a review's evidence complement. Only
 * cases with no run at all may enter this branch; no reported outcome is retried.
 * The event binds the original frozen task without expanding the model schema.
 */
export async function proposeUnstartedBrowserRecovery(tx: WorkspaceDatabase, mission: ControlledMission, task: Task) {
  if (!autonomyEnabled() || mission.intent === 'report_only' || !['accepted', 'running', 'waiting'].includes(mission.lifecycle!) || mission.phase === 'report'
    || task.missionId !== mission.id || task.planRevision !== mission.planRevision || task.spec?.kind !== 'browser_tests' || task.spec.complement
    || task.supplementRound !== 0 || task.operationId?.startsWith(remainderPrefix) || !['completed', 'failed', 'blocked'].includes(task.state!)) return null;
  const operationId = `${remainderPrefix}${task.id}`;
  if ((await tx.select({ id: schema.missionEvents.id }).from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, operationId)))).length) return null;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${mission.workspaceId}`}, 0))`);
  if (await blockedBrowserReturnLineage(tx, mission, task)) return null;
  const attempts = await tx.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.missionId, mission.id), eq(schema.missionAttempts.runtime, runtimeScope())));
  const own = attempts.filter(a => a.taskId === task.id && a.planRevision === mission.planRevision && a.mandateRevision === mission.mandateRevision).sort((a, b) => b.attemptNo - a.attemptNo);
  const origin = own[0];
  if (!origin || !terminal.has(origin.status) || origin.cancelRequestedAt || own.some(a => !terminal.has(a.status))) return null;
  if (own.length >= currentMandate(mission).limits.maxOperationAttempts) return null;
  const [job] = await tx.select().from(schema.browserJobs).where(and(eq(schema.browserJobs.id, origin.dispatchId), eq(schema.browserJobs.runtime, runtimeScope()), eq(schema.browserJobs.threadId, mission.threadId)));
  if (!job || !terminal.has(job.status)) return null;
  // A terminal logical attempt alone never proves that the physical executor
  // stopped. Human or uncertain claims prevent new work, even after expiry.
  if ((await tx.select({ id: schema.missionResourceClaims.id }).from(schema.missionResourceClaims).where(inArray(schema.missionResourceClaims.attemptId, own.map(a => a.id)))).length) return null;
  if (!mission.config.target || !sameTarget(task.spec.target, mission.config.target) || !task.spec.planVersions?.length) return null;
  const currentAttempts = attempts.filter(a => a.planRevision === mission.planRevision);
  const runs = await tx.select().from(schema.testRuns).where(and(eq(schema.testRuns.workspaceId, mission.workspaceId), eq(schema.testRuns.runtime, runtimeScope()), inArray(schema.testRuns.missionAttemptId, currentAttempts.map(a => a.id))));
  const keys = task.spec.caseKeys.filter(key => mission.config.caseKeys.includes(key) && !runs.some(run => `${run.itemId}:${run.caseId}` === key));
  if (!keys.length) return null;
  const plans = await tx.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.workspaceId, mission.workspaceId), inArray(schema.workspaceItems.id, task.spec.planVersions.map(plan => plan.itemId))));
  const spec = task.spec;
  if (keys.some(key => { const [itemId, caseId] = key.split(':'), plan = plans.find(p => p.id === itemId);
    return !plan || plan.deletedAt || plan.version !== spec.planVersions!.find(p => p.itemId === itemId)?.version || plan.content.kind !== 'test_plan' || !plan.content.cases.some(c => c.id === caseId); })) return null;
  const others = await tx.select().from(schema.missionTasks).where(and(eq(schema.missionTasks.missionId, mission.id), eq(schema.missionTasks.planRevision, mission.planRevision!)));
  if (others.some(other => other.id !== task.id && other.spec?.kind === 'browser_tests' && other.spec.caseKeys.some(key => keys.includes(key)))) return null;
  await recoveryClock(tx, mission);
  const next = await addMissionTask(tx, mission, { operationId, title: 'Fortsätt med ostartade testfall', criterionIds: task.criterionIds,
    spec: { ...spec, caseKeys: keys, planVersions: spec.planVersions!.filter(plan => keys.some(key => key.startsWith(`${plan.itemId}:`))) } });
  await recordMissionEvent(tx, mission, 'browser_remainder_planned', { version: 1, sourceTaskId: task.id, sourceAttemptId: origin.id, taskId: next.id,
    planRevision: mission.planRevision, mandateRevision: mission.mandateRevision, sourceSpecHash: missionHash(task.spec), caseKeys: keys }, operationId);
  await recoveryClock(tx, mission);
  return next;
}

async function recoveryClock(tx: WorkspaceDatabase, mission: ControlledMission) {
  const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`), now = new Date(clock!.now);
  if (!mission.leaseUntil || mission.leaseUntil <= now || !mission.deadlineAt || mission.deadlineAt <= now) throw createError({ statusCode: 409, statusMessage: 'Fortsättningens tidsgräns har passerat.' });
}

/** Recheck server-issued recovery immediately before physical dispatch. A new
 * operation ID must not reset the original operation's bounded retry allowance.
 */
export async function validateUnstartedBrowserRecovery(tx: WorkspaceDatabase, mission: ControlledMission, task: Task, attemptId: string) {
  if (!task.operationId?.startsWith(remainderPrefix)) return;
  const denied = () => createError({ statusCode: 409, statusMessage: 'De återstående testfallen saknar ett aktuellt återhämtningsmandat.' });
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${mission.workspaceId}`}, 0))`);
  const [event] = await tx.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, task.operationId)));
  const binding = event?.payload;
  if (!binding || binding.version !== 1 || binding.taskId !== task.id || binding.planRevision !== mission.planRevision || binding.mandateRevision !== mission.mandateRevision
    || typeof binding.sourceTaskId !== 'string' || typeof binding.sourceAttemptId !== 'string' || task.operationId !== `${remainderPrefix}${binding.sourceTaskId}` || task.spec?.kind !== 'browser_tests'
    || mission.intent === 'report_only' || missionHash(binding.caseKeys) !== missionHash(task.spec.caseKeys)) throw denied();
  const recoverySpec = task.spec;
  if (await blockedBrowserReturnLineage(tx, mission, task)) throw denied();
  const [source] = await tx.select().from(schema.missionTasks).where(and(eq(schema.missionTasks.id, binding.sourceTaskId), eq(schema.missionTasks.missionId, mission.id)));
  const attempts = await tx.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.missionId, mission.id), eq(schema.missionAttempts.runtime, runtimeScope())));
  const origin = attempts.find(a => a.id === binding.sourceAttemptId);
  if (!source || source.spec?.kind !== 'browser_tests' || source.spec.complement || source.planRevision !== mission.planRevision || missionHash(source.spec) !== binding.sourceSpecHash
    || !origin || origin.taskId !== source.id || !terminal.has(origin.status) || origin.cancelRequestedAt || origin.planRevision !== mission.planRevision || origin.mandateRevision !== mission.mandateRevision
    || !sameTarget(source.spec.target, recoverySpec.target)) throw denied();
  const sourceSpec = source.spec;
  if (recoverySpec.caseKeys.some(key => !sourceSpec.caseKeys.includes(key))) throw denied();
  if (missionHash(recoverySpec) !== missionHash({ ...sourceSpec, caseKeys: recoverySpec.caseKeys,
    planVersions: sourceSpec.planVersions?.filter(plan => recoverySpec.caseKeys.some(key => key.startsWith(`${plan.itemId}:`))) })) throw denied();
  const family = attempts.filter(a => a.taskId === source.id || a.taskId === task.id);
  if (family.filter(a => a.id !== attemptId).length >= currentMandate(mission).limits.maxOperationAttempts) throw denied();
  const oldIds = family.filter(a => a.id !== attemptId).map(a => a.id);
  if ((await tx.select({ id: schema.missionResourceClaims.id }).from(schema.missionResourceClaims).where(inArray(schema.missionResourceClaims.attemptId, oldIds))).length) throw denied();
  const [job] = await tx.select().from(schema.browserJobs).where(and(eq(schema.browserJobs.id, origin.dispatchId), eq(schema.browserJobs.runtime, runtimeScope()), eq(schema.browserJobs.threadId, mission.threadId)));
  if (!job || !terminal.has(job.status)) throw denied();
  const others = attempts.filter(a => a.id !== attemptId && a.planRevision === mission.planRevision);
  const runs = await tx.select().from(schema.testRuns).where(and(eq(schema.testRuns.workspaceId, mission.workspaceId), eq(schema.testRuns.runtime, runtimeScope()), inArray(schema.testRuns.missionAttemptId, others.map(a => a.id))));
  if (runs.some(run => recoverySpec.caseKeys.includes(`${run.itemId}:${run.caseId}`))) throw denied();
  await recoveryClock(tx, mission);
}

/** Caller owns mission -> content locks. Nothing inferred from prose is an
 * execution plan: the existing unchanged case, target and scope are reused.
 */
async function complementBasis(tx: WorkspaceDatabase, mission: ControlledMission, runId: string) {
  const [run] = await tx.select().from(schema.testRuns).where(and(eq(schema.testRuns.id, runId), eq(schema.testRuns.workspaceId, mission.workspaceId), eq(schema.testRuns.runtime, runtimeScope())));
  if (!run?.missionAttemptId || !run.finishedAt || run.snapshot.type !== 'browser' || run.result?.schemaVersion !== 2 || !run.target || !mission.config.target || !sameTarget(run.target, mission.config.target)) return null;
  const [attempt] = await tx.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.id, run.missionAttemptId), eq(schema.missionAttempts.missionId, mission.id), eq(schema.missionAttempts.runtime, runtimeScope())));
  if (!attempt || !terminal.has(attempt.status) || attempt.cancelRequestedAt || attempt.planRevision !== mission.planRevision || attempt.mandateRevision !== mission.mandateRevision) return null;
  const [task] = await tx.select().from(schema.missionTasks).where(and(eq(schema.missionTasks.id, attempt.taskId), eq(schema.missionTasks.missionId, mission.id)));
  const caseKey = `${run.itemId}:${run.caseId}`;
  if (task?.spec?.kind !== 'browser_tests' || task.planRevision !== mission.planRevision || !task.spec.caseKeys.includes(caseKey) || !mission.config.caseKeys.includes(caseKey)
    || !task.spec.planVersions?.some(plan => plan.itemId === run.itemId && plan.version === run.planVersion)) return null;
  if (await blockedBrowserReturnLineage(tx, mission, task)) return null;
  const [plan] = await tx.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.id, run.itemId), eq(schema.workspaceItems.workspaceId, mission.workspaceId)));
  const currentCase = plan?.content.kind === 'test_plan' && plan.content.cases.find(testCase => testCase.id === run.caseId);
  if (!plan || plan.deletedAt || plan.version !== run.planVersion || !currentCase || missionHash(currentCase) !== missionHash(run.snapshot)) return null;
  const review = await readCurrentRunAssessment(mission.workspaceId, run.id, tx);
  if (!review || review.status !== 'completed' || !review.assessment || review.inputHash !== hashReview(review.input)) return null;
  // Legacy read compatibility is not enough to authorize a new executor.
  const parsed = currentAssessmentSchema.safeParse(review.assessment);
  if (!parsed.success) return null;
  try { validateAssessment(review.input, parsed.data); } catch { return null; }
  const gaps = reviewGaps(review);
  const bindings = gaps.map(gap => ({ ...gap, id: missionHash({ planRevision: mission.planRevision, caseKey, checkId: gap.requirementId, kind: gap.kind }) }));
  return { run, attempt, task, caseKey, review, gaps: bindings };
}

/** Deterministic reconciliation after a completed review. The persisted event
 * and task commit together, so repeated callbacks/restarts cannot add rounds.
 * Non-browser gaps remain explicit report limitations; they do not authorize
 * a different test, a changed requirement or unlimited model re-reviews.
 */
export async function proposeMissionComplements(tx: WorkspaceDatabase, mission: ControlledMission, reviewTask: Task) {
  if (mission.intent === 'report_only' || !['accepted', 'running', 'waiting'].includes(mission.lifecycle!) || mission.phase === 'report'
    || reviewTask.missionId !== mission.id || reviewTask.spec?.kind !== 'review' || reviewTask.state !== 'completed' || reviewTask.planRevision !== mission.planRevision) return [];
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${mission.workspaceId}`}, 0))`);
  const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
  if (!mission.deadlineAt || mission.deadlineAt <= new Date(clock!.now)) return [];
  if (!mission.leaseToken || !mission.leaseUntil || mission.leaseUntil <= new Date(clock!.now)) throw createError({ statusCode: 409, statusMessage: 'Kompletteringen saknar en aktuell controllerlease.' });
  const mandate = currentMandate(mission), created: Task[] = [];
  for (const runId of reviewTask.spec.runIds) {
    const basis = await complementBasis(tx, mission, runId);
    if (!basis) continue;
    const { run, attempt, task, caseKey, review, gaps } = basis;
    const eventKey = `complement-considered:${review.id}:${review.inputHash}`;
    if ((await tx.select({ id: schema.missionEvents.id }).from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, eventKey)))).length) continue;
    const browserGaps = gaps.filter(gap => gap.capability === 'browser');
    const tasks = await tx.select().from(schema.missionTasks).where(eq(schema.missionTasks.missionId, mission.id));
    const round = nextComplementRound({ planRevision: mission.planRevision!, caseKey, maxRounds: mandate.limits.maxSupplementRounds, tasks });
    let reason = !gaps.length ? 'no_actionable_gap' : !browserGaps.length ? 'non_browser_gap' : run.result!.outcome === 'blocked' ? 'prerequisite_blocked' : round === null ? 'round_limit' : null;
    // A newer committed task for this case is authoritative. An older review
    // cannot insert an alternative branch or consume another round.
    if (!reason && tasks.some(other => other.id !== task.id && other.planRevision === mission.planRevision && other.spec?.kind === 'browser_tests'
      && other.spec.caseKeys.includes(caseKey) && (other.supplementRound ?? 0) > (task.supplementRound ?? 0))) reason = 'newer_case_task';
    if (!reason && (!mandate.allowedTaskKinds.includes('browser_tests') || !mandate.allowedOrigins.includes(new URL(run.target!.url).origin))) reason = 'not_authorized';
    let next: Task | undefined;
    if (!reason && round !== null) {
      const complement = missionComplementSchema.parse({ version: 1, sourceTaskId: task.id, sourceAttemptId: attempt.id, runId,
        assessmentId: review.id, sourceHash: review.sourceHash, inputHash: review.inputHash, reviewerVersion: review.reviewerVersion,
        planRevision: mission.planRevision, caseKey, gapIds: browserGaps.map(gap => gap.id).sort() });
      next = await addMissionTask(tx, mission, { operationId: `complement:${mission.planRevision}:${caseKey}:${round}`, title: `Komplettera underlag: ${run.snapshot.title}`.slice(0, 300),
        criterionIds: task.criterionIds, dependsOn: [reviewTask.id], supplementRound: round,
        spec: { kind: 'browser_tests', caseKeys: [caseKey], target: run.target!, planVersions: [{ itemId: run.itemId, version: run.planVersion }], complement } });
      created.push(next);
    }
    await recordMissionEvent(tx, mission, next ? 'complement_planned' : 'complement_not_started', {
      runId, assessmentId: review.id, caseKey, round, reason, taskId: next?.id ?? null,
      gapIds: gaps.map(gap => gap.id), gapKinds: [...new Set(gaps.map(gap => gap.kind))],
    }, eventKey);
  }
  const [finished] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
  if (mission.leaseUntil <= new Date(finished!.now) || mission.deadlineAt <= new Date(finished!.now)) throw createError({ statusCode: 409, statusMessage: 'Kompletteringens tidsgräns passerade före commit.' });
  return created;
}

/** Recheck the exact evidence and lineage immediately before admitting work.
 * Caller owns mission lock; this takes the content lock in the same order.
 */
export async function validateMissionComplement(tx: WorkspaceDatabase, mission: ControlledMission, task: Task) {
  if (task.spec?.kind !== 'browser_tests') return;
  const denied = () => createError({ statusCode: 409, statusMessage: 'Kompletteringens underlag, plan eller mandat gäller inte längre.', data: { code: 'complement_stale' } });
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${mission.workspaceId}`}, 0))`);
  // This boundary is shared by reservation, physical dispatch and browser/run
  // admission. A saved descendant cannot bypass a later invalidated return.
  if (await blockedBrowserReturnLineage(tx, mission, task)) throw denied();
  if (!task.spec.complement) return;
  const binding: MissionComplement = missionComplementSchema.parse(task.spec.complement);
  if (mission.intent === 'report_only' || task.planRevision !== mission.planRevision || binding.planRevision !== mission.planRevision
    || task.spec.caseKeys.length !== 1 || task.spec.caseKeys[0] !== binding.caseKey || !task.supplementRound || task.supplementRound > currentMandate(mission).limits.maxSupplementRounds) throw denied();
  const basis = await complementBasis(tx, mission, binding.runId);
  if (!basis || basis.run.result!.outcome === 'blocked' || basis.task.id !== binding.sourceTaskId || basis.attempt.id !== binding.sourceAttemptId
    || basis.review.id !== binding.assessmentId || basis.review.sourceHash !== binding.sourceHash || basis.review.inputHash !== binding.inputHash
    || basis.review.reviewerVersion !== binding.reviewerVersion || basis.caseKey !== binding.caseKey || !sameTarget(task.spec.target, basis.run.target!)) throw denied();
  if (task.spec.planVersions?.length !== 1 || task.spec.planVersions[0]!.itemId !== basis.run.itemId || task.spec.planVersions[0]!.version !== basis.run.planVersion) throw denied();
  const wanted = basis.gaps.filter(gap => gap.capability === 'browser').map(gap => gap.id).sort();
  if (!wanted.length || missionHash(wanted) !== missionHash(binding.gapIds)) throw denied();
  const tasks = await tx.select().from(schema.missionTasks).where(eq(schema.missionTasks.missionId, mission.id));
  const expectedRound = nextComplementRound({ planRevision: mission.planRevision!, caseKey: binding.caseKey, maxRounds: currentMandate(mission).limits.maxSupplementRounds,
    tasks: tasks.filter(other => other.id !== task.id) });
  if (expectedRound !== task.supplementRound) throw denied();
}
