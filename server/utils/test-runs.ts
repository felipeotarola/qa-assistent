import { randomUUID } from 'node:crypto';
import { runtimeScope } from '../../shared/runtime-scope';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, desc, sql, inArray } from 'drizzle-orm';
import { db } from '@nuxthub/db';
import { testRuns } from '../db/schema/test-runs';
import { ownedItem, requireWorkspace } from './workspaces';
import { testRunActionSchema, runChecks, runVerificationError } from '../../shared/test-run';
import { testRunReviews } from '../db/schema/test-requirements';
import { runReviewSchema } from '../../shared/test-requirement';
import { autoReviewEnabled, enqueueReview, listAssessments, requestReview } from './result-assessments';
import { testCaptures } from '../db/schema/test-captures';

export async function listTestRuns(userId: string, workspaceId: string, itemId?: string) {
  await requireWorkspace(userId, workspaceId);
  const runs = await db.select().from(testRuns).where(and(eq(testRuns.workspaceId, workspaceId), itemId ? eq(testRuns.itemId, itemId) : undefined)).orderBy(desc(testRuns.startedAt));
  const reviews = runs.length ? await db.select().from(testRunReviews).where(inArray(testRunReviews.runId, runs.map(r => r.id))).orderBy(desc(testRunReviews.createdAt)) : [];
  const captures = runs.length ? await db.select().from(testCaptures).where(inArray(testCaptures.runId, runs.map(r => r.id))).orderBy(testCaptures.createdAt) : [];
  const assessments = await listAssessments(userId, workspaceId);
  return runs.map(run => ({ ...run, assessments: assessments.filter(a => a.runId === run.id), reviews: reviews.filter(review => review.runId === run.id), captures: captures.filter(c => c.runId === run.id) }));
}
export async function reviewTestRun(userId: string, workspaceId: string, input: unknown) {
  const parsed = runReviewSchema.safeParse(input);
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Välj bedömning och skriv en motivering (minst 10 tecken).' });
  const value = parsed.data;
  await requireWorkspace(userId, workspaceId);
  return db.transaction(async tx => {
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
export async function testRunAction(userId: string, workspaceId: string, threadId: string, input: unknown) {
  const parsed = testRunActionSchema.safeParse(input);
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500) });
  const action = parsed.data;
  await requireWorkspace(userId, workspaceId);
  if (action.action === 'list') return listTestRuns(userId, workspaceId, action.itemId);
  if (action.action === 'assess') {
    await requestReview(userId, workspaceId, action.runId);
    return { runId: action.runId, assessments: await listAssessments(userId, workspaceId, action.runId), note: 'Granskning beställd. Inga tester startas och originalresultatet ändras inte. Bekräfta bara en bedömning som faktiskt är klar.' };
  }
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspaceId}`}, 0))`);
    const key = action.action === 'start' ? action.requestId : action.runId;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`test-run:${workspaceId}:${key}`}))`);
    if (action.action === 'start') {
      const [existing] = await tx.select().from(testRuns).where(and(eq(testRuns.workspaceId, workspaceId), eq(testRuns.requestId, action.requestId)));
      if (existing) {
        if (existing.itemId !== action.itemId || existing.caseId !== action.caseId || existing.planVersion !== action.expectedVersion || existing.environment !== action.environment || !isDeepStrictEqual(existing.target ?? null, action.target ?? null)) throw createError({ statusCode: 409, statusMessage: 'Request ID already used for another run' });
        return { ...existing, checks: runChecks(existing.snapshot) };
      }
      const item = await ownedItem(userId, workspaceId, action.itemId, tx);
      if (item.version !== action.expectedVersion) throw createError({ statusCode: 409, statusMessage: 'Read the current plan before starting' });
      const snapshot = item.content.kind === 'test_plan' && item.content.cases.find(c => c.id === action.caseId);
      if (!snapshot) throw createError({ statusCode: 404, statusMessage: 'Test case not found' });
      const [run] = await tx.insert(testRuns).values({ id: randomUUID(), runtime: runtimeScope(), workspaceId, itemId: item.id, caseId: snapshot.id, planVersion: item.version, snapshot, environment: action.environment, target: action.target ?? null, requestId: action.requestId, threadId }).returning();
      if (!run) throw createError({ statusCode: 500, statusMessage: 'Run could not be created' });
      return { ...run, checks: runChecks(run.snapshot) };
    }
    const [run] = await tx.select().from(testRuns).where(and(eq(testRuns.workspaceId, workspaceId), eq(testRuns.id, action.runId)));
    if (!run) throw createError({ statusCode: 404, statusMessage: 'Run not found' });
    if (run.result) {
      if (isDeepStrictEqual(run.result, action.result)) {
        if (autoReviewEnabled(workspaceId)) await enqueueReview(tx, userId, workspaceId, run.id, run.threadId);
        return run;
      }
      throw createError({ statusCode: 409, statusMessage: 'Final results are immutable. Start a new run.' });
    }
    const verificationError = runVerificationError(run.snapshot, action.result);
    if (verificationError) throw createError({ statusCode: 400, statusMessage: verificationError });
    for (const id of action.result.evidenceItemIds) {
      const evidence = await ownedItem(userId, workspaceId, id, tx);
      if (evidence.content.kind !== 'image' && evidence.content.kind !== 'file') throw createError({ statusCode: 400, statusMessage: 'Evidence must be a saved image or file' });
    }
    const [saved] = await tx.update(testRuns).set({ result: action.result, finishedAt: new Date() }).where(eq(testRuns.id, run.id)).returning();
    if (autoReviewEnabled(workspaceId)) await enqueueReview(tx, userId, workspaceId, run.id, threadId);
    return saved;
  });
}
