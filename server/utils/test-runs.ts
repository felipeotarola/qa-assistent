import { randomUUID } from 'node:crypto';
import { browserAttemptCases } from './mission-browser-return';
import { testRunReportSource } from '../../shared/report-selection';
import { runtimeScope } from '../../shared/runtime-scope';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, desc, sql, inArray, isNull, or } from 'drizzle-orm';
import { db } from '@nuxthub/db';
import { testRuns } from '../db/schema/test-runs';
import { ownedItem, requireWorkspace, type WorkspaceDatabase } from './workspaces';
import { testRunActionSchema, runChecks, runVerificationError, runResultV2Schema } from '../../shared/test-run';
import { testRunReviews } from '../db/schema/test-requirements';
import { runReviewSchema } from '../../shared/test-requirement';
import { autoReviewEnabled, enqueueReview, listAssessments, requestReview } from './result-assessments';
import { testCaptures } from '../db/schema/test-captures';
import { missions, missionTasks, missionAttempts } from '../db/schema/missions';
import { sameTarget } from '../../shared/test-target';
import { lockMission, recordMissionEvent } from './mission-control';
import { validateMissionComplement } from './mission-complements';
import { browserJobs } from '../db/schema/browser-jobs';

/** Set by an authenticated executor adapter, never by model-controlled input. */
export type TestRunExecution = { attemptId: string; dispatchId: string };

/** A terminal executor receipt is not a test verdict. Close only the exact
 * executor's unfinished records, preserving all original checks as unverified.
 * Unknown/cancelling jobs and existing immutable results remain untouched.
 * This is controller reconciliation, never a read endpoint or model action. */
export async function reconcileTerminalBrowserRuns(userId: string, workspaceId: string, threadId: string, execution: TestRunExecution) {
  return db.transaction(async tx => {
    const [initial] = await tx.select({ missionId: missionAttempts.missionId }).from(missionAttempts)
      .where(and(eq(missionAttempts.id, execution.attemptId), eq(missionAttempts.dispatchId, execution.dispatchId), eq(missionAttempts.runtime, runtimeScope())));
    if (!initial) throw createError({ statusCode: 409, statusMessage: 'Testets ursprungliga körförsök krävs.' });
    await lockMission(tx, initial.missionId);
    await requireWorkspace(userId, workspaceId, tx);
    const [bound] = await tx.select({ attempt: missionAttempts, mission: missions, task: missionTasks, job: browserJobs }).from(missionAttempts)
      .innerJoin(missions, eq(missions.id, missionAttempts.missionId))
      .innerJoin(missionTasks, and(eq(missionTasks.id, missionAttempts.taskId), eq(missionTasks.missionId, missions.id)))
      .innerJoin(browserJobs, eq(browserJobs.id, missionAttempts.dispatchId))
      .where(and(eq(missionAttempts.id, execution.attemptId), eq(missionAttempts.dispatchId, execution.dispatchId), eq(missionAttempts.runtime, runtimeScope()),
        eq(missions.runtime, runtimeScope()), eq(missions.userId, userId), eq(missions.workspaceId, workspaceId), eq(missions.threadId, threadId),
        eq(missions.controllerVersion, 1), eq(browserJobs.runtime, runtimeScope()), eq(browserJobs.threadId, threadId)));
    if (!bound || bound.attempt.kind !== 'browser_tests' || bound.task.spec?.kind !== 'browser_tests' || bound.task.planRevision !== bound.attempt.planRevision) {
      throw createError({ statusCode: 409, statusMessage: 'Testets terminala utförare tillhör inte samma uppdrag.' });
    }
    if (!bound.job.sessionId || !['completed', 'failed', 'cancelled'].includes(bound.job.status)) return [];
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspaceId}`}, 0))`);
    const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
    if (bound.job.updatedAt > new Date(clock!.now)) throw createError({ statusCode: 409, statusMessage: 'Utförarens sluttid är ogiltig.' });
    const open = await tx.select().from(testRuns).where(and(eq(testRuns.missionAttemptId, bound.attempt.id), eq(testRuns.workspaceId, workspaceId),
      eq(testRuns.threadId, threadId), eq(testRuns.runtime, runtimeScope()), isNull(testRuns.result), isNull(testRuns.finishedAt)));
    const savedIds: string[] = [];
    for (const run of open) {
      if (run.startedAt > bound.job.updatedAt) throw createError({ statusCode: 409, statusMessage: 'Testet startades efter utförarens slutkvittens.' });
      const reason = 'Utföraren har avslutats utan att lämna testets slutresultat. Kontrollpunkten saknar avslutande verifiering; sparat underlag finns kvar.';
      const checks = runChecks(run.snapshot);
      const result = runResultV2Schema.parse({ schemaVersion: 2, outcome: 'interrupted',
        actual: 'Systemets avbrottskvittens: Iris körning är avslutad, men testets slutresultat saknas. Detta är inget godkännande eller konstaterat produktfel.',
        observations: [], evidenceItemIds: [], checks: checks.map(c => ({ id: c.id, status: 'unverified', actual: reason })),
        remaining: checks.map(c => ({ checkId: c.id, reason })) });
      await tx.update(testRuns).set({ result, finishedAt: bound.job.updatedAt }).where(and(eq(testRuns.id, run.id), isNull(testRuns.result), isNull(testRuns.finishedAt)));
      await recordMissionEvent(tx, bound.mission, 'test_run_interrupted', { runId: run.id, attemptId: bound.attempt.id, jobId: bound.job.id,
        executorStatus: bound.job.status, executorReceiptAt: bound.job.updatedAt.toISOString(), source: 'controller-terminal-receipt' }, `test-run-interrupted:${run.id}`);
      savedIds.push(run.id);
    }
    return savedIds;
  });
}
function publicRun(run: typeof testRuns.$inferSelect) {
  const { browserEntryReceipt, ...value } = run;
  void browserEntryReceipt;
  return value;
}
function startResponse(run: typeof testRuns.$inferSelect, executionCurrent?: boolean) {
  return { ...publicRun(run), checks: runChecks(run.snapshot), ...(executionCurrent !== undefined ? { executionCurrent } : {}),
    ...(run.missionAttemptId && run.snapshot.entryUrl && !run.browserEntryReceipt && !run.finishedAt && executionCurrent ? { nextAction: { action: 'open' as const, url: run.snapshot.entryUrl, runId: run.id } } : {}) };
}
async function executionContext(tx: WorkspaceDatabase, userId: string, workspaceId: string, execution: TestRunExecution) {
  const [value] = await tx.select({ attempt: missionAttempts, mission: missions, task: missionTasks }).from(missionAttempts)
    .innerJoin(missions, eq(missionAttempts.missionId, missions.id)).innerJoin(missionTasks, and(eq(missionAttempts.taskId, missionTasks.id), eq(missionTasks.missionId, missions.id)))
    .where(and(eq(missionAttempts.id, execution.attemptId), eq(missionAttempts.dispatchId, execution.dispatchId), eq(missionAttempts.runtime, runtimeScope()),
      eq(missions.runtime, runtimeScope()), eq(missions.userId, userId), eq(missions.workspaceId, workspaceId), eq(missions.controllerVersion, 1)));
  if (!value || value.attempt.kind !== 'browser_tests') throw createError({ statusCode: 409, statusMessage: 'Testets ursprungliga körförsök krävs.' });
  const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
  const now = new Date(clock!.now), { mission, task, attempt } = value;
  const current = mission.status === 'active' && ['accepted', 'running', 'waiting'].includes(mission.lifecycle!)
    && !!mission.deadlineAt && mission.deadlineAt > now && task.planRevision === mission.planRevision && task.state === 'running'
    && attempt.mandateRevision === mission.mandateRevision && attempt.planRevision === mission.planRevision
    && ['dispatching', 'dispatch_unknown', 'running'].includes(attempt.status) && !attempt.cancelRequestedAt && attempt.deadlineAt > now;
  return { ...value, current };
}

export async function listTestRuns(userId: string, workspaceId: string, itemId?: string) {
  await requireWorkspace(userId, workspaceId);
  // Match source resolution: explicit legacy history stays readable, while a
  // different runtime's rows cannot be offered as inputs to this controller.
  const runs = await db.select().from(testRuns).where(and(eq(testRuns.workspaceId, workspaceId),
    or(eq(testRuns.runtime, runtimeScope()), isNull(testRuns.runtime)), itemId ? eq(testRuns.itemId, itemId) : undefined)).orderBy(desc(testRuns.startedAt));
  const reviews = runs.length ? await db.select().from(testRunReviews).where(inArray(testRunReviews.runId, runs.map(r => r.id))).orderBy(desc(testRunReviews.createdAt)) : [];
  const captures = runs.length ? await db.select().from(testCaptures).where(inArray(testCaptures.runId, runs.map(r => r.id))).orderBy(testCaptures.createdAt) : [];
  const assessments = await listAssessments(userId, workspaceId);
  return runs.map(run => ({ ...publicRun(run), reportSource: testRunReportSource(run.id), assessments: assessments.filter(a => a.runId === run.id), reviews: reviews.filter(review => review.runId === run.id), captures: captures.filter(c => c.runId === run.id) }));
}
export async function reviewTestRun(userId: string, workspaceId: string, input: unknown) {
  const parsed = runReviewSchema.safeParse(input);
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Välj bedömning och skriv en motivering (minst 10 tecken).' });
  const value = parsed.data;
  await requireWorkspace(userId, workspaceId);
  return db.transaction(async tx => {
    // A manual reservation changes delivery eligibility. Serialize it with the
    // report's final coverage check just like plan and evidence edits.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspaceId}`}, 0))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`run-review:${value.runId}`}, 0))`);
    const [run] = await tx.select().from(testRuns).where(and(eq(testRuns.id, value.runId), eq(testRuns.workspaceId, workspaceId)));
    if (!run) throw createError({ statusCode: 404, statusMessage: 'Run not found' });
    if (!run.result) throw createError({ statusCode: 409, statusMessage: 'Körningen saknar slutresultat och kan inte godkännas.' });
    const [previous] = await tx.select().from(testRunReviews).where(and(eq(testRunReviews.runId, run.id), eq(testRunReviews.requestId, value.requestId)));
    if (previous) {
      if (previous.outcome !== value.outcome || previous.reason !== value.reason) throw createError({ statusCode: 409, statusMessage: 'Bedömningen har redan sparats med annat innehåll.' });
      return previous;
    }
    const [review] = await tx.insert(testRunReviews).values({ ...value, userId, id: randomUUID() }).returning();
    return review;
  });
}
export async function testRunAction(userId: string, workspaceId: string, threadId: string, input: unknown, options: { execution?: TestRunExecution; requireAutonomousStart?: boolean } = {}) {
  const parsed = testRunActionSchema.safeParse(input);
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500) });
  const action = parsed.data;
  await requireWorkspace(userId, workspaceId);
  if (action.action === 'list') return listTestRuns(userId, workspaceId, action.itemId);
  if (action.action === 'assess') {
    if (options.execution) throw createError({ statusCode: 409, statusMessage: 'Autonoma granskningar beställs av uppdragsstyrningen.' });
    await requestReview(userId, workspaceId, action.runId);
    return { runId: action.runId, assessments: await listAssessments(userId, workspaceId, action.runId), note: 'Granskning beställd. Inga tester startas och originalresultatet ändras inte. Bekräfta bara en bedömning som faktiskt är klar.' };
  }
  return db.transaction(async tx => {
    if (options.execution) {
      const [attempt] = await tx.select({ missionId: missionAttempts.missionId }).from(missionAttempts).where(and(eq(missionAttempts.id, options.execution.attemptId), eq(missionAttempts.runtime, runtimeScope())));
      if (!attempt) throw createError({ statusCode: 409 });
      await lockMission(tx, attempt.missionId);
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspaceId}`}, 0))`);
    const key = action.action === 'start' ? action.requestId : action.runId;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`test-run:${workspaceId}:${key}`}))`);
    if (action.action === 'start') {
      const execution = options.execution ? await executionContext(tx, userId, workspaceId, options.execution) : null;
      if (execution && (!action.mission || action.mission.missionId !== execution.mission.id || action.mission.taskId !== execution.task.id)) throw createError({ statusCode: 409, statusMessage: 'Testet måste använda utförarens uppdrag och deluppgift.' });
      const [existing] = await tx.select().from(testRuns).where(and(eq(testRuns.workspaceId, workspaceId), eq(testRuns.requestId, action.requestId)));
      if (existing) {
        if ((existing.missionAttemptId ?? null) !== (execution?.attempt.id ?? null)) throw createError({ statusCode: 409, statusMessage: 'Begäran tillhör ett annat körförsök.' });
        if (existing.itemId !== action.itemId || existing.caseId !== action.caseId || existing.planVersion !== action.expectedVersion || existing.environment !== action.environment || !isDeepStrictEqual(existing.target ?? null, action.target ?? null)) throw createError({ statusCode: 409, statusMessage: 'Request ID already used for another run' });
        if (options.requireAutonomousStart && !execution) {
          if (existing.threadId !== threadId || existing.runtime !== null && existing.runtime !== runtimeScope()) throw createError({ statusCode: 409, statusMessage: 'Begäran tillhör en annan tråd eller körmiljö.' });
          // A legacy replay only returns its accepted receipt. It may not attach
          // the old run to a new mission, even if a model supplies a binding.
          if (action.mission) {
            const [binding] = await tx.select({ id: missionTasks.id }).from(missionTasks).innerJoin(missions, eq(missions.id, missionTasks.missionId))
              .where(and(eq(missions.id, action.mission.missionId), eq(missionTasks.id, action.mission.taskId), eq(missions.workspaceId, workspaceId), eq(missions.userId, userId),
                eq(missions.runtime, runtimeScope()), sql`${missionTasks.sources} @> ${JSON.stringify([{ type: 'test', id: existing.id }])}::jsonb`));
            if (!binding) throw createError({ statusCode: 409, statusMessage: 'En tidigare testkörnings uppdragskoppling får inte ersättas.' });
          }
        }
        return startResponse(existing, execution?.current);
      }
      // Enforce new-start authority under the same request/content locks as
      // the immutable replay lookup. A deleted legacy receipt cannot race into a new run.
      if (options.requireAutonomousStart && !execution) throw createError({ statusCode: 409, statusMessage: 'Nya QA-testkörningar startas av uppdragets Iris-utförare. Använd qa_mission med användarens mål, target och valda caseKeys; använd LIST/FINISH för redan accepterade körningar.' });
      const [owner] = action.mission ? await tx.select().from(missions).where(and(eq(missions.id, action.mission.missionId), eq(missions.workspaceId, workspaceId), eq(missions.userId, userId), eq(missions.runtime, runtimeScope()))) : [];
      if (action.target?.scope && owner?.controllerVersion !== 1) throw createError({ statusCode: 409, statusMessage: 'Observationsscope måste komma från det egna uppdraget.' });
      if (owner?.controllerVersion === 1 && action.mission) {
        const task = execution?.task;
        if (!execution?.current || task?.spec?.kind !== 'browser_tests' || !task.spec.caseKeys.includes(`${action.itemId}:${action.caseId}`) || !owner.config.target || !action.target || !sameTarget(owner.config.target, action.target)) throw createError({ statusCode: 409, statusMessage: 'Testet måste tillhöra ett aktuellt körförsök och uppdragets testurval.' });
        if (task.spec.planVersions && !task.spec.planVersions.some(plan => plan.itemId === action.itemId && plan.version === action.expectedVersion)) throw createError({ statusCode: 409, statusMessage: 'Testplanens frysta version får inte ersättas inom samma uppgift.' });
        await validateMissionComplement(tx, owner, task);
        if (!(await browserAttemptCases(tx, execution.attempt, task)).includes(`${action.itemId}:${action.caseId}`)) throw createError({ statusCode: 409, statusMessage: 'Detta testfall ingår inte i den återlämnade sessionens återstående urval. Tidigare utfall får inte köras om.' });
      }
      const item = await ownedItem(userId, workspaceId, action.itemId, tx);
      if (item.version !== action.expectedVersion) throw createError({ statusCode: 409, statusMessage: 'Read the current plan before starting' });
      const snapshot = item.content.kind === 'test_plan' && item.content.cases.find(c => c.id === action.caseId);
      if (!snapshot) throw createError({ statusCode: 404, statusMessage: 'Test case not found' });
      if (execution && snapshot.type === 'browser') {
        const [unfinished] = await tx.select({ id: testRuns.id }).from(testRuns).where(and(eq(testRuns.missionAttemptId, execution.attempt.id), isNull(testRuns.finishedAt)));
        if (unfinished) throw createError({ statusCode: 409, statusMessage: `Avsluta testkörningen ${unfinished.id} innan nästa test startas. Testfallen delar webbläsarsession och körs ett i taget.` });
      }
      const [run] = await tx.insert(testRuns).values({ id: randomUUID(), runtime: runtimeScope(), missionAttemptId: execution?.attempt.id ?? null, workspaceId, itemId: item.id, caseId: snapshot.id, planVersion: item.version, snapshot, environment: action.environment, target: action.target ?? null, requestId: action.requestId, threadId }).returning();
      if (!run) throw createError({ statusCode: 500, statusMessage: 'Run could not be created' });
      return startResponse(run, execution ? true : undefined);
    }
    const [run] = await tx.select().from(testRuns).where(and(eq(testRuns.workspaceId, workspaceId), eq(testRuns.id, action.runId)));
    if (!run) throw createError({ statusCode: 404, statusMessage: 'Run not found' });
    const execution = options.execution ? await executionContext(tx, userId, workspaceId, options.execution) : null;
    if ((run.missionAttemptId ?? null) !== (execution?.attempt.id ?? null)) throw createError({ statusCode: 409, statusMessage: 'Endast testets ursprungliga utförare får lämna resultat.' });
    const eligible = !execution || execution.current;
    const response = (value: typeof run) => ({ ...publicRun(value), ...(execution ? { executionCurrent: execution.current } : {}) });
    if (run.result) {
      if (isDeepStrictEqual(run.result, action.result)) {
        if (eligible && !run.missionAttemptId && autoReviewEnabled(workspaceId)) await enqueueReview(tx, userId, workspaceId, run.id, run.threadId);
        return response(run);
      }
      throw createError({ statusCode: 409, statusMessage: 'Final results are immutable. Start a new run.' });
    }
    const verificationError = runVerificationError(run.snapshot, action.result);
    if (verificationError) throw createError({ statusCode: 400, statusMessage: verificationError });
    if (run.missionAttemptId && run.snapshot.entryUrl && !run.browserEntryReceipt && action.result.outcome === 'passed') throw createError({ statusCode: 400, statusMessage: 'Testets startadress har inte öppnats och observerats i dess webbläsarsession. Spara ofullständigt utförande som inconclusive eller blocked.' });
    for (const id of action.result.evidenceItemIds) {
      const evidence = await ownedItem(userId, workspaceId, id, tx);
      if (evidence.content.kind !== 'image' && evidence.content.kind !== 'file') throw createError({ statusCode: 400, statusMessage: 'Evidence must be a saved image or file' });
    }
    const [saved] = await tx.update(testRuns).set({ result: action.result, finishedAt: new Date() }).where(eq(testRuns.id, run.id)).returning();
    if (eligible && !run.missionAttemptId && autoReviewEnabled(workspaceId)) await enqueueReview(tx, userId, workspaceId, run.id, threadId);
    return response(saved!);
  });
}
