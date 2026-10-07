import { and, eq } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { executionAdmission, missionExecution, type MissionExecution } from '../../shared/mission-execution.mjs';
import { runtimeScope } from '../../shared/runtime-scope';
import { autonomyEnabled, currentMandate, lockMission, validateTaskMandate, type ControlledMission } from './mission-control';
import { databaseNow, type MissionAttempt } from './mission-attempts';
import { missionHash } from './mission-sources';
import { requireWorkspace, type WorkspaceDatabase } from './workspaces';
import { readyMissionEnvironment } from './mission-environment-scope';
import { previewReturnAuthority } from './mission-browser-return';
import { approvedMissionPreparation } from './mission-environment-reuse';

export function buildMissionExecution(mission: ControlledMission, attempt: MissionAttempt): MissionExecution {
  return missionExecution({ version: 1, runtime: mission.runtime, missionId: mission.id, taskId: attempt.taskId,
    attemptId: attempt.id, dispatchId: attempt.dispatchId, mandateRevision: attempt.mandateRevision,
    planRevision: attempt.planRevision, requestHash: attempt.requestHash, deadlineAt: attempt.deadlineAt.toISOString() });
}

/** The caller holds the mission lock, before any other resource/content locks.
 * This checks persisted authority, not controller liveness: executors can run
 * between bounded controller passes, but never across a revoked epoch.
 */
export async function requireMissionExecutor(tx: WorkspaceDatabase, binding: MissionExecution) {
  const execution = missionExecution(binding);
  const deny = () => createError({ statusCode: 409, statusMessage: 'Utföraren saknar ett aktuellt uppdragsmandat.' });
  if (execution.runtime !== runtimeScope() || !autonomyEnabled()) throw deny();
  const [mission] = await tx.select().from(schema.missions).where(and(eq(schema.missions.id, execution.missionId), eq(schema.missions.runtime, runtimeScope())));
  const [attempt] = await tx.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.id, execution.attemptId), eq(schema.missionAttempts.missionId, execution.missionId), eq(schema.missionAttempts.runtime, runtimeScope())));
  if (!mission || !attempt || mission.controllerVersion !== 1 || mission.status !== 'active' || !['running', 'waiting'].includes(mission.lifecycle!)
    || mission.mandateRevision !== execution.mandateRevision || mission.planRevision !== execution.planRevision
    || missionHash(buildMissionExecution(mission, attempt)) !== missionHash(execution)) throw deny();
  await requireWorkspace(mission.userId, mission.workspaceId, tx);
  const [task] = await tx.select().from(schema.missionTasks).where(and(eq(schema.missionTasks.id, attempt.taskId), eq(schema.missionTasks.missionId, mission.id)));
  const now = await databaseNow(tx), mandate = currentMandate(mission);
  if (!task?.spec || task.state !== 'running' || task.planRevision !== mission.planRevision || task.spec.kind !== attempt.kind
    || !['dispatching', 'dispatch_unknown', 'running'].includes(attempt.status) || attempt.cancelRequestedAt
    || attempt.deadlineAt <= now || !mission.deadlineAt || mission.deadlineAt <= now || mission.phase === 'report'
    || !mandate.allowedTaskKinds.includes(attempt.kind)
    || missionHash({ spec: task.spec, planRevision: mission.planRevision, mandateRevision: mission.mandateRevision }) !== attempt.requestHash) throw deny();
  const waits = await tx.select().from(schema.missionWaits).where(and(eq(schema.missionWaits.missionId, mission.id), eq(schema.missionWaits.state, 'waiting')));
  if (waits.some(wait => wait.definition.planRevision === mission.planRevision && wait.definition.taskIds.includes(task.id))) throw deny();
  await validateTaskMandate(tx, mission, task.spec);
  const approved = task.spec.kind === 'environment_setup' && task.spec.approvedPreparation
    ? await approvedMissionPreparation(tx, mission, task.spec, attempt.deadlineAt) : null;
  const confirmedNow = approved ? await databaseNow(tx) : now;
  if (attempt.deadlineAt <= confirmedNow || mission.deadlineAt! <= confirmedNow || approved && approved.validUntil <= confirmedNow) throw deny();
  return { mission, attempt, task, now: confirmedNow, authorizationUntil: approved?.validUntil };
}

/** Called by the private Linux executor after its local serialization gate and
 * immediately before an effect. Replays still recheck live authorization.
 * The executor journals uncertain effects; this receipt never authorizes
 * repeating an operation merely because its HTTP response was lost.
 */
export async function admitMissionExecutor(raw: unknown) {
  let input;
  try { input = executionAdmission(raw); }
  catch { throw createError({ statusCode: 400, statusMessage: 'Ogiltig utförarbindning.' }); }
  return db.transaction(async tx => {
    await lockMission(tx, input.execution.missionId);
    const { mission, attempt, task, now } = await requireMissionExecutor(tx, input.execution);
    const allowed = task.spec!.kind === 'discovery' && task.spec!.target.kind === 'repository'
      ? ['repository.inspect', 'repository.command']
      : task.spec!.kind === 'repository_check' ? [`repository.${task.spec!.mode}`, 'repository.command']
        : task.spec!.kind === 'environment_setup' ? (task.spec!.phase === 'apply' || task.spec!.approvedPreparation) ? ['sandbox.ensure', 'sandbox.command'] : ['sandbox.ensure', 'sandbox.command', 'codex.initialize', 'codex.turn', 'codex.tool']
          : ['preview_discovery', 'browser_tests'].includes(task.spec!.kind) ? ['environment.preview'] : [];
    if (!allowed.includes(input.kind)) throw createError({ statusCode: 403, statusMessage: 'Handlingen ingår inte i deluppgiften.' });
    const [claim] = await tx.select().from(schema.missionResourceClaims).where(and(eq(schema.missionResourceClaims.attemptId, attempt.id), eq(schema.missionResourceClaims.missionId, mission.id), eq(schema.missionResourceClaims.runtime, runtimeScope())));
    const preview = input.kind === 'environment.preview';
    if (!claim || claim.resourceKey !== (preview ? `browser:${mission.workspaceId}` : 'otto') || claim.owner !== 'agent' || claim.state !== 'claimed' || claim.workspaceId !== mission.workspaceId || claim.expiresAt <= now
      || attempt.executorResourceId !== input.resourceId || !preview && claim.executorResourceId !== input.resourceId) throw createError({ statusCode: 409, statusMessage: 'Utförarens resursanspråk gäller inte längre.' });
    if (preview) {
      const handoff = await previewReturnAuthority(tx, mission, attempt, false);
      if (handoff) {
        if (!handoff.intent || handoff.requestHash !== input.payloadHash || input.resourceId !== attempt.dispatchId
          || (input.operationId !== `preview:handoff:${handoff.receipt.waitId}` && !(input.operationId === 'preview:session' && handoff.ack))) throw createError({ statusCode: 409, statusMessage: 'Previewns återlämning saknar exakt aktuell behörighet.' });
      } else {
      const [intent] = await tx.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, `preview-intent:${attempt.id}`)));
      if (!['preview:create', 'preview:network', 'preview:session'].includes(input.operationId)) throw createError({ statusCode: 403, statusMessage: 'Okänd previewhandling.' });
      if (!intent || intent.payload.requestHash !== input.payloadHash || typeof intent.payload.setupJobId !== 'string') throw createError({ statusCode: 409, statusMessage: 'Previewn saknar sin oförändrade sparade startavsikt.' });
      const [opened] = await tx.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, `preview-opened:${attempt.id}`)));
      const payload = intent.payload.payload as { sandboxId?: unknown } | undefined;
      // Dispatch identifies the worker request. Once known, the separate claim
      // identifies its physical browser, attested by the immutable open receipt.
      // An unacknowledged start keeps a null claim; it is never a stop receipt.
      if (input.resourceId !== attempt.dispatchId || claim.leaseToken !== attempt.leaseToken || claim.fence !== attempt.fence
        || (opened ? opened.payload.attemptId !== attempt.id || opened.payload.requestHash !== input.payloadHash
          || !payload || typeof payload.sandboxId !== 'string' || opened.payload.sandboxId !== payload.sandboxId
          || typeof opened.payload.sessionId !== 'string' || !opened.payload.sessionId || claim.executorResourceId !== opened.payload.sessionId
          : claim.executorResourceId !== null)) throw createError({ statusCode: 409, statusMessage: 'Previewns fysiska session motsvarar inte dess sparade startkvitto.' });
      await readyMissionEnvironment(tx, mission, intent.payload.setupJobId);
      }
    }
    const callKey = missionHash({ executor: input.resourceId, operationId: input.operationId });
    const operationKey = `${callKey}:${missionHash({ kind: input.kind, payloadHash: input.payloadHash })}`;
    const previous = attempt.toolCallIds.find(id => id.startsWith(`${callKey}:`));
    if (previous && previous !== operationKey) throw createError({ statusCode: 409, statusMessage: 'Utförarens operation ändrades vid återförsök.' });
    if (!previous) {
      if (attempt.toolCalls >= attempt.reservedToolCalls) throw createError({ statusCode: 409, statusMessage: 'Utförarens verktygsbudget är förbrukad.' });
      await tx.update(schema.missionAttempts).set({ toolCalls: attempt.toolCalls + 1, toolCallIds: [...attempt.toolCallIds, operationKey], updatedAt: now }).where(eq(schema.missionAttempts.id, attempt.id));
    }
    // Environment/Vault validation can wait on another transaction. A receipt
    // must use fresh time after those locks, never the earlier admission read.
    const confirmed = await requireMissionExecutor(tx, input.execution);
    if (claim.expiresAt <= confirmed.now) throw createError({ statusCode: 409, statusMessage: 'Utförarens resursanspråk har löpt ut.' });
    return { allowed: true as const, attemptId: attempt.id, dispatchId: attempt.dispatchId, resourceId: input.resourceId,
      operationId: input.operationId, kind: input.kind, payloadHash: input.payloadHash,
      validUntil: new Date(Math.min(confirmed.now.getTime() + 5_000, attempt.deadlineAt.getTime(), mission.deadlineAt!.getTime(), claim.expiresAt.getTime(), confirmed.authorizationUntil?.getTime() ?? Infinity)).toISOString() };
  });
}
