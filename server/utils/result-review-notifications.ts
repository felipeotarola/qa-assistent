import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@nuxthub/db';
import { resultAssessments as jobs } from '../db/schema/result-assessments';
import { testRuns } from '../db/schema/test-runs';
import { browserJobs } from '../db/schema/browser-jobs';
import { runtimeScope } from '../../shared/runtime-scope';
import { getThreadForUser } from './threads';
import { appOrigin, internalHeaders } from '../../agent/lib/internal-api';
import { buildReviewInput, hashReview } from './result-assessments';

export async function notifyReviewedResults() {
  const autonomous = sql`exists (select 1 from ${testRuns} where ${testRuns.id} = ${jobs.runId} and ${testRuns.missionAttemptId} is not null)`;
  // The controller consumes these saved assessments. Older pending rows also
  // become UI-only receipts; they must never enqueue an unrelated turn in V.
  await db.update(jobs).set({ notification: 'recorded' }).where(and(eq(jobs.runtime, runtimeScope()), eq(jobs.notification, 'pending'), autonomous));
  const pending = await db.select().from(jobs).where(and(eq(jobs.runtime, runtimeScope()), eq(jobs.notification, 'pending'), sql`not (${autonomous})`, sql`${jobs.status} in ('completed','failed') and ${jobs.finishedAt} < now() - interval '60 seconds'`)).limit(20);
  for (const threadId of [...new Set(pending.map(j => j.threadId))].slice(0, 1)) {
    const batch = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`review-notify:${runtimeScope()}:${threadId}`}, 0))`);
      const scope = and(eq(jobs.runtime, runtimeScope()), eq(jobs.threadId, threadId), eq(jobs.notification, 'pending'), sql`not (${autonomous})`);
      const rows = await tx.select().from(jobs).where(scope);
      if (!rows.length || rows.some(j => !j.finishedAt || Date.now() - j.finishedAt.getTime() < 60000)) return [];
      const activeRuns = await tx.select({ id: testRuns.id }).from(testRuns).where(and(eq(testRuns.threadId, threadId), sql`${testRuns.finishedAt} is null`)).limit(1);
      const activeBrowser = await tx.select({ id: browserJobs.id }).from(browserJobs).where(and(eq(browserJobs.threadId, threadId), eq(browserJobs.runtime, runtimeScope()), sql`${browserJobs.status} in ('starting','running','dispatch_unknown')`)).limit(1);
      if (activeRuns.length || activeBrowser.length) return [];
      // At-most-once notification claim: an uncertain network write is never replayed.
      const batch = rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, 20);
      await tx.update(jobs).set({ notification: 'sending' }).where(inArray(jobs.id, batch.map(j => j.id)));
      return batch;
    });
    if (!batch.length) continue;
    const ids = batch.map(j => j.id);
    try {
      const thread = await getThreadForUser(batch[0]!.userId, threadId);
      if (!thread?.sessionId || thread.workspaceId !== batch[0]!.workspaceId) throw new Error('No current parent session');
      const latest = [...new Map(batch.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(j => [j.runId, j])).values()];
      const report = await Promise.all(latest.map(async j => {
        let stale = true;
        try { stale = hashReview(await buildReviewInput(j.workspaceId, j.runId)) !== j.sourceHash; } catch { /* Missing source is stale. */ }
        return { runId: j.runId, status: j.status, verdict: stale ? undefined : j.assessment?.verdict, summary: stale ? 'Underlaget har ändrats. Bedömningen är inaktuell och behöver göras om.' : j.assessment?.summary ?? j.error };
      }));
      const response = await fetch(`${appOrigin()}/workers/result-review/notify`, { method: 'POST', headers: internalHeaders(), signal: AbortSignal.timeout(30000), body: JSON.stringify({ parentSessionId: thread.sessionId, threadId, userId: batch[0]!.userId, report }) });
      if (!response.ok) throw new Error('Notification unconfirmed');
      await db.update(jobs).set({ notification: 'sent' }).where(inArray(jobs.id, ids));
    } catch { await db.update(jobs).set({ notification: 'unconfirmed' }).where(inArray(jobs.id, ids)); }
  }
}
