import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, desc, sql } from 'drizzle-orm';
import { db } from '@nuxthub/db';
import { repositories, repositoryRuns } from '../db/schema/repositories';
import { requireWorkspace } from './workspaces';
import { repositoryActionSchema, repoTerminal, type RepoJob } from '../../shared/repository';
import { runtimeScope } from '../../shared/runtime-scope';
import { repositoryRequestMatches } from '../../shared/repository-request.mjs';
import { bindMissionSource, validateMissionBinding } from './missions';
import { canonicalExecutionPayload, missionExecution } from '../../shared/mission-execution.mjs';
import { missions } from '../db/schema/missions';
export const repositoryExecutionFingerprint = (id: string, config: unknown) => createHash('sha256').update(canonicalExecutionPayload({ id, ...(config as object) })).digest('hex');
async function requireManualBinding(workspaceId: string, missionId?: string) {
  if (!missionId) return;
  const [mission] = await db.select({ controllerVersion: missions.controllerVersion }).from(missions).where(and(eq(missions.id, missionId), eq(missions.workspaceId, workspaceId)));
  if (mission?.controllerVersion === 1) throw createError({ statusCode: 409, statusMessage: 'Autonoma repokörningar får endast startas av uppdragets bundna utförare.' });
}
export async function saveRepositoryJob(job: RepoJob) {
  const [run] = await db.select().from(repositoryRuns).where(eq(repositoryRuns.id, job.id));
  if (!run) throw createError({ statusCode: 404, statusMessage: 'Run not found' });
  if (run.config.url !== job.url || run.config.ref !== job.ref || run.config.script !== job.script || run.config.mode !== job.mode || run.config.directory !== job.directory || !isDeepStrictEqual(run.config.args || [], job.args || [])) throw createError({ statusCode: 409, statusMessage: 'Run configuration mismatch' });
  if (run.config.execution || job.execution) {
    if (!run.config.execution || !job.execution || run.runtime !== runtimeScope() || !isDeepStrictEqual(missionExecution(run.config.execution), missionExecution(job.execution))
      || !Number.isSafeInteger(job.revision) || job.revision! < 1
      || job.id !== job.execution.dispatchId || job.workspaceId !== run.workspaceId || job.expectedCommit !== run.config.expectedCommit
      || job.fingerprint !== repositoryExecutionFingerprint(run.id, run.config)
      || job.cleanup && job.cleanup.resourceId !== run.id
      || ['passed', 'failed', 'review'].includes(job.status) && run.config.expectedCommit && job.commit !== run.config.expectedCommit) throw createError({ statusCode: 409, statusMessage: 'Utförarens kvitto avviker från det sparade körförsöket.' });
  }
  const newer = job.revision === undefined
    ? sql`(${repositoryRuns.job}->>'revision') is null and coalesce(${repositoryRuns.job}->>'updatedAt', '') <= ${job.updatedAt}`
    : sql`coalesce((${repositoryRuns.job}->>'revision')::bigint, 0) < ${job.revision}`;
  await db.update(repositoryRuns).set({ job }).where(and(eq(repositoryRuns.id, job.id), newer));
  if (run.config.execution) await db.update(missions).set({ nextWakeAt: new Date() }).where(and(eq(missions.id, run.config.execution.missionId), eq(missions.runtime, runtimeScope()), sql`${missions.lifecycle} in ('running','waiting','paused','cancelling')`));
}
export async function repositoryRunner<T>(path: string, body?: unknown, timeoutMs = 10000) {
  const base = process.env.REPO_RUNNER_URL, key = process.env.REPO_RUNNER_KEY;
  if (!base || !key) throw createError({ statusCode: 503, statusMessage: 'Repository-testning är inte konfigurerad.' });
  const response = await fetch(`${base.replace(/\/$/, '')}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw createError({ statusCode: response.status === 400 ? 400 : 502, statusMessage: result.error?.slice(0, 200) || 'Testtjänsten är inte tillgänglig. Försök igen.' });
  }
  return await response.json() as T;
}
const runner = repositoryRunner;
function repositoryView(run: typeof repositoryRuns.$inferSelect, compact = false) {
  const { execution: _execution, ...config } = run.config;
  let job = null;
  if (run.job) {
    const { execution: _execution, fingerprint: _fingerprint, commandJournal: _journal, ...visible } = run.job as RepoJob & { commandJournal?: unknown };
    job = { ...visible, ...(compact ? { logs: '' } : {}) };
  }
  return { ...run, config, job };
}
export async function listRepositories(userId: string, workspaceId: string, compact = false) {
  await requireWorkspace(userId, workspaceId);
  const list = await db.select().from(repositories).where(eq(repositories.workspaceId, workspaceId));
  const runs = await db.select().from(repositoryRuns).where(eq(repositoryRuns.workspaceId, workspaceId)).orderBy(desc(repositoryRuns.createdAt)).limit(30);
  let syncError: string | undefined;
  // Controller-owned jobs are a read projection here. Only their adapter may
  // dispatch/reconcile them; opening Material must never advance an attempt.
  const active = runs.filter(run => !run.config.execution && run.runtime === runtimeScope() && (!run.job || !repoTerminal(run.job.status)));
  if (active.length) {
    try {
      const result = await runner<{ jobs: RepoJob[] }>(`/jobs?ids=${active.map(run => run.id).join(',')}`);
      const recovered = await Promise.allSettled(active.map(async run => {
        // Only recover genuinely unsubmitted jobs. Reading status never replays a known job.
        let job = result.jobs.find(job => job.id === run.id);
        if (!job && !run.job) {
          await requireManualBinding(workspaceId, run.missionBinding?.missionId);
          if (run.bindingVersion !== 1) throw createError({ statusCode: 409, statusMessage: 'Historisk körning saknar verifierad startbindning. Starta en ny uttryckligen beställd körning.' });
          // A crash can leave a saved submission before its mission source was
          // attached. Recovery must establish that same binding before dispatch.
          await validateMissionBinding(userId, workspaceId, run.missionBinding ?? undefined);
          await bindMissionSource(userId, workspaceId, '', run.missionBinding ?? undefined, 'repository', run.id);
          job = await runner<RepoJob>('/jobs', { id: run.id, ...run.config });
        }
        if (job) { await saveRepositoryJob(job); run.job = job; }
      }));
      // Do not return while sibling recoveries can still dispatch or persist.
      // A blocked legacy row must not strand another valid recovery in flight.
      if (recovered.some(result => result.status === 'rejected')) throw new Error('Repository recovery incomplete');
    } catch { syncError = 'Kunde inte hämta aktuell körstatus. Senast sparade resultat visas.'; }
  }
  return { repositories: list, runs: runs.map(run => repositoryView(run, compact)), available: !!(process.env.REPO_RUNNER_URL && process.env.REPO_RUNNER_KEY), syncError };
}
export async function getRepositoryRun(userId: string, workspaceId: string, runId: string) {
  await requireWorkspace(userId, workspaceId);
  const [run] = await db.select().from(repositoryRuns).where(and(eq(repositoryRuns.id, runId), eq(repositoryRuns.workspaceId, workspaceId)));
  if (!run) throw createError({ statusCode: 404, statusMessage: 'Körningen saknas.' });
  return repositoryView(run);
}
export async function repositoryAction(userId: string, workspaceId: string, raw: unknown, threadId?: string) {
  await requireWorkspace(userId, workspaceId);
  const parsed = repositoryActionSchema.safeParse(raw);
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Kontrollera repository-URL, branch och script.' });
  const value = parsed.data;
  if (value.action === 'start') await requireManualBinding(workspaceId, value.mission?.missionId);
  if (value.action === 'start' && value.mission && !threadId) throw createError({ statusCode: 400, statusMessage: 'Mission runs require a chat' });
  if (value.action === 'list') return listRepositories(userId, workspaceId);
  if (value.action === 'connect') {
    const { action: _action, ...config } = value;
    config.url = config.url.replace(/\/$/, '').replace(/\.git$/, '');
    return (await db.insert(repositories).values({ id: randomUUID(), workspaceId, ...config }).onConflictDoUpdate({ target: [repositories.workspaceId, repositories.url], set: { ref: config.ref, script: config.script } }).returning())[0];
  }
  if (value.action === 'cancel') {
    const [run] = await db.select().from(repositoryRuns).where(and(eq(repositoryRuns.id, value.runId), eq(repositoryRuns.workspaceId, workspaceId)));
    if (!run) throw createError({ statusCode: 404, statusMessage: 'Körningen saknas.' });
    if (run.runtime !== runtimeScope()) throw createError({ statusCode: 409, statusMessage: 'Körningen tillhör en annan runtime.' });
    if (run.config.execution) throw createError({ statusCode: 409, statusMessage: 'Avbryt det autonoma uppdraget via dess uppdragskontroller.' });
    const job = await runner<RepoJob>(`/jobs/${run.id}/cancel`, {});
    await saveRepositoryJob(job); return job;
  }
  const [repository] = await db.select().from(repositories).where(and(eq(repositories.id, value.repositoryId), eq(repositories.workspaceId, workspaceId)));
  if (!repository) throw createError({ statusCode: 404, statusMessage: 'Repository saknas.' });
  const config = { url: repository.url, ref: repository.ref, script: value.script ?? repository.script, mode: value.mode, workspaceId, ...(value.directory ? { directory: value.directory } : {}), ...(value.args?.length ? { args: value.args } : {}) };
  const identity = { runtime: runtimeScope(), repositoryId: repository.id, bindingVersion: 1, missionBinding: value.mission ?? null, config };
  const [existing] = await db.select().from(repositoryRuns).where(and(eq(repositoryRuns.workspaceId, workspaceId), eq(repositoryRuns.requestId, value.requestId)));
  if (existing) {
    if (!repositoryRequestMatches(existing, identity)) throw createError({ statusCode: 409, statusMessage: 'Begäran har redan använts för en annan körning eller uppdragskoppling.' });
    // Returning a persisted receipt is not a new execution. It stays replayable
    // after mission closure; active ownership is required below before dispatch.
    if (existing.job && repoTerminal(existing.job.status)) return existing.job;
  }
  await validateMissionBinding(userId, workspaceId, value.mission);
  await db.insert(repositoryRuns).values({ id: randomUUID(), workspaceId, requestId: value.requestId, ...identity }).onConflictDoNothing();
  const [run] = await db.select().from(repositoryRuns).where(and(eq(repositoryRuns.workspaceId, workspaceId), eq(repositoryRuns.requestId, value.requestId)));
  if (!run || !repositoryRequestMatches(run, identity)) throw createError({ statusCode: 409, statusMessage: 'Begäran har redan använts för en annan körning eller uppdragskoppling.' });
  await bindMissionSource(userId, workspaceId, threadId ?? '', value.mission, 'repository', run.id);
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
