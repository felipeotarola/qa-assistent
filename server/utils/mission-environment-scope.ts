import { and, eq } from 'drizzle-orm';
import { schema } from '@nuxthub/db';
import { environmentPlanHash } from '../../shared/mission-environment.mjs';
import { runtimeScope } from '../../shared/runtime-scope';
import { autonomyEnabled, currentMandate, lockMission, type ControlledMission } from './mission-control';
import { databaseNow } from './mission-attempts';
import type { WorkspaceDatabase } from './workspaces';
import { authorizeEnvironmentConsent } from './environment-consents';

/** Server-owned linkage, not a URL supplied by the model. A retained resource
 * remains subject to its original expiry and current mandate throughout QA. */
export async function readyMissionEnvironment(tx: WorkspaceDatabase, mission: ControlledMission, setupJobId: string) {
  const deny = () => createError({ statusCode: 409, statusMessage: 'Testmiljön har inte ett aktuellt verifierat körmandat.' });
  await lockMission(tx, mission.id);
  const [current] = await tx.select().from(schema.missions).where(and(eq(schema.missions.id, mission.id), eq(schema.missions.runtime, runtimeScope())));
  if (!autonomyEnabled() || !current || current.status !== 'active' || current.controllerVersion !== 1 || current.workspaceId !== mission.workspaceId || current.userId !== mission.userId
    || current.mandateRevision !== mission.mandateRevision || current.planRevision !== mission.planRevision) throw deny();
  mission = current;
  const [job] = await tx.select().from(schema.setupJobs).where(and(eq(schema.setupJobs.id, setupJobId), eq(schema.setupJobs.workspaceId, mission.workspaceId), eq(schema.setupJobs.runtime, runtimeScope())));
  const binding = job?.autonomy, config = binding?.environmentExecution, result = job?.result, plan = result?.environment;
  if (!job || !binding || config?.phase !== 'apply' || binding.execution.missionId !== mission.id
    || binding.execution.mandateRevision !== mission.mandateRevision || binding.execution.planRevision !== mission.planRevision
    || job.status !== 'completed' || result?.cleanup !== 'retained' || result.executorStopped !== true || plan?.probeKind !== 'http'
    || plan.httpStatus == null || plan.httpStatus < 200 || plan.httpStatus >= 400 || !plan.observedAt || environmentPlanHash(plan) !== config.planHash
    || !currentMandate(mission).repositoryUrls.includes(plan.repoUrl) || !['running', 'waiting'].includes(mission.lifecycle!) || mission.phase === 'report') throw deny();
  const [attempt] = await tx.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.id, binding.execution.attemptId), eq(schema.missionAttempts.missionId, mission.id), eq(schema.missionAttempts.runtime, runtimeScope())));
  const [claim] = await tx.select().from(schema.missionResourceClaims).where(and(eq(schema.missionResourceClaims.attemptId, binding.execution.attemptId), eq(schema.missionResourceClaims.missionId, mission.id), eq(schema.missionResourceClaims.runtime, runtimeScope())));
  let deadlineAt = Math.min(attempt?.deadlineAt.getTime() ?? 0, mission.deadlineAt?.getTime() ?? 0);
  if (config.consent) {
    if (!mission.mandate?.consentIds.includes(config.consent.id)) throw deny();
    const authorization = await authorizeEnvironmentConsent(mission.userId, mission.workspaceId, { consentId: config.consent.id, consentRevision: config.consent.revision,
      vaultRevision: config.consent.vaultRevision, setupJobId: config.sourceSetupJobId, expectedPlanHash: config.planHash }, { connection: tx, deadline: new Date(deadlineAt) });
    deadlineAt = Math.min(deadlineAt, Date.parse(authorization.validUntil));
  } else if (config.plan.variables.some(variable => variable.required)) throw deny();
  const now = await databaseNow(tx);
  if (!attempt || attempt.status !== 'completed' || attempt.cancelRequestedAt || attempt.executorResourceId !== binding.resourceId || attempt.deadlineAt <= now
    || !mission.deadlineAt || mission.deadlineAt <= now || !claim || claim.owner !== 'agent' || claim.state !== 'claimed'
    || claim.workspaceId !== mission.workspaceId || claim.resourceKey !== 'otto' || claim.executorResourceId !== binding.resourceId || claim.expiresAt <= now || deadlineAt <= now.getTime()) throw deny();
  return { job, binding, config, plan, attempt, claim, deadlineAt: new Date(deadlineAt) };
}
