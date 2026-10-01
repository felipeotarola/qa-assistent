import { and, eq, desc, sql } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { getThreadForUser } from './threads';
import { runtimeScope } from '../../shared/runtime-scope';
import { appOrigin, internalHeaders } from '../../agent/lib/internal-api';
import { resolveChatModel, resolveReasoning } from '../../shared/chat-models';

export async function browserJobAction(userId: string, threadId: string, input: { action: 'start' | 'status' | 'cancel'; jobId: string; task?: string; parentSessionId?: string; model?: string; reasoning?: string }) {
  const thread = await getThreadForUser(userId, threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: 'Workspace not found' });
  const workspaceId = thread.workspaceId;
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`iris:${thread.workspaceId}:${runtimeScope()}`}, 0))`);
    let [job] = await tx.select().from(schema.browserJobs).where(and(eq(schema.browserJobs.id, input.jobId), eq(schema.browserJobs.threadId, threadId), eq(schema.browserJobs.runtime, runtimeScope())));
    if (input.action === 'start' && !job) {
      if (!input.task || !input.parentSessionId) throw createError({ statusCode: 400, statusMessage: 'Task and parent session required' });
      const active = await tx.select({ id: schema.browserJobs.id }).from(schema.browserJobs).innerJoin(schema.threads, eq(schema.browserJobs.threadId, schema.threads.id)).where(and(eq(schema.threads.workspaceId, workspaceId), eq(schema.browserJobs.runtime, runtimeScope()), sql`${schema.browserJobs.status} in ('starting','running','dispatch_unknown')`));
      if (active.length) throw createError({ statusCode: 409, statusMessage: 'Iris already has an active task in this workspace. Read its status before starting another.' });
      [job] = await tx.insert(schema.browserJobs).values({ id: input.jobId, threadId, runtime: runtimeScope(), parentSessionId: input.parentSessionId, task: input.task, model: resolveChatModel(input.model), reasoning: resolveReasoning(input.reasoning) }).returning();
    }
    if (!job) throw createError({ statusCode: 404, statusMessage: 'Job not found' });
    if (input.action === 'start' && input.task !== job.task) throw createError({ statusCode: 409, statusMessage: 'Job ID already used for another task' });
  });
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`iris-job:${input.jobId}`}, 0))`);
    let [job] = await tx.select().from(schema.browserJobs).where(and(eq(schema.browserJobs.id, input.jobId), eq(schema.browserJobs.threadId, threadId), eq(schema.browserJobs.runtime, runtimeScope())));
    if (!job) throw createError({ statusCode: 404, statusMessage: 'Job not found' });
    const active = ['starting', 'running', 'dispatch_unknown'].includes(job.status);
    if (active && ((input.action === 'start' && !job.sessionId) || input.action === 'cancel')) {
      await tx.update(schema.browserJobs).set({ status: input.action === 'cancel' ? 'cancelled' : 'running', updatedAt: new Date() }).where(eq(schema.browserJobs.id, job.id));
      try {
      const response = await fetch(`${appOrigin()}/eve/v1/workers/iris`, { method: 'POST', headers: internalHeaders(), signal: AbortSignal.timeout(30000), body: JSON.stringify({ action: input.action, jobId: job.id, task: job.task, userId, threadId, model: job.model, reasoning: job.reasoning }) });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error(`Iris dispatch returned HTTP ${response.status} without a confirmed receipt`);
      const result = await response.json() as { sessionId?: string };
      [job] = await tx.update(schema.browserJobs).set({ ...(result.sessionId ? { sessionId: result.sessionId } : {}), status: input.action === 'cancel' ? 'cancelled' : 'running', updatedAt: new Date() }).where(eq(schema.browserJobs.id, job.id)).returning();
      } catch (error) {
        console.warn('[iris] Dispatch outcome unknown', { jobId: input.jobId, action: input.action, error: error instanceof Error ? error.name : 'UnknownError' });
        [job] = await tx.update(schema.browserJobs).set({ status: 'dispatch_unknown', updatedAt: new Date() }).where(eq(schema.browserJobs.id, input.jobId)).returning();
      }
    }
    return { ...job!, name: 'Iris', background: true };
  });
}
export async function listBrowserJobs(userId: string, workspaceId: string) {
  const { requireWorkspace } = await import('./workspaces');
  await requireWorkspace(userId, workspaceId);
  return db.select({ id: schema.browserJobs.id, threadId: schema.browserJobs.threadId, sessionId: schema.browserJobs.sessionId, task: schema.browserJobs.task, status: schema.browserJobs.status, report: schema.browserJobs.report, updatedAt: schema.browserJobs.updatedAt }).from(schema.browserJobs).innerJoin(schema.threads, eq(schema.browserJobs.threadId, schema.threads.id)).where(and(eq(schema.threads.workspaceId, workspaceId), eq(schema.browserJobs.runtime, runtimeScope()))).orderBy(desc(schema.browserJobs.createdAt)).limit(10);
}
