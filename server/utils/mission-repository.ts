import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@nuxthub/db';
import { repositories, repositoryRuns } from '../db/schema/repositories';
import { missions, missionEvents, missionAttempts, missionTasks, missionResourceClaims } from '../db/schema/missions';
import { runtimeScope } from '../../shared/runtime-scope';
import { repoTerminal, type RepoJob, type RepositoryRunConfig } from '../../shared/repository';
import { repositoryRequestMatches } from '../../shared/repository-request.mjs';
import { claimedMission, type MissionLease, type MissionAttempt } from './mission-attempts';
import { buildMissionExecution, requireMissionExecutor } from './mission-executor-admission';
import { repositoryRunner, saveRepositoryJob } from './repositories';
import { requireWorkspace } from './workspaces';
import { recordMissionEvent, validateTaskMandate, type ControlledMission } from './mission-control';
import { missionHash } from './mission-sources';

const conflict = (message: string) => createError({ statusCode: 409, statusMessage: message });

/** Persist the exact physical intent and its source membership before HTTP.
 * A lost response is reconciled by dispatchId, never by issuing a new identity. */
export async function dispatchMissionRepository(lease: MissionLease, attemptId: string) {
  const run = await db.transaction(async tx => {
    const mission = await claimedMission(tx, lease);
    const [attempt] = await tx.select().from(missionAttempts).where(and(eq(missionAttempts.id, attemptId), eq(missionAttempts.missionId, mission.id)));
    if (!attempt) throw conflict('Körförsöket saknas.');
    const execution = buildMissionExecution(mission, attempt);
    const { task, now } = await requireMissionExecutor(tx, execution);
    await validateTaskMandate(tx, mission, task.spec!);
    const spec = task.spec!;
    let repository: typeof repositories.$inferSelect | undefined;
    let config: RepositoryRunConfig;
    if (spec.kind === 'discovery' && spec.target.kind === 'repository') {
      await tx.insert(repositories).values({ id: randomUUID(), workspaceId: mission.workspaceId, url: spec.target.url, ref: spec.target.ref, script: 'auto' }).onConflictDoNothing();
      [repository] = await tx.select().from(repositories).where(and(eq(repositories.workspaceId, mission.workspaceId), eq(repositories.url, spec.target.url)));
      // A full object ID must use the runner's detached, verified checkout.
      // Keep ref as the original request context; branch/tag refs remain dynamic.
      const expectedCommit = /^[a-f0-9]{40}$/i.test(spec.target.ref) ? spec.target.ref.toLowerCase() : undefined;
      config = { url: spec.target.url, ref: spec.target.ref, script: 'auto', mode: 'inspect', workspaceId: mission.workspaceId, execution,
        ...(expectedCommit ? { expectedCommit } : {}) };
    } else if (spec.kind === 'repository_check') {
      [repository] = await tx.select().from(repositories).where(and(eq(repositories.id, spec.repositoryId), eq(repositories.workspaceId, mission.workspaceId)));
      if (!repository) throw conflict('Repository saknas i detta workspace.');
      config = { url: repository.url, ref: repository.ref, script: spec.script || 'auto', mode: spec.mode, workspaceId: mission.workspaceId, execution,
        ...(spec.directory ? { directory: spec.directory } : {}), ...(spec.args?.length ? { args: spec.args } : {}), ...(spec.expectedCommit ? { expectedCommit: spec.expectedCommit } : {}) };
      if (spec.mode === 'test') {
        if (!spec.inspectedRunId || !spec.expectedCommit) throw conflict('Test kräver en sparad inspektion och dess commit.');
        const [inspection] = await tx.select().from(repositoryRuns).where(and(eq(repositoryRuns.id, spec.inspectedRunId), eq(repositoryRuns.workspaceId, mission.workspaceId), eq(repositoryRuns.runtime, runtimeScope())));
        const [originTask] = inspection?.config.execution ? await tx.select().from(missionTasks).where(and(eq(missionTasks.id, inspection.config.execution.taskId), eq(missionTasks.missionId, mission.id))) : [];
        if (!inspection?.config.execution || inspection.config.execution.missionId !== mission.id || inspection.repositoryId !== repository.id || inspection.config.url !== repository.url
          || inspection.config.mode !== 'inspect' || inspection.job?.status !== 'review' || inspection.job.commit !== spec.expectedCommit
          || !inspection.job.cleanup?.confirmed || !originTask?.sources.some(source => source.type === 'repository' && source.id === inspection.id)) throw conflict('Den frysta committen styrks inte av uppdragets inspektion.');
        if (!inspection.job.plan?.command.length || !spec.script || spec.script === 'auto' || inspection.job.plan.selectedScript !== spec.script
          || inspection.job.plan.directory !== (spec.directory ?? '.') || spec.args?.length) throw conflict('Testkommandot avviker från den sparade inspektionen.');
        // Branch is historical context only; the executor fetches detached SHA.
        config.ref = inspection.config.ref;
      }
    } else throw conflict('Deluppgiften kan inte köras av repository-utföraren.');
    if (!repository) throw conflict('Repository saknas.');
    const identity = { repositoryId: repository.id, runtime: runtimeScope(), bindingVersion: 1, missionBinding: { missionId: mission.id, taskId: task.id }, config };
    const [existing] = await tx.select().from(repositoryRuns).where(eq(repositoryRuns.id, attempt.dispatchId));
    if (existing && !repositoryRequestMatches(existing, identity)) throw conflict('Utförarens startidentitet har ändrats.');
    const [claim] = await tx.select().from(missionResourceClaims).where(and(eq(missionResourceClaims.attemptId, attempt.id), eq(missionResourceClaims.missionId, mission.id), eq(missionResourceClaims.runtime, runtimeScope())));
    if (!claim || claim.owner !== 'agent' || claim.state !== 'claimed' || claim.workspaceId !== mission.workspaceId || claim.resourceKey !== 'otto' || claim.expiresAt <= now
      || claim.executorResourceId && claim.executorResourceId !== attempt.dispatchId || attempt.executorResourceId && attempt.executorResourceId !== attempt.dispatchId) throw conflict('Körningen saknar sitt exklusiva resursanspråk.');
    await tx.insert(repositoryRuns).values({ id: attempt.dispatchId, requestId: attempt.dispatchId, workspaceId: mission.workspaceId, ...identity }).onConflictDoNothing();
    const [saved] = await tx.select().from(repositoryRuns).where(eq(repositoryRuns.id, attempt.dispatchId));
    if (!saved || !repositoryRequestMatches(saved, identity)) throw conflict('En annan körning använder denna identitet.');
    if (!task.sources.some(source => source.type === 'repository' && source.id === saved.id)) await tx.update(missionTasks).set({ sources: [...task.sources, { type: 'repository' as const, id: saved.id }] }).where(eq(missionTasks.id, task.id));
    if (spec.kind === 'repository_check' && spec.inspectedRunId && task.dependsOn.length === 1) {
      const [planned] = await tx.select().from(missionEvents).where(and(eq(missionEvents.missionId, mission.id), eq(missionEvents.eventKey, `repository-plan:${mission.planRevision}:${task.dependsOn[0]}`)));
      // Only a server-generated delivery contract is refined to this physical
      // attempt. Explicit user requirements/selected cases retain their identity.
      if (planned?.payload.taskId === task.id && planned.payload.inspectionId === spec.inspectedRunId && Array.isArray(planned.payload.deliveryCriterionIds)) {
        const ids = planned.payload.deliveryCriterionIds;
        const criteria = mission.config.criteria.map(criterion => ids.includes(criterion.id) && criterion.delivery?.kind === 'source'
          ? { ...criterion, delivery: { ...criterion.delivery, sourceRefs: [{ type: 'repository' as const, id: saved.id }] } } : criterion);
        if (JSON.stringify(criteria) !== JSON.stringify(mission.config.criteria)) {
          await tx.update(missions).set({ config: { ...mission.config, criteria } }).where(eq(missions.id, mission.id));
          await recordMissionEvent(tx, mission, 'repository.delivery_bound', { taskId: task.id, sourceId: saved.id,
            generatedCriterionHashes: Object.fromEntries(criteria.filter(criterion => ids.includes(criterion.id)).map(criterion => [criterion.id, missionHash(criterion)])),
          }, `repository-delivery:${attempt.id}`);
        }
      }
    }
    await tx.update(missionAttempts).set({ executorResourceId: attempt.dispatchId }).where(eq(missionAttempts.id, attempt.id));
    await tx.update(missionResourceClaims).set({ executorResourceId: attempt.dispatchId }).where(eq(missionResourceClaims.id, claim.id));
    return saved;
  });
  if (run.job && repoTerminal(run.job.status)) return repositoryProjection(run.job);
  const capabilities = await repositoryRunner<{ autonomousExecution?: { version: number; admission: boolean; frozenCommit: boolean } }>('/health');
  if (capabilities.autonomousExecution?.version !== 1 || !capabilities.autonomousExecution.admission || !capabilities.autonomousExecution.frozenCommit) throw conflict('Utföraren stöder inte uppdragets bindnings- och commitprotokoll.');
  // No SQL lock during the network call. Worker rechecks the live epoch before
  // every physical effect, including if cancellation races this saved intent.
  const job = await repositoryRunner<RepoJob>('/jobs', { id: run.id, ...run.config });
  await saveRepositoryJob(job);
  return repositoryProjection(job);
}

function repositoryProjection(job: RepoJob | null) {
  const terminal = !!job && repoTerminal(job.status);
  const status = !terminal ? null : job!.status === 'cancelled' ? 'cancelled' as const : ['passed', 'failed', 'review'].includes(job!.status) ? 'completed' as const : 'failed' as const;
  return { job, terminal, status, source: job ? { type: 'repository' as const, id: job.id } : null, cleanupConfirmed: terminal && job?.cleanup?.confirmed === true && job.cleanup.resourceId === job.id, executorResourceId: job?.id ?? null, unknown: !job };
}

/** Status/cancel is allowed after revocation, but never starts or adopts work. */
export async function reconcileMissionRepository(mission: ControlledMission, attempt: MissionAttempt, options: { cancel?: boolean } = {}) {
  await requireWorkspace(mission.userId, mission.workspaceId);
  if (mission.runtime !== runtimeScope() || attempt.runtime !== runtimeScope() || attempt.missionId !== mission.id) throw conflict('Körningen hör till ett annat uppdrag eller runtime.');
  const [run] = await db.select().from(repositoryRuns).where(and(eq(repositoryRuns.id, attempt.dispatchId), eq(repositoryRuns.workspaceId, mission.workspaceId), eq(repositoryRuns.runtime, runtimeScope())));
  if (!run) return { ...repositoryProjection(null), unsubmitted: true };
  if (run.config.execution?.attemptId !== attempt.id || run.config.execution.dispatchId !== attempt.dispatchId || run.config.execution.missionId !== mission.id) throw conflict('Körningen saknar sin ursprungliga försöksbindning.');
  if (run.job && repoTerminal(run.job.status) && run.job.cleanup?.confirmed) return { ...repositoryProjection(run.job), unsubmitted: false };
  try {
    // Bulk status supplies a definite "not admitted" result without interpreting
    // transport errors or generic HTTP 404 as permission to start again.
    const result = await repositoryRunner<{ jobs: RepoJob[] }>(`/jobs?ids=${run.id}`);
    let job = result.jobs.find(value => value.id === run.id);
    if (!job) return { ...repositoryProjection(run.job), unknown: true, unsubmitted: false, retryableDispatch: !run.job && !options.cancel };
    // Explicit controller cleanup may repair a terminal job's failed removal;
    // GET status remains read-only and never replays the repository command.
    if (options.cancel && (!repoTerminal(job.status) || job.cleanup?.confirmed !== true)) {
      // Validate the observed worker binding before asking it to remove anything.
      await saveRepositoryJob(job);
      job = await repositoryRunner<RepoJob>(`/jobs/${run.id}/cancel`, {});
    }
    await saveRepositoryJob(job);
    return { ...repositoryProjection(job), unsubmitted: false };
  } catch {
    return { ...repositoryProjection(run.job), unknown: true, unsubmitted: false, cleanupConfirmed: false };
  }
}
