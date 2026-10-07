import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@nuxthub/db';
import { environmentPlanHash } from '../../shared/mission-environment.mjs';
import { runtimeScope } from '../../shared/runtime-scope';
import { addMissionTask, createMissionWait, currentMandate, recordMissionEvent, type ControlledMission } from './mission-control';
import { databaseNow } from './mission-attempts';
import { authorizeEnvironmentConsent } from './environment-consents';
import { readyMissionEnvironment } from './mission-environment-scope';
import { findApprovedMissionPreparation } from './mission-environment-reuse';
import type { WorkspaceDatabase } from './workspaces';

type Task = typeof schema.missionTasks.$inferSelect;

/** A consumed inspection is an immutable prerequisite, not a new execution
 * request. An explicit consent grant can advance the epoch after this graph
 * edge was committed without invalidating its already saved preparation. */
export async function environmentConsumedDiscovery(tx: WorkspaceDatabase, mission: ControlledMission, discovery: Task) {
  const operationId = `environment-prepare:${mission.planRevision}:${discovery.id}`;
  const [task] = await tx.select().from(schema.missionTasks).where(and(eq(schema.missionTasks.missionId, mission.id), eq(schema.missionTasks.operationId, operationId)));
  const [event] = await tx.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, operationId)));
  const spec = task?.spec;
  return !!(spec?.kind === 'environment_setup' && spec.phase === 'prepare' && task!.planRevision === mission.planRevision
    && task!.dependsOn.includes(discovery.id) && event?.payload.taskId === task!.id && event.payload.inspectionId === spec.inspectedRunId
    && event.payload.commit === spec.expectedCommit && discovery.sources.some(source => source.type === 'repository' && source.id === spec.inspectedRunId));
}
export async function planMissionEnvironment(tx: WorkspaceDatabase, mission: ControlledMission, discovery: Task, inspectionId: string, commit: string) {
  if (discovery.spec?.kind !== 'discovery' || discovery.spec.target.kind !== 'repository') throw createError({ statusCode: 409 });
  const operationId = `environment-prepare:${mission.planRevision}:${discovery.id}`;
  const [existing] = await tx.select().from(schema.missionTasks).where(and(eq(schema.missionTasks.missionId, mission.id), eq(schema.missionTasks.operationId, operationId)));
  if (existing) return existing;
  const spec = { kind: 'environment_setup' as const, phase: 'prepare' as const, repoUrl: discovery.spec.target.url, ref: discovery.spec.target.ref, inspectedRunId: inspectionId, expectedCommit: commit };
  const approvedPreparation = await findApprovedMissionPreparation(tx, mission, spec);
  const task = await addMissionTask(tx, mission, { operationId, title: 'Otto verifierar appens startplan', criterionIds: [], dependsOn: [discovery.id],
    spec: { ...spec, ...(approvedPreparation ? { approvedPreparation } : {}) } });
  await tx.update(schema.missionTasks).set({ criterionIds: [] }).where(eq(schema.missionTasks.id, discovery.id));
  await recordMissionEvent(tx, mission, 'environment.preparation_planned', { taskId: task.id, inspectionId, commit, ...(approvedPreparation ? { approvedPreparation } : {}) }, operationId);
  return task;
}

/** A saved, stopped preparation can ask once or reuse a previously explicit
 * matching grant. It never turns the model's list of variable names into consent. */
export async function planMissionEnvironmentApply(tx: WorkspaceDatabase, mission: ControlledMission, preparation: Task) {
  if (preparation.spec?.kind !== 'environment_setup' || preparation.spec.phase !== 'prepare' || preparation.state !== 'completed') return null;
  const operationId = `environment-apply:${mission.planRevision}:${preparation.id}`;
  const [existing] = await tx.select().from(schema.missionTasks).where(and(eq(schema.missionTasks.missionId, mission.id), eq(schema.missionTasks.operationId, operationId)));
  if (existing) return existing;
  const [source] = await tx.select().from(schema.setupJobs).where(and(inArray(schema.setupJobs.id, preparation.sources.filter(source => source.type === 'setup').map(source => source.id)), eq(schema.setupJobs.workspaceId, mission.workspaceId), eq(schema.setupJobs.runtime, runtimeScope())));
  const plan = source?.result?.environment;
  if (!source?.autonomy || source.autonomy.execution.missionId !== mission.id || source.autonomy.execution.taskId !== preparation.id
    || source.autonomy.environmentExecution.phase !== 'prepare' || !plan || source.result?.cleanup !== 'confirmed' || source.result.executorStopped !== true
    || plan.commit !== preparation.spec.expectedCommit || plan.repoUrl !== preparation.spec.repoUrl) throw createError({ statusCode: 409, statusMessage: 'En verifierad och avslutad startplan krävs.' });
  const planHash = environmentPlanHash(plan), mandate = currentMandate(mission);
  let consentId: string | undefined;
  for (const id of mandate.consentIds) {
    const [consent] = await tx.select().from(schema.environmentConsents).where(and(eq(schema.environmentConsents.id, id), eq(schema.environmentConsents.workspaceId, mission.workspaceId), eq(schema.environmentConsents.userId, mission.userId), eq(schema.environmentConsents.runtime, runtimeScope())));
    if (!consent || consent.planHash !== planHash || consent.revokedAt || consent.expiresAt <= await databaseNow(tx)) continue;
    try {
      await authorizeEnvironmentConsent(mission.userId, mission.workspaceId, { consentId: consent.id, consentRevision: consent.revision, vaultRevision: consent.vaultRevision, setupJobId: source.id, expectedPlanHash: planHash }, { connection: tx, deadline: mission.deadlineAt! });
      consentId = consent.id; break;
    } catch (error) { if ((error as { statusCode?: number }).statusCode !== 409) throw error; }
  }
  const task = await addMissionTask(tx, mission, { operationId, title: 'Starta den verifierade testmiljön', dependsOn: [preparation.id], criterionIds: [],
    spec: { kind: 'environment_setup', repoUrl: preparation.spec.repoUrl, ref: preparation.spec.ref, inspectedRunId: preparation.spec.inspectedRunId,
      expectedCommit: preparation.spec.expectedCommit, phase: 'apply', sourceSetupJobId: source.id, planHash, ...(consentId ? { consentId } : {}) } });
  if (!consentId && plan.variables.some(variable => variable.required)) await createMissionWait(tx, mission, { reason: 'configuration', taskIds: [task.id], setupJobId: source.id,
    question: `Testmiljön behöver ett medgivande för den verifierade startplanen. Kontrollera Vault och godkänn användning av: ${plan.variables.filter(variable => variable.required).map(variable => variable.name).join(', ')}. Oberoende arbete fortsätter under svarstiden.` });
  await recordMissionEvent(tx, mission, 'environment.apply_planned', { taskId: task.id, sourceSetupJobId: source.id, planHash, reusedConsent: consentId ?? null }, operationId);
  return task;
}

/** Retaining an HTTP-ready app is not a browser observation. Reserve a separate
 * browser task before planning, and keep the exact environment link server-owned. */
export async function planMissionEnvironmentPreview(tx: WorkspaceDatabase, mission: ControlledMission, application: Task) {
  if (application.spec?.kind !== 'environment_setup' || application.spec.phase !== 'apply' || application.state !== 'completed') return null;
  const operationId = `environment-preview:${mission.planRevision}:${application.id}`;
  const [existing] = await tx.select().from(schema.missionTasks).where(and(eq(schema.missionTasks.missionId, mission.id), eq(schema.missionTasks.operationId, operationId)));
  if (existing) return existing;
  const ids = application.sources.filter(source => source.type === 'setup').map(source => source.id);
  const [source] = ids.length ? await tx.select().from(schema.setupJobs).where(and(inArray(schema.setupJobs.id, ids), eq(schema.setupJobs.workspaceId, mission.workspaceId), eq(schema.setupJobs.runtime, runtimeScope()))) : [];
  if (!source?.autonomy || source.autonomy.execution.missionId !== mission.id || source.autonomy.execution.taskId !== application.id) throw createError({ statusCode: 409, statusMessage: 'Miljön saknar ett bundet startkvitto.' });
  const task = await addMissionTask(tx, mission, { operationId, title: 'Observera den isolerade appen före QA-planering', dependsOn: [application.id], spec: { kind: 'preview_discovery', setupJobId: source.id } });
  try { await readyMissionEnvironment(tx, mission, source.id); }
  catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 409) throw error;
    await tx.update(schema.missionTasks).set({ state: 'blocked', blockedReason: 'Testmiljöns aktuella mandat eller livstid räcker inte för browserobservation.', updatedAt: await databaseNow(tx) }).where(eq(schema.missionTasks.id, task.id));
    return task;
  }
  await recordMissionEvent(tx, mission, 'environment.ready', { setupJobId: source.id, taskId: application.id, previewTaskId: task.id }, `environment-ready:${mission.planRevision}`);
  return task;
}
