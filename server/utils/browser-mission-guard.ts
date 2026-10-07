import { createHash } from 'node:crypto';
import { browserAttemptAssignment, previewReturnAuthority } from './mission-browser-return';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import type { BrowserAction } from '../../shared/browser';
import { runtimeScope } from '../../shared/runtime-scope';
import { activeAttemptStates, autonomyEnabled, currentMandate, lockMission, validateTaskMandate } from './mission-control';
import { authorizeMissionOperation, databaseNow } from './mission-attempts';
import { requireWorkspace, type WorkspaceDatabase } from './workspaces';
import { readyMissionEnvironment } from './mission-environment-scope';
import { assertBrowserLock, browserLockSignal } from './browser-lock';

/** Authenticated Eve context, absent from the model's tool schema. */
export type BrowserActor = { browserJobId?: string; executorSessionId?: string; callId?: string };
export type BrowserPolicy = { version: 1; allowedOrigins: string[]; readOnly: true; deadlineAt: string };
export type BrowserExecution = { attemptId: string; dispatchId: string };
export function policyDigest(policy: BrowserPolicy) {
  return createHash('sha256').update(JSON.stringify({ ...policy, allowedOrigins: [...policy.allowedOrigins].sort() })).digest('hex');
}

/** Persist the provider-created session before CDP work. The caller already
 * holds the assignment's browser lock; only then may this short transaction
 * acquire the mission lock. Binding is not a new operation or a stop receipt. */
export async function bindBrowserPhysicalSession(userId: string, workspaceId: string, threadId: string, agentId: string, actor: BrowserActor, execution: BrowserExecution, physicalSessionId: string, policy: BrowserPolicy) {
  const denied = () => createError({ statusCode: 409, statusMessage: 'Webbläsarsessionen saknar ett aktuellt, entydigt resursanspråk.' });
  if (!browserLockSignal() || !physicalSessionId || actor.browserJobId !== execution.dispatchId || !actor.executorSessionId || actor.executorSessionId !== agentId) throw denied();
  await assertBrowserLock();
  const [initial] = await db.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.id, execution.attemptId), eq(schema.missionAttempts.runtime, runtimeScope())));
  if (!initial) throw denied();
  return db.transaction(async tx => {
    await lockMission(tx, initial.missionId);
    const [mission] = await tx.select().from(schema.missions).where(and(eq(schema.missions.id, initial.missionId), eq(schema.missions.userId, userId), eq(schema.missions.workspaceId, workspaceId), eq(schema.missions.runtime, runtimeScope())));
    if (!mission) throw denied();
    await requireWorkspace(userId, workspaceId, tx);
    const [attempt] = await tx.select().from(schema.missionAttempts).where(eq(schema.missionAttempts.id, initial.id));
    const now = await databaseNow(tx), mandate = currentMandate(mission);
    if (!autonomyEnabled() || !attempt || attempt.runtime !== runtimeScope() || attempt.kind !== 'browser_tests' || attempt.dispatchId !== execution.dispatchId
      || !activeAttemptStates.includes(attempt.status) || attempt.cancelRequestedAt || !['running', 'waiting'].includes(mission.lifecycle!)
      || attempt.mandateRevision !== mission.mandateRevision || attempt.planRevision !== mission.planRevision || attempt.deadlineAt <= now
      || !mission.deadlineAt || mission.deadlineAt <= now || !mandate.allowedTaskKinds.includes('browser_tests')) throw denied();
    const [task] = await tx.select().from(schema.missionTasks).where(and(eq(schema.missionTasks.id, attempt.taskId), eq(schema.missionTasks.missionId, mission.id)));
    if (task?.state !== 'running' || task.planRevision !== mission.planRevision || task.spec?.kind !== 'browser_tests') throw denied();
    await validateTaskMandate(tx, mission, task.spec);
    const waits = await tx.select().from(schema.missionWaits).where(and(eq(schema.missionWaits.missionId, mission.id), eq(schema.missionWaits.state, 'waiting')));
    if (waits.some(wait => wait.definition.planRevision === mission.planRevision && wait.definition.taskIds.includes(task.id))) throw denied();
    const [job] = await tx.select().from(schema.browserJobs).where(and(eq(schema.browserJobs.id, execution.dispatchId), eq(schema.browserJobs.threadId, threadId), eq(schema.browserJobs.runtime, runtimeScope())));
    if (!job || job.sessionId !== agentId || !['running', 'dispatch_unknown'].includes(job.status)) throw denied();
    const assignment = await browserAttemptAssignment(tx, mission, attempt, agentId);
    const transferred = await previewReturnAuthority(tx, mission, attempt, true);
    const digest = policyDigest(policy);
    const boundDigest = assignment?.projectId?.startsWith('vps-preview-policy-v1:') ? assignment.projectId.split(':')[2]
      : assignment?.projectId?.startsWith('self-hosted-policy-v1:') ? assignment.projectId.slice('self-hosted-policy-v1:'.length) : undefined;
    if (!assignment || assignment.sessionId !== physicalSessionId || assignment.control !== 'agent' || !assignment.expiresAt || assignment.expiresAt <= now || boundDigest !== digest
      || policy.version !== 1 || policy.readOnly !== true || JSON.stringify([...policy.allowedOrigins].sort()) !== JSON.stringify([...mandate.allowedOrigins].sort())
      || !Number.isFinite(Date.parse(policy.deadlineAt)) || Date.parse(policy.deadlineAt) <= now.getTime()
      || (transferred ? policyDigest(transferred.creation.payload.policy) !== digest
        : Date.parse(policy.deadlineAt) > Math.min(attempt.deadlineAt.getTime(), mission.deadlineAt.getTime()))) throw denied();
    const claims = await tx.select().from(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, attempt.id)).for('update');
    const claim = claims[0];
    if (claims.length !== 1 || !claim || claim.missionId !== mission.id || claim.workspaceId !== workspaceId || claim.runtime !== runtimeScope()
      || claim.resourceKey !== `browser:${workspaceId}` || claim.owner !== 'agent' || claim.state !== 'claimed'
      || claim.leaseToken !== attempt.leaseToken || claim.fence !== attempt.fence || claim.expiresAt <= now
      || claim.executorResourceId && claim.executorResourceId !== physicalSessionId) throw denied();
    await assertBrowserLock();
    if (!claim.executorResourceId) await tx.update(schema.missionResourceClaims).set({ executorResourceId: physicalSessionId, updatedAt: now }).where(eq(schema.missionResourceClaims.id, claim.id));
    return { sessionId: physicalSessionId };
  });
}

/** Called inside the browser lock immediately before each operation. A job ID
 * cannot choose its attempt, and an old executor session cannot adopt a retry. */
export async function guardBrowserOperation(connection: WorkspaceDatabase, userId: string, workspaceId: string, threadId: string, agentId: string, input: BrowserAction, actor: BrowserActor = {}, physicalSessionId?: string | null) {
  const [run] = input.runId ? await connection.select().from(schema.testRuns).where(and(eq(schema.testRuns.id, input.runId), eq(schema.testRuns.workspaceId, workspaceId), eq(schema.testRuns.threadId, threadId))) : [];
  if (input.runId && !run) throw createError({ statusCode: 404, statusMessage: 'Testkörningen finns inte i den här chatten.' });
  if (!actor.browserJobId) {
    if (run?.missionAttemptId) throw createError({ statusCode: 403, statusMessage: 'Ett autonomt test kräver sin ursprungliga utförare.' });
    return null;
  }
  const [job] = await connection.select().from(schema.browserJobs).where(and(eq(schema.browserJobs.id, actor.browserJobId), eq(schema.browserJobs.threadId, threadId), eq(schema.browserJobs.runtime, runtimeScope())));
  if (!job || !actor.executorSessionId || job.sessionId !== actor.executorSessionId || agentId !== actor.executorSessionId) throw createError({ statusCode: 403, statusMessage: 'Webbläsaranropet saknar rätt Iris-session.' });
  const [origin] = await connection.select({ attempt: schema.missionAttempts, mission: schema.missions }).from(schema.missionAttempts)
    .innerJoin(schema.missions, eq(schema.missionAttempts.missionId, schema.missions.id))
    .where(and(eq(schema.missionAttempts.dispatchId, job.id), eq(schema.missionAttempts.runtime, runtimeScope()), eq(schema.missions.runtime, runtimeScope()), eq(schema.missions.workspaceId, workspaceId), eq(schema.missions.userId, userId)));
  if (!origin) {
    if (run?.missionAttemptId) throw createError({ statusCode: 403, statusMessage: 'Testet tillhör ett annat körförsök.' });
    return null;
  }
  const { attempt, mission } = origin;
  if (!actor.callId || attempt.kind !== 'browser_tests' || !['running', 'dispatch_unknown'].includes(job.status) || input.sessionId) throw createError({ statusCode: 403, statusMessage: 'Otillåten autonom webbläsaroperation.' });
  // An expired/missing view must not create a replacement before the binding
  // check below. A new physical session requires a separately admitted attempt.
  const [claim] = await connection.select().from(schema.missionResourceClaims).where(and(eq(schema.missionResourceClaims.attemptId, attempt.id), eq(schema.missionResourceClaims.runtime, runtimeScope())));
  if (input.action !== 'close' && claim?.executorResourceId && claim.executorResourceId !== physicalSessionId) throw createError({ statusCode: 409, statusMessage: 'Försökets ursprungliga webbläsarsession är inte tillgänglig. Spara avbrottet; en ny session kräver ett nytt körförsök.' });
  if (run && (run.missionAttemptId !== attempt.id || run.runtime !== runtimeScope() || run.finishedAt || run.snapshot.type !== 'browser')) throw createError({ statusCode: 403, statusMessage: 'Testkörningen tillhör inte det aktiva körförsöket.' });
  if (!run && !['inspect', 'close'].includes(input.action)) throw createError({ statusCode: 409, statusMessage: 'Starta ett testfall och ange dess runId på varje webbläsarhandling.' });
  const entry = run?.snapshot.entryUrl ? { runId: run.id, url: new URL(run.snapshot.entryUrl).href, receipt: run.browserEntryReceipt } : null;
  if (entry && !['inspect', 'close'].includes(input.action)) {
    if (entry.receipt && entry.receipt.sessionId !== physicalSessionId) throw createError({ statusCode: 409, statusMessage: 'Testets ursprungliga webbläsarsession är inte tillgänglig. Spara avbrottet och starta en ny testkörning; återställ inte ett påbörjat flöde tyst.' });
    if (!entry.receipt) {
      let requested: string | undefined;
      try { requested = input.url && new URL(input.url).href; } catch { /* Rejected below. */ }
      if (input.action !== 'open' || requested !== entry.url) throw createError({ statusCode: 409, statusMessage: `Öppna först testfallets startadress ${entry.url} med samma runId. Inspektion kan användas efter fel; den ersätter inte startnavigeringen.` });
    }
  }
  const mandate = currentMandate(mission);
  const allowedOrigins = [...mandate.allowedOrigins].sort();
  for (const raw of [input.action === 'open' ? input.url : undefined, input.expectedUrl].filter((value): value is string => !!value)) {
    let url: URL;
    try { url = new URL(raw.includes('://') ? raw : `https://${raw}`); } catch { throw createError({ statusCode: 400, statusMessage: 'Ogiltig testadress.' }); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !allowedOrigins.includes(url.origin)) throw createError({ statusCode: 403, statusMessage: 'Adressen ligger utanför uppdragets mål.' });
  }
  const authorization = await authorizeMissionOperation({ userId, workspaceId, attemptId: attempt.id, dispatchId: attempt.dispatchId, callId: actor.callId, tool: 'browser', input });
  let environmentDeadline = Infinity;
  let preview = false;
  if (mission.admission?.target?.kind === 'repository') {
    const [ready] = await connection.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, `environment-ready:${mission.planRevision}`)));
    if (typeof ready?.payload.setupJobId !== 'string') throw createError({ statusCode: 409, statusMessage: 'Uppdragets verifierade preview saknas.' });
    // Release mission/Vault locks before preview/heartbeat HTTP calls back into
    // the app. The outer browser-assignment transaction lasts across CDP work.
    const setupJobId = ready.payload.setupJobId;
    const env = await db.transaction(tx => readyMissionEnvironment(tx, mission, setupJobId));
    environmentDeadline = env.deadlineAt.getTime(); preview = true;
  }
  const deadlineAt = new Date(Math.min(attempt.deadlineAt.getTime(), mission.deadlineAt!.getTime(), environmentDeadline)).toISOString();
  const transferred = preview ? await db.transaction(tx => previewReturnAuthority(tx, mission, attempt, true)) : null;
  const policy: BrowserPolicy = transferred?.creation.payload.policy ?? { version: 1, allowedOrigins, readOnly: true, deadlineAt };
  return { execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId }, policy, policyDigest: policyDigest(policy), replay: authorization.replay, callId: actor.callId, browserJobId: job.id, entry, preview };
}
