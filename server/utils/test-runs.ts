import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, desc, sql } from 'drizzle-orm';
import { db } from '@nuxthub/db';
import { testRuns } from '../db/schema/test-runs';
import { ownedItem, requireWorkspace } from './workspaces';
import { testRunActionSchema } from '../../shared/test-run';

export async function listTestRuns(userId: string, workspaceId: string, itemId?: string) {
  await requireWorkspace(userId, workspaceId);
  return db.select().from(testRuns).where(and(eq(testRuns.workspaceId, workspaceId), itemId ? eq(testRuns.itemId, itemId) : undefined)).orderBy(desc(testRuns.startedAt));
}
export async function testRunAction(userId: string, workspaceId: string, threadId: string, input: unknown) {
  const parsed = testRunActionSchema.safeParse(input);
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500) });
  const action = parsed.data;
  await requireWorkspace(userId, workspaceId);
  if (action.action === 'list') return listTestRuns(userId, workspaceId, action.itemId);
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspaceId}`}, 0))`);
    const key = action.action === 'start' ? action.requestId : action.runId;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`test-run:${workspaceId}:${key}`}))`);
    if (action.action === 'start') {
      const [existing] = await tx.select().from(testRuns).where(and(eq(testRuns.workspaceId, workspaceId), eq(testRuns.requestId, action.requestId)));
      if (existing) {
        if (existing.itemId !== action.itemId || existing.caseId !== action.caseId || existing.planVersion !== action.expectedVersion || existing.environment !== action.environment) throw createError({ statusCode: 409, statusMessage: 'Request ID already used for another run' });
        return existing;
      }
      const item = await ownedItem(userId, workspaceId, action.itemId);
      if (item.version !== action.expectedVersion) throw createError({ statusCode: 409, statusMessage: 'Read the current plan before starting' });
      const snapshot = item.content.kind === 'test_plan' && item.content.cases.find(c => c.id === action.caseId);
      if (!snapshot) throw createError({ statusCode: 404, statusMessage: 'Test case not found' });
      const [run] = await tx.insert(testRuns).values({ id: randomUUID(), workspaceId, itemId: item.id, caseId: snapshot.id, planVersion: item.version, snapshot, environment: action.environment, requestId: action.requestId, threadId }).returning();
      return run;
    }
    const [run] = await tx.select().from(testRuns).where(and(eq(testRuns.workspaceId, workspaceId), eq(testRuns.id, action.runId)));
    if (!run) throw createError({ statusCode: 404, statusMessage: 'Run not found' });
    if (run.result) {
      if (isDeepStrictEqual(run.result, action.result)) return run;
      throw createError({ statusCode: 409, statusMessage: 'Final results are immutable. Start a new run.' });
    }
    for (const id of action.result.evidenceItemIds) {
      const evidence = await ownedItem(userId, workspaceId, id);
      if (evidence.content.kind !== 'image' && evidence.content.kind !== 'file') throw createError({ statusCode: 400, statusMessage: 'Evidence must be a saved image or file' });
    }
    const [saved] = await tx.update(testRuns).set({ result: action.result, finishedAt: new Date() }).where(eq(testRuns.id, run.id)).returning();
    return saved;
  });
}
