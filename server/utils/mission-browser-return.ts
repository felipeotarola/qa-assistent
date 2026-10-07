import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@nuxthub/db';
import { browserReturnCases, browserReturnReceiptSchema, type BrowserReturnReceipt } from '../../shared/mission-browser-return';
import type { BrowserSessionContext } from '../../shared/result-assessment';
import { runtimeScope } from '../../shared/runtime-scope';
import { canonicalExecutionPayload, missionExecution } from '../../shared/mission-execution.mjs';
import { previewPolicy, previewEnvironment, previewHandoff, previewHandoffHash, matchPreviewHandoffReceipt } from '../../shared/preview-handoff.mjs';
import { missionHash } from './mission-sources';
import { readyMissionEnvironment } from './mission-environment-scope';
import { sandboxScope } from './sandbox-scope';
import { validateMissionComplement } from './mission-complements';
import { browserTakeoverContinuation } from './mission-browser-takeover';
import type { WorkspaceDatabase } from './workspaces';
import { recordMissionEvent, type ControlledMission } from './mission-control';

type Attempt = typeof schema.missionAttempts.$inferSelect;
type Task = typeof schema.missionTasks.$inferSelect;
const denied = () => createError({ statusCode: 409, statusMessage: 'Den återlämnade webbläsaren saknar ett giltigt fortsatt körmandat.' });
const receiptKey = (id: string) => `browser-returned:${id}`;
const handoffKey = (id: string) => `browser-return-handoff:${id}`;
const canonicalHash = (value: unknown) => createHash('sha256').update(canonicalExecutionPayload(value)).digest('hex');
const executionOf = (attempt: Attempt) => missionExecution({ version: 1, runtime: attempt.runtime, missionId: attempt.missionId, taskId: attempt.taskId,
  attemptId: attempt.id, dispatchId: attempt.dispatchId, mandateRevision: attempt.mandateRevision, planRevision: attempt.planRevision,
  requestHash: attempt.requestHash, deadlineAt: attempt.deadlineAt.toISOString() });
async function now(connection: WorkspaceDatabase) {
  const [row] = await connection.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
  return new Date(row!.now);
}

/** Resolve only a server-persisted assignment alias. Keep its original agentId
 * and browser lock key unchanged; the new Eve identity is checked separately. */
export async function browserAttemptAssignment(connection: WorkspaceDatabase, mission: ControlledMission, attempt: Attempt, agentId?: string | null) {
  if (attempt.missionId !== mission.id || attempt.runtime !== mission.runtime) throw denied();
  const [event] = await connection.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, handoffKey(attempt.id))));
  if (event) {
    const parsed = browserReturnReceiptSchema.safeParse(event.payload.receipt);
    if (!parsed.success || event.payload.attemptId !== attempt.id || event.payload.dispatchId !== attempt.dispatchId
      || parsed.data.taskId !== attempt.taskId || parsed.data.runtime !== attempt.runtime || parsed.data.requestHash !== attempt.requestHash
      || parsed.data.planRevision !== attempt.planRevision || parsed.data.mandateRevision !== attempt.mandateRevision
      || Date.parse(parsed.data.deadlineAt) < attempt.deadlineAt.getTime()) throw denied();
    const [assignment] = await connection.select().from(schema.browserAssignments).where(and(eq(schema.browserAssignments.id, parsed.data.assignmentId), eq(schema.browserAssignments.workspaceId, mission.workspaceId), eq(schema.browserAssignments.userId, mission.userId), eq(schema.browserAssignments.threadId, mission.threadId)));
    // A cleared assignment may be read for cleanup. A replacement session is
    // never adopted, even for historical cleanup or another human answer.
    if (!assignment || assignment.sessionId && assignment.sessionId !== parsed.data.physicalSessionId) throw denied();
    return assignment;
  }
  if (!agentId) return undefined;
  const [assignment] = await connection.select().from(schema.browserAssignments).where(and(eq(schema.browserAssignments.workspaceId, mission.workspaceId), eq(schema.browserAssignments.userId, mission.userId), eq(schema.browserAssignments.threadId, mission.threadId), eq(schema.browserAssignments.agentId, agentId)));
  return assignment;
}

export async function browserActorAssignment(connection: WorkspaceDatabase, userId: string, threadId: string, agentId: string, actor: { browserJobId?: string; executorSessionId?: string }) {
  if (!actor.browserJobId) return undefined;
  const [job] = await connection.select().from(schema.browserJobs).where(and(eq(schema.browserJobs.id, actor.browserJobId), eq(schema.browserJobs.runtime, runtimeScope()), eq(schema.browserJobs.threadId, threadId)));
  if (!job || job.sessionId !== agentId || actor.executorSessionId !== agentId) throw denied();
  const [origin] = await connection.select({ attempt: schema.missionAttempts, mission: schema.missions }).from(schema.missionAttempts)
    .innerJoin(schema.missions, eq(schema.missionAttempts.missionId, schema.missions.id))
    .where(and(eq(schema.missionAttempts.dispatchId, job.id), eq(schema.missionAttempts.runtime, runtimeScope()), eq(schema.missions.runtime, runtimeScope()), eq(schema.missions.userId, userId), eq(schema.missions.threadId, threadId)));
  if (!origin) return undefined;
  await previewReturnAuthority(connection, origin.mission, origin.attempt, true);
  return browserAttemptAssignment(connection, origin.mission, origin.attempt, agentId);
}

/** Read immutable creation identity even after revocation. Callers that grant
 * work must separately require live environment and the current claim. */
export async function previewCreation(connection: WorkspaceDatabase, mission: ControlledMission, attempt: Attempt) {
  const [transferred] = await connection.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, handoffKey(attempt.id))));
  const receipt = transferred ? browserReturnReceiptSchema.parse(transferred.payload.receipt) : null;
  if (transferred && (transferred.payload.attemptId !== attempt.id || transferred.payload.dispatchId !== attempt.dispatchId || !receipt?.preview)) throw denied();
  const creationId = receipt?.preview?.creationAttemptId ?? attempt.id;
  const [creator] = await connection.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.id, creationId), eq(schema.missionAttempts.missionId, mission.id), eq(schema.missionAttempts.runtime, mission.runtime)));
  const [intent] = await connection.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, `preview-intent:${creationId}`)));
  const [opened] = await connection.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, `preview-opened:${creationId}`)));
  if (!creator || !intent || typeof intent.payload.setupJobId !== 'string' || creator.taskId !== attempt.taskId
    || creator.planRevision !== attempt.planRevision || creator.mandateRevision !== attempt.mandateRevision) throw denied();
  const raw = intent.payload.payload as { sandboxId: string; port: number; execution: unknown; policy: unknown; expectedEnvironment: unknown };
  if (!raw || Object.keys(raw).length !== 5) throw denied();
  const payload = { sandboxId: raw.sandboxId, port: raw.port, execution: missionExecution(raw.execution),
    policy: previewPolicy(raw.policy, raw.port), expectedEnvironment: previewEnvironment(raw.expectedEnvironment) };
  if (canonicalHash(payload.execution) !== canonicalHash(executionOf(creator)) || canonicalHash(payload) !== intent.payload.requestHash
    || payload.expectedEnvironment.jobId !== intent.payload.setupJobId || Date.parse(payload.policy.deadlineAt) > creator.deadlineAt.getTime()
    || !opened || opened.payload.attemptId !== creator.id || opened.payload.requestHash !== intent.payload.requestHash
    || opened.payload.sandboxId !== payload.sandboxId || typeof opened.payload.sessionId !== 'string'
    || receipt && (receipt.preview!.creationRequestHash !== intent.payload.requestHash || receipt.preview!.setupJobId !== intent.payload.setupJobId
      || receipt.preview!.sandboxId !== payload.sandboxId || receipt.physicalSessionId !== opened.payload.sessionId)) throw denied();
  return { creator, payload, requestHash: intent.payload.requestHash as string, setupJobId: intent.payload.setupJobId, sessionId: opened.payload.sessionId, receipt };
}

/** Current handoff authority, reused before callback, alias/tool use and ack
 * persistence. No network calls, and no adoption from a runner's session cache. */
export async function previewReturnAuthority(connection: WorkspaceDatabase, mission: ControlledMission, attempt: Attempt, requireAck: boolean, returning = false) {
  const [event] = await connection.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, handoffKey(attempt.id))));
  if (!event) return null;
  const receipt = browserReturnReceiptSchema.parse(event.payload.receipt);
  if (!receipt.preview) return null;
  const clock = await now(connection);
  if (mission.admission?.target?.kind !== 'repository' || receipt.runtime !== mission.runtime || attempt.runtime !== mission.runtime
    || event.payload.attemptId !== attempt.id || event.payload.dispatchId !== attempt.dispatchId || receipt.taskId !== attempt.taskId
    || receipt.requestHash !== attempt.requestHash || receipt.planRevision !== attempt.planRevision || receipt.mandateRevision !== attempt.mandateRevision
    || attempt.planRevision !== mission.planRevision || attempt.mandateRevision !== mission.mandateRevision
    || attempt.deadlineAt <= clock || attempt.deadlineAt.getTime() > Date.parse(receipt.deadlineAt) || attempt.cancelRequestedAt) throw denied();
  const [source] = await connection.select().from(schema.missionAttempts).where(eq(schema.missionAttempts.id, receipt.sourceAttemptId));
  const [wait] = await connection.select().from(schema.missionWaits).where(eq(schema.missionWaits.id, receipt.waitId));
  const [job] = await connection.select().from(schema.browserJobs).where(eq(schema.browserJobs.id, receipt.sourceDispatchId));
  if (!source || source.missionId !== mission.id || source.runtime !== receipt.runtime || source.taskId !== attempt.taskId || source.dispatchId !== receipt.sourceDispatchId
    || source.requestHash !== attempt.requestHash || source.mandateRevision !== attempt.mandateRevision || source.planRevision !== attempt.planRevision
    || source.deadlineAt.toISOString() !== receipt.deadlineAt || source.cancelRequestedAt || !source.finishedAt || !['completed', 'failed'].includes(source.status)
    || !job?.sessionId || job.runtime !== receipt.runtime || job.threadId !== mission.threadId || !['completed', 'failed'].includes(job.status)
    || !wait || wait.missionId !== mission.id || wait.state !== 'answered' || wait.definition.reason !== 'human_browser'
    || wait.definition.planRevision !== attempt.planRevision || wait.definition.mandateRevision !== attempt.mandateRevision
    || wait.definition.taskIds.length !== 1 || wait.definition.taskIds[0] !== attempt.taskId || wait.answer?.kind !== 'browser_returned'
    || wait.answer.sessionId !== receipt.physicalSessionId || !wait.answeredAt || source.createdAt > wait.createdAt || wait.answeredAt < wait.createdAt || wait.answeredAt >= wait.deadlineAt) throw denied();
  const creation = await previewCreation(connection, mission, attempt);
  const [task] = await connection.select().from(schema.missionTasks).where(and(eq(schema.missionTasks.id, attempt.taskId), eq(schema.missionTasks.missionId, mission.id)));
  if (!task?.spec || task.spec.kind !== 'browser_tests' || task.planRevision !== mission.planRevision
    || missionHash({ spec: task.spec, planRevision: mission.planRevision, mandateRevision: mission.mandateRevision }) !== attempt.requestHash) throw denied();
  if (!returning) await validateMissionComplement(connection, mission, task);
  const env = await readyMissionEnvironment(connection, mission, creation.setupJobId);
  const scope = sandboxScope(mission.userId, env.job.threadId, env.job.sessionKey);
  const assignment = await browserAttemptAssignment(connection, mission, attempt);
  const [claim] = await connection.select().from(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, attempt.id));
  // Terminal settlement clears the worker lease, but retains the exact physical
  // claim while the human controls the browser. This historical return check
  // does not authorize a tool or another attempt; ordinary reservation does.
  const settledReturn = returning && ['completed', 'failed'].includes(attempt.status)
    && !!attempt.finishedAt && attempt.leaseToken === null && attempt.leaseUntil === null;
  if (env.deadlineAt < attempt.deadlineAt || scope.id !== creation.payload.sandboxId || env.config.planHash !== creation.payload.expectedEnvironment.planHash
    || env.plan.processId !== creation.payload.expectedEnvironment.processId || env.plan.port !== creation.payload.port
    || !assignment || assignment.id !== receipt.assignmentId || assignment.sessionId !== receipt.physicalSessionId || assignment.control !== 'agent'
    || !assignment.expiresAt || assignment.expiresAt <= clock || assignment.projectId !== `vps-preview-policy-v1:${scope.id}:${receipt.policyDigest}`
    || JSON.stringify(creation.payload.policy.allowedOrigins) !== JSON.stringify(mission.mandate!.allowedOrigins)
    || !claim || claim.id !== receipt.claimId || claim.missionId !== mission.id || claim.runtime !== mission.runtime || claim.workspaceId !== mission.workspaceId
    || claim.resourceKey !== `browser:${mission.workspaceId}` || !(returning ? ['agent', 'human'].includes(claim.owner) : claim.owner === 'agent') || claim.state !== 'claimed' || claim.expiresAt <= clock
    || !settledReturn && claim.leaseToken !== attempt.leaseToken || claim.fence !== attempt.fence || claim.executorResourceId !== receipt.physicalSessionId) throw denied();
  const input = previewHandoff({ version: 1, handoffId: receipt.waitId, sandboxId: scope.id, sessionId: receipt.physicalSessionId,
    creationRequestHash: creation.requestHash, previousExecution: executionOf(source), execution: executionOf(attempt),
    policy: creation.payload.policy, expectedEnvironment: creation.payload.expectedEnvironment, port: creation.payload.port });
  if (createHash('sha256').update(JSON.stringify(input.policy)).digest('hex') !== receipt.policyDigest) throw denied();
  const requestHash = previewHandoffHash(input);
  const [intent] = await connection.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, `preview-handoff-intent:${attempt.id}`)));
  const [ack] = await connection.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, `preview-handoff-ack:${attempt.id}`)));
  if (intent && (intent.payload.requestHash !== requestHash || canonicalHash(intent.payload.payload) !== requestHash)) throw denied();
  const confirmed = ack ? matchPreviewHandoffReceipt(ack.payload.receipt, input, receipt.policyDigest) : null;
  if (requireAck && (!intent || !confirmed)) throw denied();
  if (attempt.deadlineAt <= await now(connection)) throw denied();
  return { receipt, creation, scope, input, requestHash, intent, ack: confirmed, assignment };
}

/** Called inside the existing answer transaction and browser try-lock. */
export async function recordBrowserReturn(connection: WorkspaceDatabase, mission: ControlledMission, task: Task, attempt: Attempt, wait: typeof schema.missionWaits.$inferSelect, assignment: typeof schema.browserAssignments.$inferSelect, claim: typeof schema.missionResourceClaims.$inferSelect) {
  const preview = assignment.projectId?.startsWith('vps-preview-policy-v1:');
  if (!preview && (mission.admission?.target?.kind !== 'public_url' || !assignment.projectId?.startsWith('self-hosted-policy-v1:'))) return;
  const creation = preview ? await previewCreation(connection, mission, attempt) : null;
  if (creation) {
    const env = await readyMissionEnvironment(connection, mission, creation.setupJobId);
    if (mission.admission?.target?.kind !== 'repository' || creation.sessionId !== assignment.sessionId || env.deadlineAt <= await now(connection)) throw denied();
    await previewReturnAuthority(connection, mission, attempt, true, true);
  }
  const [lastRun] = await connection.select().from(schema.testRuns).where(eq(schema.testRuns.missionAttemptId, attempt.id)).orderBy(desc(schema.testRuns.startedAt)).limit(1);
  const blockedRunId = lastRun && lastRun.startedAt <= wait.createdAt && (!lastRun.result || ['blocked', 'interrupted'].includes(lastRun.result.outcome)) ? lastRun.id : null;
  // wait.createdAt is PostgreSQL transaction-start time, which can precede
  // the acknowledged takeover. Mission-lock publication order binds the
  // takeover to this later returned event; wall-clock tolerance is not used.
  const humanTakeover = await browserTakeoverContinuation(connection, mission, task, attempt, assignment, claim, await now(connection), false);
  const receipt = browserReturnReceiptSchema.parse({ version: 1, waitId: wait.id, sourceAttemptId: attempt.id, sourceDispatchId: attempt.dispatchId,
    taskId: task.id, assignmentId: assignment.id, physicalSessionId: assignment.sessionId, claimId: claim.id,
    runtime: attempt.runtime, planRevision: attempt.planRevision, mandateRevision: attempt.mandateRevision, requestHash: attempt.requestHash,
    policyDigest: preview ? assignment.projectId!.split(':')[2] : assignment.projectId!.slice('self-hosted-policy-v1:'.length), deadlineAt: attempt.deadlineAt.toISOString(), blockedRunId,
    ...(humanTakeover ? { humanTakeover } : {}),
    ...(creation ? { preview: { creationAttemptId: creation.creator.id, creationRequestHash: creation.requestHash, setupJobId: creation.setupJobId, sandboxId: creation.payload.sandboxId } } : {}) });
  await recordMissionEvent(connection, mission, 'browser_returned', { receipt }, receiptKey(wait.id));
}

/** Must run under the mission lock. No HTTP or physical effects. An invalid
 * returned-session intent never falls through to an ordinary fresh browser. */
export async function pendingBrowserReturn(connection: WorkspaceDatabase, mission: ControlledMission, task: Task) {
  if (task.spec?.kind !== 'browser_tests' || !['pending', 'ready'].includes(task.state!)) return null;
  const waits = await connection.select().from(schema.missionWaits).where(and(eq(schema.missionWaits.missionId, mission.id), eq(schema.missionWaits.state, 'answered'))).orderBy(desc(schema.missionWaits.answeredAt));
  const wait = waits.find(row => row.definition.reason === 'human_browser' && row.definition.taskIds.length === 1 && row.definition.taskIds[0] === task.id && row.definition.planRevision === mission.planRevision && row.definition.mandateRevision === mission.mandateRevision && row.answer?.kind === 'browser_returned');
  if (!wait) return null;
  const [event] = await connection.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, receiptKey(wait.id))));
  const parsed = browserReturnReceiptSchema.safeParse(event?.payload.receipt);
  if (!parsed.success) throw denied();
  const receipt = parsed.data, clock = await now(connection);
  if (receipt.waitId !== wait.id || receipt.taskId !== task.id || receipt.runtime !== runtimeScope()
    || receipt.planRevision !== mission.planRevision || receipt.mandateRevision !== mission.mandateRevision
    || receipt.requestHash !== missionHash({ spec: task.spec, planRevision: mission.planRevision, mandateRevision: mission.mandateRevision })
    || !wait.answeredAt || wait.answeredAt < wait.createdAt || wait.answeredAt >= wait.deadlineAt || wait.answer?.kind !== 'browser_returned' || wait.answer.sessionId !== receipt.physicalSessionId
    || process.env.MISSIONS_ENABLED === 'false' || process.env.AUTONOMOUS_MISSIONS_ENABLED !== 'true'
    || mission.admission?.target?.kind !== (receipt.preview ? 'repository' : 'public_url') || !['running', 'waiting'].includes(mission.lifecycle!) || mission.phase === 'report'
    || !mission.deadlineAt || mission.deadlineAt <= clock || Date.parse(receipt.deadlineAt) <= clock.getTime()) throw denied();
  const attempts = await connection.select().from(schema.missionAttempts).where(eq(schema.missionAttempts.taskId, task.id)).orderBy(desc(schema.missionAttempts.attemptNo));
  const source = attempts[0];
  if (!source || source.id !== receipt.sourceAttemptId || source.dispatchId !== receipt.sourceDispatchId || source.runtime !== receipt.runtime
    || source.missionId !== mission.id || source.requestHash !== receipt.requestHash || source.createdAt > wait.createdAt || source.cancelRequestedAt
    || source.planRevision !== receipt.planRevision || source.mandateRevision !== receipt.mandateRevision || source.deadlineAt.toISOString() !== receipt.deadlineAt
    || !['reserved', 'dispatching', 'dispatch_unknown', 'running', 'completed', 'failed'].includes(source.status)) throw denied();
  const [job] = await connection.select().from(schema.browserJobs).where(eq(schema.browserJobs.id, source.dispatchId));
  if (!job?.sessionId || job.runtime !== receipt.runtime || job.threadId !== mission.threadId || ['cancelled', 'cancelling'].includes(job.status)) throw denied();
  const assignment = await browserAttemptAssignment(connection, mission, source, job.sessionId);
  const claims = await connection.select().from(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, source.id));
  const claim = claims[0];
  if (claims.length !== 1 || !claim || claim.id !== receipt.claimId || claim.missionId !== mission.id || claim.runtime !== receipt.runtime || claim.workspaceId !== mission.workspaceId
    || claim.resourceKey !== `browser:${mission.workspaceId}` || claim.state !== 'claimed' || claim.expiresAt <= clock || claim.executorResourceId !== receipt.physicalSessionId
    || !assignment || assignment.id !== receipt.assignmentId || assignment.sessionId !== receipt.physicalSessionId || !assignment.expiresAt || assignment.expiresAt <= clock
    || assignment.projectId !== (receipt.preview ? `vps-preview-policy-v1:${receipt.preview.sandboxId}:${receipt.policyDigest}` : `self-hosted-policy-v1:${receipt.policyDigest}`)) throw denied();
  const creation = receipt.preview ? await previewCreation(connection, mission, source) : null;
  const environment = creation ? await readyMissionEnvironment(connection, mission, creation.setupJobId) : null;
  if (creation && (creation.requestHash !== receipt.preview!.creationRequestHash || creation.creator.id !== receipt.preview!.creationAttemptId
    || creation.sessionId !== receipt.physicalSessionId || creation.payload.sandboxId !== receipt.preview!.sandboxId
    || creation.setupJobId !== receipt.preview!.setupJobId || JSON.stringify(creation.payload.policy.allowedOrigins) !== JSON.stringify(mission.mandate!.allowedOrigins))) throw denied();
  const policy = creation?.payload.policy ?? { version: 1, allowedOrigins: [...mission.mandate!.allowedOrigins].sort(), readOnly: true, deadlineAt: receipt.deadlineAt };
  if (createHash('sha256').update(JSON.stringify(policy)).digest('hex') !== receipt.policyDigest) throw denied();
  if (Date.parse(policy.deadlineAt) <= clock.getTime()) throw denied();
  const plans = await connection.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.workspaceId, mission.workspaceId), inArray(schema.workspaceItems.id, task.spec.planVersions?.map(plan => plan.itemId) ?? [])));
  if (!task.spec.planVersions?.length || task.spec.planVersions.some(plan => !plans.some(item => item.id === plan.itemId && item.version === plan.version && !item.deletedAt))) throw denied();
  const terminal = ['completed', 'failed'].includes(source.status) && !!source.finishedAt && ['completed', 'failed'].includes(job.status);
  let caseKeys: string[] | null = null;
  if (terminal) {
    const runs = await connection.select().from(schema.testRuns).where(inArray(schema.testRuns.missionAttemptId, attempts.filter(row => row.planRevision === receipt.planRevision && row.mandateRevision === receipt.mandateRevision && row.runtime === receipt.runtime).map(row => row.id)));
    try {
      const humanTakeover = receipt.humanTakeover ? await browserTakeoverContinuation(connection, mission, task, source, assignment, claim, clock, true, event!.revision) : null;
      if (receipt.humanTakeover && (humanTakeover?.eventId !== receipt.humanTakeover.eventId || humanTakeover.runId !== receipt.humanTakeover.runId)) throw denied();
      caseKeys = browserReturnCases(task.spec.caseKeys, runs, receipt.blockedRunId, humanTakeover?.runId);
    }
    catch { throw denied(); }
  }
  return { receipt, source, assignment, claim, terminal, caseKeys,
    deadlineAt: new Date(Math.min(Date.parse(receipt.deadlineAt), Date.parse(policy.deadlineAt), environment?.deadlineAt.getTime() ?? Infinity)) };
}

export async function recordBrowserHandoff(connection: WorkspaceDatabase, mission: ControlledMission, attempt: Attempt, receipt: BrowserReturnReceipt, caseKeys: string[]) {
  await recordMissionEvent(connection, mission, 'browser_return_handoff', { attemptId: attempt.id, dispatchId: attempt.dispatchId, receipt, caseKeys }, handoffKey(attempt.id));
}

export async function browserAttemptCases(connection: WorkspaceDatabase, attempt: Attempt, task: Task) {
  if (task.spec?.kind !== 'browser_tests') throw denied();
  const spec = task.spec;
  const [event] = await connection.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, attempt.missionId), eq(schema.missionEvents.eventKey, handoffKey(attempt.id))));
  if (!event) return task.spec.caseKeys;
  const parsed = browserReturnReceiptSchema.safeParse(event.payload.receipt), keys = event.payload.caseKeys;
  if (!parsed.success || parsed.data.taskId !== task.id || parsed.data.runtime !== attempt.runtime || parsed.data.requestHash !== attempt.requestHash
    || parsed.data.requestHash !== missionHash({ spec, planRevision: attempt.planRevision, mandateRevision: attempt.mandateRevision })
    || parsed.data.planRevision !== attempt.planRevision || parsed.data.mandateRevision !== attempt.mandateRevision
    || event.payload.attemptId !== attempt.id || event.payload.dispatchId !== attempt.dispatchId || !Array.isArray(keys) || !keys.length
    || keys.some(key => typeof key !== 'string' || !spec.caseKeys.includes(key)) || new Set(keys).size !== keys.length) throw denied();
  return keys as string[];
}


/** Historical context only: no admission, no live claim/lease dependency and no
 * assertion about what the human did. Immutable receipt identities are checked
 * against their own epochs, not a later mission revision or current browser. */
export async function browserReturnContext(connection: Pick<WorkspaceDatabase, 'select'>,
  scope: { workspaceId: string; threadId: string; runtime: string; attemptId: string; userId?: string },
  run?: typeof schema.testRuns.$inferSelect): Promise<BrowserSessionContext | undefined> {
  const [attempt] = await connection.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.id, scope.attemptId), eq(schema.missionAttempts.runtime, scope.runtime)));
  if (!attempt || attempt.kind !== 'browser_tests' || attempt.id !== scope.attemptId || attempt.runtime !== scope.runtime) return;
  // Ordinary attempts have no return handoff; avoid unrelated mission/task reads.
  const [handoff] = await connection.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, attempt.missionId), eq(schema.missionEvents.eventKey, handoffKey(attempt.id))));
  if (!handoff || handoff.missionId !== attempt.missionId || handoff.kind !== 'browser_return_handoff' || handoff.eventKey !== handoffKey(attempt.id)) return;
  const [mission] = await connection.select().from(schema.missions).where(eq(schema.missions.id, attempt.missionId));
  if (!mission || mission.id !== attempt.missionId || mission.runtime !== scope.runtime || mission.workspaceId !== scope.workspaceId
    || mission.threadId !== scope.threadId || scope.userId !== undefined && mission.userId !== scope.userId) return;
  const [task] = await connection.select().from(schema.missionTasks).where(and(eq(schema.missionTasks.id, attempt.taskId), eq(schema.missionTasks.missionId, mission.id)));
  if (!task || task.id !== attempt.taskId || task.missionId !== mission.id || task.spec?.kind !== 'browser_tests' || task.planRevision !== attempt.planRevision) return;
  const spec = task.spec;
  const parsed = browserReturnReceiptSchema.safeParse(handoff.payload.receipt), keys = handoff.payload.caseKeys;
  if (!parsed.success) return;
  const receipt = parsed.data;
  if (handoff.payload.attemptId !== attempt.id || handoff.payload.dispatchId !== attempt.dispatchId
    || receipt.taskId !== task.id || receipt.runtime !== attempt.runtime || receipt.requestHash !== attempt.requestHash
    || receipt.requestHash !== missionHash({ spec: task.spec, planRevision: attempt.planRevision, mandateRevision: attempt.mandateRevision })
    || receipt.planRevision !== attempt.planRevision || receipt.mandateRevision !== attempt.mandateRevision
    || !Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length || keys.some(key => typeof key !== 'string' || !spec.caseKeys.includes(key))
    || attempt.deadlineAt.getTime() > Date.parse(receipt.deadlineAt)) return;
  const [returned] = await connection.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, receiptKey(receipt.waitId))));
  const original = browserReturnReceiptSchema.safeParse(returned?.payload.receipt);
  if (!returned || returned.missionId !== mission.id || returned.kind !== 'browser_returned' || returned.eventKey !== receiptKey(receipt.waitId)
    || !original.success || canonicalHash(original.data) !== canonicalHash(receipt)) return;
  const [wait] = await connection.select().from(schema.missionWaits).where(and(eq(schema.missionWaits.id, receipt.waitId), eq(schema.missionWaits.missionId, mission.id)));
  if (!wait || wait.id !== receipt.waitId || wait.missionId !== mission.id || wait.state !== 'answered' || !wait.answeredAt
    || wait.definition.reason !== 'human_browser' || !wait.definition.taskIds.includes(task.id)
    || wait.definition.planRevision !== attempt.planRevision || wait.definition.mandateRevision !== attempt.mandateRevision
    || wait.answer?.kind !== 'browser_returned' || wait.answer.sessionId !== receipt.physicalSessionId
    || returned.createdAt < wait.createdAt || wait.answeredAt < wait.createdAt || wait.answeredAt > wait.deadlineAt
    || returned.createdAt > handoff.createdAt || wait.answeredAt > attempt.createdAt) return;
  const [source] = await connection.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.id, receipt.sourceAttemptId), eq(schema.missionAttempts.missionId, mission.id)));
  if (!source || source.id !== receipt.sourceAttemptId || source.id === attempt.id || source.missionId !== mission.id || source.taskId !== task.id
    || source.runtime !== receipt.runtime || source.kind !== 'browser_tests' || source.dispatchId !== receipt.sourceDispatchId
    || source.requestHash !== receipt.requestHash || source.planRevision !== receipt.planRevision || source.mandateRevision !== receipt.mandateRevision
    || source.deadlineAt.toISOString() !== receipt.deadlineAt || source.attemptNo >= attempt.attemptNo || source.createdAt > wait.createdAt) return;
  if (run && (run.missionAttemptId !== attempt.id || run.workspaceId !== scope.workspaceId || run.threadId !== scope.threadId || run.runtime !== scope.runtime
    || !keys.includes(run.itemId + ':' + run.caseId) || !task.spec.planVersions?.some(plan => plan.itemId === run.itemId && plan.version === run.planVersion)
    || run.startedAt < attempt.createdAt || run.browserEntryReceipt?.sessionId !== receipt.physicalSessionId)) return;
  return { version: 1, kind: 'human_returned_session', priorAuthentication: 'unknown' };
}
