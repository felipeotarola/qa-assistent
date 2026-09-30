import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, desc, sql } from 'drizzle-orm';
import { db } from '@nuxthub/db';
import { repositories, repositoryRuns } from '../db/schema/repositories';
import { requireWorkspace } from './workspaces';
import { repositoryActionSchema, repoTerminal, type RepoJob } from '../../shared/repository';
export async function saveRepositoryJob(job: RepoJob) {
  const [run] = await db.select().from(repositoryRuns).where(eq(repositoryRuns.id, job.id));
  if (!run) throw createError({ statusCode: 404, statusMessage: 'Run not found' });
  if (run.config.url !== job.url || run.config.ref !== job.ref || run.config.script !== job.script || run.config.mode !== job.mode || !isDeepStrictEqual(run.config.args || [], job.args || [])) throw createError({ statusCode: 409, statusMessage: 'Run configuration mismatch' });
  await db.update(repositoryRuns).set({ job }).where(and(eq(repositoryRuns.id, job.id), sql`coalesce(${repositoryRuns.job}->>'updatedAt', '') <= ${job.updatedAt}`));
}
async function runner<T>(path: string, body?: unknown) {
  const base = process.env.REPO_RUNNER_URL, key = process.env.REPO_RUNNER_KEY;
  if (!base || !key) throw createError({ statusCode: 503, statusMessage: 'Repository-testning är inte konfigurerad.' });
  const response = await fetch(`${base.replace(/\/$/, '')}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw createError({ statusCode: response.status === 400 ? 400 : 502, statusMessage: result.error?.slice(0, 200) || 'Testtjänsten är inte tillgänglig. Försök igen.' });
  }
  return await response.json() as T;
}
export async function listRepositories(userId: string, workspaceId: string) {
  await requireWorkspace(userId, workspaceId);
  const list = await db.select().from(repositories).where(eq(repositories.workspaceId, workspaceId));
  const runs = await db.select().from(repositoryRuns).where(eq(repositoryRuns.workspaceId, workspaceId)).orderBy(desc(repositoryRuns.createdAt)).limit(30);
  let syncError: string | undefined;
  for (const run of runs) {
    if (run.job && repoTerminal(run.job.status)) continue;
    try {
      // Re-submit the same ID to recover a lost HTTP response without duplicate work.
      const job = await runner<RepoJob>('/jobs', { id: run.id, ...run.config });
      await saveRepositoryJob(job); run.job = job;
    } catch { syncError = 'Kunde inte hämta aktuell körstatus. Senast sparade resultat visas.'; }
  }
  return { repositories: list, runs, available: !!(process.env.REPO_RUNNER_URL && process.env.REPO_RUNNER_KEY), syncError };
}
export async function repositoryAction(userId: string, workspaceId: string, raw: unknown) {
  await requireWorkspace(userId, workspaceId);
  const parsed = repositoryActionSchema.safeParse(raw);
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Kontrollera repository-URL, branch och script.' });
  const value = parsed.data;
  if (value.action === 'list') return listRepositories(userId, workspaceId);
  if (value.action === 'connect') {
    const { action: _action, ...config } = value;
    config.url = config.url.replace(/\/$/, '').replace(/\.git$/, '');
    return (await db.insert(repositories).values({ id: randomUUID(), workspaceId, ...config }).onConflictDoUpdate({ target: [repositories.workspaceId, repositories.url], set: { ref: config.ref, script: config.script } }).returning())[0];
  }
  if (value.action === 'cancel') {
    const [run] = await db.select().from(repositoryRuns).where(and(eq(repositoryRuns.id, value.runId), eq(repositoryRuns.workspaceId, workspaceId)));
    if (!run) throw createError({ statusCode: 404, statusMessage: 'Körningen saknas.' });
    const job = await runner<RepoJob>(`/jobs/${run.id}/cancel`, {});
    await saveRepositoryJob(job); return job;
  }
  const [repository] = await db.select().from(repositories).where(and(eq(repositories.id, value.repositoryId), eq(repositories.workspaceId, workspaceId)));
  if (!repository) throw createError({ statusCode: 404, statusMessage: 'Repository saknas.' });
  const config = { url: repository.url, ref: repository.ref, script: repository.script, mode: value.mode, ...(value.args?.length ? { args: value.args } : {}) };
  await db.insert(repositoryRuns).values({ id: randomUUID(), workspaceId, repositoryId: repository.id, requestId: value.requestId, config }).onConflictDoNothing();
  const [run] = await db.select().from(repositoryRuns).where(and(eq(repositoryRuns.workspaceId, workspaceId), eq(repositoryRuns.requestId, value.requestId)));
  if (!run || run.repositoryId !== repository.id || !isDeepStrictEqual(run.config, config)) throw createError({ statusCode: 409, statusMessage: 'Begäran har redan använts för en annan körning.' });
  if (run.job && repoTerminal(run.job.status)) return run.job;
  let job: RepoJob;
  try {
    job = await runner<RepoJob>('/jobs', { id: run.id, ...config });
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 400) throw error;
    const now = new Date().toISOString();
    job = { id: run.id, ...config, status: 'blocked', message: (error as Error).message, logs: '', commit: null, package: null, testExitCode: null, createdAt: now, updatedAt: now, finishedAt: now };
  }
  await saveRepositoryJob(job); return job;
}
