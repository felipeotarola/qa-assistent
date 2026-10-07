import { and, eq } from 'drizzle-orm';
import { schema } from '@nuxthub/db';
import type { MissionTaskSpec } from '../../shared/mission-control';
import { environmentPlanHash, environmentRequestFingerprint } from '../../shared/mission-environment.mjs';
import { environmentPlanIdentity } from '../../shared/environment-plan-identity.mjs';
import { runtimeScope } from '../../shared/runtime-scope';
import { currentMandate, type ControlledMission } from './mission-control';
import { authorizeEnvironmentConsent } from './environment-consents';
import { missionHash } from './mission-sources';
import type { WorkspaceDatabase } from './workspaces';

type Spec = Extract<MissionTaskSpec, { kind: 'environment_setup' }>;
const conflict = () => createError({ statusCode: 409, statusMessage: 'Den godkända startplanen gäller inte längre.' });

/** A grant is only a candidate for a NEW identity probe. It never adopts the
 * old task, sandbox, readiness result or execution mandate. No values return. */
export async function approvedMissionPreparation(tx: WorkspaceDatabase, mission: ControlledMission, spec: Spec, deadline: Date) {
  const reference = spec.approvedPreparation;
  const mandate = currentMandate(mission);
  if (spec.phase !== 'prepare' || !reference || !mandate.consentIds.includes(reference.consentId)
    || !mandate.repositoryUrls.includes(spec.repoUrl)) throw conflict();
  const [consent] = await tx.select().from(schema.environmentConsents).where(and(
    eq(schema.environmentConsents.id, reference.consentId), eq(schema.environmentConsents.userId, mission.userId),
    eq(schema.environmentConsents.workspaceId, mission.workspaceId), eq(schema.environmentConsents.runtime, runtimeScope()),
  ));
  if (!consent || consent.grantSetupJobId !== reference.sourceSetupJobId || consent.revision !== reference.consentRevision
    || consent.vaultRevision !== reference.vaultRevision || consent.planHash !== reference.planHash) throw conflict();
  const [source] = await tx.select().from(schema.setupJobs).where(and(eq(schema.setupJobs.id, reference.sourceSetupJobId),
    eq(schema.setupJobs.workspaceId, mission.workspaceId), eq(schema.setupJobs.runtime, runtimeScope())));
  const result = source?.result;
  if (!source?.autonomy || source.autonomy.environmentExecution?.phase !== 'prepare' || !result?.environment || !result.execution
    || source.autonomy.execution?.runtime !== runtimeScope() || !result.environmentExecution
    || !['completed', 'needs_configuration'].includes(source.status) || result.cleanup !== 'confirmed' || result.executorStopped !== true
    || result.fingerprint !== source.autonomy.fingerprint || missionHash(result.execution) !== missionHash(source.autonomy.execution)
    || result.environment.probeKind !== 'identity' || result.environment.httpStatus !== null || result.environment.processId) throw conflict();
  let plan;
  try {
    plan = environmentPlanIdentity(consent.plan);
    if (!plan.executionProfile || plan.root !== '/workspace/repository' || plan.repoUrl !== spec.repoUrl || plan.commit !== spec.expectedCommit
      || environmentPlanHash(plan) !== reference.planHash || environmentPlanHash(result.environment) !== reference.planHash
      || missionHash(result.environmentExecution) !== missionHash(source.autonomy.environmentExecution)
      || environmentRequestFingerprint(source.autonomy.execution, source.task, source.autonomy.environmentExecution) !== source.autonomy.fingerprint) throw conflict();
  } catch { throw conflict(); }
  const [inspection] = await tx.select().from(schema.repositoryRuns).where(and(eq(schema.repositoryRuns.id, spec.inspectedRunId),
    eq(schema.repositoryRuns.workspaceId, mission.workspaceId), eq(schema.repositoryRuns.runtime, runtimeScope())));
  if (!inspection?.config.execution || inspection.config.execution.missionId !== mission.id || inspection.config.mode !== 'inspect'
    || inspection.config.url !== plan.repoUrl || inspection.job?.commit !== plan.commit || inspection.job.status !== 'review'
    || !inspection.job.cleanup?.confirmed || inspection.job.plan?.runtime !== plan.executionProfile.runtime
    || inspection.job.plan.directory !== (plan.directory === plan.root ? '.' : plan.directory.slice(plan.root.length + 1))) throw conflict();
  const [discovery] = await tx.select().from(schema.missionTasks).where(and(eq(schema.missionTasks.id, inspection.config.execution.taskId),
    eq(schema.missionTasks.missionId, mission.id)));
  if (discovery?.spec?.kind !== 'discovery' || discovery.planRevision !== mission.planRevision
    || !discovery.sources.some(source => source.type === 'repository' && source.id === inspection.id)) throw conflict();
  // Existing Vault lock + exact original plan/owner validation. Revocation,
  // rotation and expiry are rechecked on dispatch and every physical admission.
  const authorization = await authorizeEnvironmentConsent(mission.userId, mission.workspaceId, {
    consentId: consent.id, consentRevision: reference.consentRevision, vaultRevision: reference.vaultRevision,
    setupJobId: reference.sourceSetupJobId, expectedPlanHash: reference.planHash,
  }, { connection: tx, deadline });
  return { plan, planHash: reference.planHash, validUntil: new Date(authorization.validUntil) };
}

export async function findApprovedMissionPreparation(tx: WorkspaceDatabase, mission: ControlledMission, spec: Spec) {
  const found: NonNullable<Spec['approvedPreparation']>[] = [];
  for (const id of currentMandate(mission).consentIds) {
    const [consent] = await tx.select().from(schema.environmentConsents).where(and(eq(schema.environmentConsents.id, id),
      eq(schema.environmentConsents.userId, mission.userId), eq(schema.environmentConsents.workspaceId, mission.workspaceId),
      eq(schema.environmentConsents.runtime, runtimeScope())));
    if (!consent || consent.repoUrl !== spec.repoUrl || consent.plan?.commit !== spec.expectedCommit) continue;
    const reference = { sourceSetupJobId: consent.grantSetupJobId, consentId: consent.id, consentRevision: consent.revision,
      vaultRevision: consent.vaultRevision, planHash: consent.planHash };
    try {
      await approvedMissionPreparation(tx, mission, { ...spec, approvedPreparation: reference }, mission.deadlineAt!);
      found.push(reference);
    } catch (error) {
      if (![403, 404, 409].includes((error as { statusCode?: number }).statusCode ?? 0)) throw error;
    }
  }
  // Conflicting valid plans need ordinary preparation; do not guess which
  // approved project/command the user meant. Once selected there is no fallback.
  return found.length && new Set(found.map(value => value.planHash)).size === 1 ? found[0] : undefined;
}
