import { and, eq, inArray } from 'drizzle-orm';
import { missions, missionTasks, missionAttempts, missionEvents } from '../db/schema/missions';
import { repositoryRuns } from '../db/schema/repositories';
import { runtimeScope } from '../../shared/runtime-scope';
import type { RepoJob } from '../../shared/repository';
import { addMissionTask, autonomyEnabled, recordMissionEvent, type ControlledMission } from './mission-control';
import { databaseNow } from './mission-attempts';
import { buildMissionExecution } from './mission-executor-admission';
import { repositoryExecutionFingerprint } from './repositories';
import { missionHash } from './mission-sources';
import type { WorkspaceDatabase } from './workspaces';

type Task = typeof missionTasks.$inferSelect;
type InspectionPlan = NonNullable<RepoJob['plan']>;
const conflict = (message: string) => createError({ statusCode: 409, statusMessage: message });
const stale = (reason: string) => ({ state: 'stale' as const, reason, task: null, inspectionId: null, repositoryId: null, commit: null, plan: null });
// This exact server-generated default is the only prose this adapter may refine.
// Explicit requirements and existing test-case selections are never rewritten.
const initialQaText = 'Varje valt testfalls körningar har avslutats och deras utförda steg och faktiska utfall är underbyggda av sparat underlag och granskning. Ett underbyggt negativt utfall är ett färdigt QA-resultat; otestade eller oklara delar är leveransluckor.';

function identifiedCheck(job: RepoJob): { script: string; directory: string; label: string } | null {
  const plan = job.plan;
  if (!plan?.command.length || plan.command.some(part => typeof part !== 'string' || !part)
    || !/^[\w][\w:-]{0,79}$/.test(plan.selectedScript)) return null;
  const script = plan.selectedScript;
  if (['node22', 'node24'].includes(plan.runtime)) {
    // A root package may contain dev/build scripts without a test command.
    // Never treat the runner's inspect fallback "auto" as executable QA.
    if (!/^(test(?::[\w:-]+)?|lint(?::[\w:-]+)?|typecheck(?::[\w:-]+)?)$/.test(script)
      || !job.package?.scripts || !Object.hasOwn(job.package.scripts, script) || !job.package.scripts[script]?.trim()) return null;
  } else if (!['java21', 'python3'].includes(plan.runtime) || script !== 'test') return null;
  return { script, directory: plan.directory, label: /^(lint|typecheck)(:|$)/.test(script) ? 'statiska kontrollen' : 'testkommandot' };
}

/** A route decision from the authenticated, persisted inspection only. It
 * does not execute the script, validate app readiness, or release Vault data. */
export function inspectedRepositorySurface(job: RepoJob, surface: 'auto' | 'checks' | 'application') {
  if (surface === 'application') return 'application' as const;
  if (identifiedCheck(job)) return 'checks' as const;
  const plan = job.plan;
  if (surface === 'auto' && plan?.operationKind === 'inspect' && ['node22', 'node24'].includes(plan.runtime)
    && typeof plan.directory === 'string' && (plan.directory === '.' || /^(?!\.\.?(?:\/|$))[\w.-]+(?:\/[\w.-]+)*$/.test(plan.directory) && !plan.directory.split('/').includes('..'))
    && job.projects?.filter(project => project.directory === plan.directory && project.kind === 'node').length === 1
    && ['start', 'dev'].some(script => Object.hasOwn(job.package?.scripts ?? {}, script) && typeof job.package?.scripts[script] === 'string' && job.package.scripts[script]!.trim())) return 'application' as const;
  return 'blocked' as const;
}

/** Called with the mission lock held. A persisted inspection creates a single
 * bounded successor; it is context, never a substitute for executing that check.
 */
export async function reconcileRepositoryDiscovery(tx: WorkspaceDatabase, expected: ControlledMission, discovery: Task) {
  const [mission] = await tx.select().from(missions).where(and(eq(missions.id, expected.id), eq(missions.runtime, runtimeScope())));
  const [task] = await tx.select().from(missionTasks).where(and(eq(missionTasks.id, discovery.id), eq(missionTasks.missionId, expected.id)));
  const now = await databaseNow(tx);
  if (!autonomyEnabled() || !mission || mission.controllerVersion !== 1 || mission.status !== 'active'
    || !['running', 'waiting'].includes(mission.lifecycle!) || mission.phase === 'report' || !mission.deadlineAt || mission.deadlineAt <= now
    || task?.state !== 'completed' || task.spec?.kind !== 'discovery' || task.spec.target.kind !== 'repository') throw conflict('Repoinspektionen saknar ett aktuellt uppdrag.');
  if (mission.planRevision !== expected.planRevision || mission.mandateRevision !== expected.mandateRevision || task.planRevision !== mission.planRevision) return stale('Repoinspektionen tillhör en tidigare plan eller ett tidigare mandat.');
  const attempts = await tx.select().from(missionAttempts).where(and(eq(missionAttempts.missionId, mission.id), eq(missionAttempts.taskId, task.id)));
  const current = attempts.filter(attempt => attempt.planRevision === mission.planRevision && attempt.mandateRevision === mission.mandateRevision).sort((a, b) => b.attemptNo - a.attemptNo)[0];
  if (!current && attempts.length) return stale('Repoinspektionens avslutade körning tillhör ett tidigare mandat.');
  if (!current || current.runtime !== runtimeScope() || current.status !== 'completed' || current.cancelRequestedAt
    || current.requestHash !== missionHash({ spec: task.spec, planRevision: mission.planRevision, mandateRevision: mission.mandateRevision })) throw conflict('Repoinspektionens körförsök är inte aktuellt och avslutat.');
  const [inspection] = await tx.select().from(repositoryRuns).where(and(eq(repositoryRuns.id, current.dispatchId), eq(repositoryRuns.workspaceId, mission.workspaceId), eq(repositoryRuns.runtime, runtimeScope())));
  const job = inspection?.job;
  if (!inspection?.config.execution || !job?.execution || inspection.bindingVersion !== 1 || inspection.missionBinding?.missionId !== mission.id || inspection.missionBinding.taskId !== task.id
    || !task.sources.some(source => source.type === 'repository' && source.id === inspection.id)
    || missionHash(inspection.config.execution) !== missionHash(buildMissionExecution(mission, current)) || missionHash(job.execution) !== missionHash(inspection.config.execution)
    || inspection.config.mode !== 'inspect' || inspection.config.url !== task.spec.target.url || inspection.config.ref !== task.spec.target.ref
    || job.id !== inspection.id || job.status !== 'review' || !job.finishedAt || !/^[a-f0-9]{40}$/.test(job.commit ?? '')
    || !job.cleanup?.confirmed || job.cleanup.resourceId !== inspection.id || job.fingerprint !== repositoryExecutionFingerprint(inspection.id, inspection.config)) throw conflict('Repoinspektionen saknar verifierad bindning, commit eller städkvittens.');
  const completedAt = Date.parse(job.finishedAt ?? job.updatedAt);
  if (!Number.isFinite(completedAt) || completedAt > current.deadlineAt.getTime()) return stale('Repoinspektionen avslutades inte inom körförsökets deadline.');
  const commit = job.commit!;
  const info = { inspectionId: inspection.id, repositoryId: inspection.repositoryId, commit, plan: job.plan ?? null as InspectionPlan | null };
  const inspectionHash = missionHash({ id: inspection.id, config: inspection.config, fingerprint: job.fingerprint, commit, plan: job.plan ?? null, package: job.package });
  const selectedSurface = mission.config.caseKeys.length || mission.config.criteria.some(criterion => criterion.delivery?.kind === 'test_cases')
    ? 'application' : inspectedRepositorySurface(job, task.spec.target.surface ?? 'checks');
  if (task.spec.target.surface === 'auto') {
    const surfaceHash = missionHash({ inspectionHash, projects: job.projects });
    const decisionKey = `repository-surface:${mission.planRevision}:${task.id}`;
    const [chosen] = await tx.select().from(missionEvents).where(and(eq(missionEvents.missionId, mission.id), eq(missionEvents.eventKey, decisionKey)));
    if (chosen) {
      if (chosen.payload.inspectionHash !== surfaceHash || chosen.payload.selectedSurface !== selectedSurface) throw conflict('Repoinspektionens valda testyta har ändrats.');
    } else await recordMissionEvent(tx, mission, 'repository.surface_selected', { policyVersion: 1, inspectionId: inspection.id, inspectionHash: surfaceHash, selectedSurface }, decisionKey);
  }
  // User-selected browser tests retain their own delivery contract. The caller
  // can use this inspected SHA for the separately authorized environment branch.
  if (selectedSurface === 'application') return { ...info, state: 'requires_browser' as const, task: null };
  const operationId = `repository-check:${mission.planRevision}:${task.id}`;
  const eventKey = `repository-plan:${mission.planRevision}:${task.id}`;
  const [event] = await tx.select().from(missionEvents).where(and(eq(missionEvents.missionId, mission.id), eq(missionEvents.eventKey, eventKey)));
  const [old] = await tx.select().from(missionTasks).where(and(eq(missionTasks.missionId, mission.id), eq(missionTasks.operationId, operationId)));
  if (event || old) {
    if (!event || !old || event.payload.inspectionHash !== inspectionHash || event.payload.taskId !== old.id) throw conflict('Den sparade repoinspektionen ändrades efter planeringen.');
    return { ...info, state: event.payload.disposition === 'ready' ? 'ready' as const : 'blocked' as const, task: old };
  }
  const check = identifiedCheck(job);
  const criterion = mission.config.criteria[0];
  const previousContracts = await tx.select({ payload: missionEvents.payload }).from(missionEvents).where(and(eq(missionEvents.missionId, mission.id), inArray(missionEvents.kind, ['repository.plan', 'repository.delivery_bound'])));
  const unchangedGenerated = !!criterion && previousContracts.some(({ payload }) => {
    const hashes = payload.generatedCriterionHashes;
    return hashes && typeof hashes === 'object' && !Array.isArray(hashes) && (hashes as Record<string, unknown>)[criterion.id] === missionHash(criterion);
  });
  // Full hashes include the prior sourceRefs. A user's change to either prose
  // or delivery identity cannot inherit server ownership during explicit resume.
  const generated = !!mission.admission && mission.config.criteria.length === 1 && criterion?.id === 'qa'
    && (criterion.text === initialQaText && !criterion.delivery || unchangedGenerated)
    && !mission.admission.caseKeys.length && !mission.admission.sourceRefs.length;
  let successor = await addMissionTask(tx, mission, {
    operationId, title: check ? `Kör ${check.label} på inspekterad commit` : 'Välj en avgränsad repositorykontroll',
    spec: check ? { kind: 'repository_check', repositoryId: inspection.repositoryId, mode: 'test', script: check.script, directory: check.directory, inspectedRunId: inspection.id, expectedCommit: commit }
      : { kind: 'planning', sourceRefs: [{ type: 'repository', id: inspection.id }] },
    dependsOn: [task.id], criterionIds: task.criterionIds,
  });
  if (!check) {
    const [blocked] = await tx.update(missionTasks).set({ state: 'blocked', blockedReason: 'Inspektionen identifierade inget entydigt test- eller statiskt kontrollkommando. Vilken projektkatalog och vilket befintligt test-, lint- eller typecheck-kommando ska användas?', updatedAt: now }).where(eq(missionTasks.id, successor.id)).returning();
    successor = blocked!;
  }
  // Inspection remains report context, but no longer owns a QA-delivery claim.
  await tx.update(missionTasks).set({ criterionIds: [], updatedAt: now }).where(eq(missionTasks.id, task.id));
  const generatedCriterion = { id: 'qa',
    text: check ? `Den identifierade ${check.label} (${check.script}) har körts på exakt inspekterad commit och utfallet underbyggs av sparade kommandologgar. Ett underbyggt negativt utfall är ett färdigt QA-resultat. Inga funktionella tester utlovas utöver detta kommando.`
      : 'Ett relevant test- eller statiskt kontrollkommando har identifierats och utförts på exakt inspekterad commit med sparade kommandologgar. Enbart repoinspektion uppfyller inte leveransen.',
    delivery: { kind: 'source' as const, sourceTypes: ['repository' as const] },
  };
  if (generated) await tx.update(missions).set({ config: { ...mission.config, criteria: [generatedCriterion] } }).where(eq(missions.id, mission.id));
  await recordMissionEvent(tx, mission, 'repository.plan', { inspectionId: inspection.id, inspectionHash, taskId: successor!.id, disposition: check ? 'ready' : 'blocked',
    deliveryCriterionIds: generated ? ['qa'] : [], generatedCriterionHashes: generated ? { qa: missionHash(generatedCriterion) } : {},
  }, eventKey);
  return { ...info, state: check ? 'ready' as const : 'blocked' as const, task: successor! };
}
