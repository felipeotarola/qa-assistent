import { randomUUID } from 'node:crypto';
import { pendingBrowserReturn, recordBrowserHandoff, previewReturnAuthority } from './mission-browser-return';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@nuxthub/db';
import { missions, missionTasks, missionAttempts, missionResourceClaims, missionWaits } from '../db/schema/missions';
import { workspaces } from '../db/schema/workspaces';
import { dispatchReceiptSchema, evaluateAttemptAdmission, missionAttemptUsageSchema, missionFenceMatches, missionMandateSchema, missionResourceIdentity, type MissionAttemptUsage } from '../../shared/mission-control';
import { runtimeScope } from '../../shared/runtime-scope';
import { autonomyEnabled, currentMandate, lockMission, recordMissionEvent, validateTaskMandate, type ControlledMission } from './mission-control';
import { requireWorkspace, type WorkspaceDatabase } from './workspaces';
import { missionHash, readMissionSource } from './mission-sources';
import { validateMissionComplement } from './mission-complements';
import { interimReportContext, isInterimReport } from './mission-interim-report';

export type MissionLease = { missionId: string; leaseToken: string; fence: number; mandateRevision: number; planRevision: number };
export type MissionAttempt = typeof missionAttempts.$inferSelect;
const terminal = new Set(['completed', 'failed', 'cancelled']);
export async function databaseNow(connection: WorkspaceDatabase) {
  const [row] = await connection.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
  return new Date(row!.now);
}
export function leaseIdentity(row: ControlledMission): MissionLease {
  return { missionId: row.id, leaseToken: row.leaseToken!, fence: row.fence!, mandateRevision: row.mandateRevision!, planRevision: row.planRevision! };
}
export async function claimedMission(connection: WorkspaceDatabase, lease: MissionLease) {
  await lockMission(connection, lease.missionId);
  const [row] = await connection.select().from(missions).where(and(eq(missions.id, lease.missionId), eq(missions.runtime, runtimeScope())));
  if (!row || !missionFenceMatches(row, lease, await databaseNow(connection))) throw createError({ statusCode: 409, statusMessage: 'Uppdragets arbetslease eller mandat gäller inte längre.' });
  await requireWorkspace(row.userId, row.workspaceId, connection);
  return row;
}
/** The scheduler owns this short lease; it never holds SQL locks during HTTP. */
export async function claimMission(id?: string) {
  return db.transaction(async tx => {
    const candidates = await tx.select({ id: missions.id }).from(missions)
      .innerJoin(workspaces, and(eq(workspaces.id, missions.workspaceId), eq(workspaces.userId, missions.userId)))
      .where(and(eq(missions.runtime, runtimeScope()), eq(missions.controllerVersion, 1),
      // Absent historical mandates are not executable and are left untouched.
      sql`${missions.mandate} is not null and ${missions.mandate} <> 'null'::jsonb`,
      sql`${missions.lifecycle} in ('accepted','running','waiting','cancelling','paused')`, id ? eq(missions.id, id) : undefined,
      sql`(${missions.nextWakeAt} is null or ${missions.nextWakeAt} <= clock_timestamp()) and (${missions.leaseUntil} is null or ${missions.leaseUntil} <= clock_timestamp())`,
    )).orderBy(sql`coalesce(${missions.nextWakeAt}, ${missions.createdAt})`, missions.createdAt, missions.id).limit(10);
    for (const candidate of candidates) {
      const [lock] = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${`mission:${candidate.id}`}, 0)) as acquired`);
      if (!lock?.acquired) continue;
      const [row] = await tx.select().from(missions).where(eq(missions.id, candidate.id));
      const now = await databaseNow(tx);
      if (!row || row.runtime !== runtimeScope() || row.controllerVersion !== 1 || !['accepted', 'running', 'waiting', 'cancelling', 'paused'].includes(row.lifecycle!)
        || row.leaseUntil && row.leaseUntil > now || row.nextWakeAt && row.nextWakeAt > now || row.mandate === null) continue;
      // A malformed non-null row cannot poison the whole bounded batch. This
      // changes only its scheduler wake-up, never authority, state or history.
      // Backoff moves it behind untouched due work, including null wake-ups.
      const deferInvalid = () => tx.update(missions).set({ nextWakeAt: new Date(now.getTime() + 60_000) }).where(and(eq(missions.id, row.id), eq(missions.runtime, runtimeScope()), eq(missions.controllerVersion, 1)));
      if (!missionMandateSchema.safeParse(row.mandate).success || !Number.isInteger(row.planRevision) || row.planRevision! < 1
        || !Number.isInteger(row.mandateRevision) || row.mandateRevision! < 1 || !row.deadlineAt || !Number.isFinite(row.deadlineAt.getTime())) {
        await deferInvalid();
        continue;
      }
      try { await requireWorkspace(row.userId, row.workspaceId, tx); }
      catch (error) {
        // Recheck ownership after the advisory lock. An ownership race can
        // remove eligibility; transport/SQL failures must still propagate.
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
        await deferInvalid();
        continue;
      }
      const mandate = currentMandate(row);
      const [claimed] = await tx.update(missions).set({ leaseToken: randomUUID(), fence: (row.fence ?? 0) + 1, leaseUntil: new Date(now.getTime() + mandate.limits.leaseMs), heartbeatAt: now }).where(eq(missions.id, row.id)).returning();
      return claimed!;
    }
    return null;
  });
}
export async function releaseMissionLease(lease: MissionLease, delayMs = 15_000) {
  // Token/fence comparison also protects a cancellation's newer wake-up.
  await db.update(missions).set({ leaseToken: null, leaseUntil: null, nextWakeAt: new Date(Date.now() + delayMs) }).where(and(eq(missions.id, lease.missionId), eq(missions.runtime, runtimeScope()), eq(missions.leaseToken, lease.leaseToken), eq(missions.fence, lease.fence)));
}
export async function reserveMissionAttempt(lease: MissionLease, taskId: string, options: { usesModel?: boolean; resource?: { kind: 'browser' | 'otto'; poolKey: string } } = {}) {
  return db.transaction(async tx => {
    const mission = await claimedMission(tx, lease), mandate = currentMandate(mission);
    if (!autonomyEnabled()) throw createError({ statusCode: 503, statusMessage: 'Autonom exekvering är pausad.' });
    const tasks = await tx.select().from(missionTasks).where(eq(missionTasks.missionId, mission.id));
    const task = tasks.find(t => t.id === taskId);
    if (!task?.spec || !task.operationId || task.planRevision !== mission.planRevision || !['pending', 'ready'].includes(task.state!)) throw createError({ statusCode: 409, statusMessage: 'Uppgiften är inte körbar i aktuell plan.' });
    const waits = await tx.select().from(missionWaits).where(and(eq(missionWaits.missionId, mission.id), eq(missionWaits.state, 'waiting')));
    if (waits.some(wait => wait.definition.planRevision === mission.planRevision && wait.definition.taskIds.includes(taskId))) return { status: 'deferred' as const, reasons: ['waiting_for_user'] };
    await validateTaskMandate(tx, mission, task.spec);
    let interim: Awaited<ReturnType<typeof interimReportContext>>;
    try { interim = await interimReportContext(tx, mission, task); }
    catch (error) {
      if ((error as { data?: { code?: string } }).data?.code !== 'interim_obsolete') throw error;
      return { status: 'deferred' as const, reasons: ['interim_obsolete'] };
    }
    try { await validateMissionComplement(tx, mission, task); }
    catch (error) {
      if ((error as { data?: { code?: string } }).data?.code !== 'complement_stale') throw error;
      await tx.update(missionTasks).set({ state: 'blocked', blockedReason: 'Kompletteringens underlag eller plan ändrades före start.', updatedAt: await databaseNow(tx) }).where(eq(missionTasks.id, task.id));
      await recordMissionEvent(tx, mission, 'complement_invalidated', { taskId: task.id }, `complement-invalidated:${task.id}`);
      return { status: 'deferred' as const, reasons: ['complement_stale'] };
    }
    const requiredResource = ['browser_tests', 'preview_discovery'].includes(task.spec.kind) ? 'browser' : ['repository_check', 'environment_setup'].includes(task.spec.kind) || task.spec.kind === 'discovery' && task.spec.target.kind === 'repository' ? 'otto' : null;
    if (requiredResource && options.resource?.kind !== requiredResource) throw createError({ statusCode: 409, statusMessage: 'Uppgiften saknar sitt resursanspråk.' });
    for (const dependency of task.dependencyRequirements ?? []) {
      const parent = tasks.find(t => t.id === dependency.taskId);
      const satisfied = parent && (dependency.require === 'completed' ? parent.state === 'completed' : dependency.require === 'terminal' ? ['completed', 'failed', 'blocked', 'cancelled'].includes(parent.state!) : parent.sources.length > 0);
      if (!satisfied) return { status: 'deferred' as const, reasons: ['dependency'] };
    }
    const attempts = await tx.select().from(missionAttempts).where(eq(missionAttempts.missionId, mission.id));
    let now = await databaseNow(tx);
    const evaluate = () => evaluateAttemptAdmission({ mandate, kind: task.spec!.kind, operationId: task.operationId!, attempts, now: now.toISOString(), supplementRound: task.supplementRound ?? 0, usesModel: options.usesModel, reportDeadlineAt: mission.reportDeadlineAt?.toISOString(), reportPurpose: isInterimReport(task.spec) ? 'interim' : 'final' });
    let admission = evaluate();
    if (!admission.allowed) return { status: 'deferred' as const, reasons: admission.reasons };
    const resource = options.resource && missionResourceIdentity(options.resource.kind, options.resource.poolKey, mission.workspaceId);
    let returned: Awaited<ReturnType<typeof pendingBrowserReturn>> = null;
    if (resource) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mission-resource:${resource.poolKey}:${resource.resourceKey}`}, 0))`);
      await claimedMission(tx, lease);
      now = await databaseNow(tx); admission = evaluate();
      if (!admission.allowed) return { status: 'deferred' as const, reasons: admission.reasons };
      await validateMissionComplement(tx, mission, task);
      try { returned = await pendingBrowserReturn(tx, mission, task); }
      catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 409) throw error;
        await tx.update(missionTasks).set({ state: 'blocked', blockedReason: 'Den återlämnade sessionen eller dess ursprungliga mandat är inte längre giltigt. Ingen ersättningssession startades.', updatedAt: now }).where(eq(missionTasks.id, task.id));
        const origin = attempts.filter(attempt => attempt.taskId === task.id && attempt.runtime === runtimeScope()
          && attempt.planRevision === mission.planRevision && attempt.mandateRevision === mission.mandateRevision).sort((a, b) => b.attemptNo - a.attemptNo)[0];
        if (origin) await recordMissionEvent(tx, mission, 'browser_return_invalidated', { taskId: task.id, attemptId: origin.id }, `browser-return-invalidated:${origin.id}`);
        return { status: 'deferred' as const, reasons: ['dependency'] };
      }
      if (returned) {
        const [lock] = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${`browser:${mission.workspaceId}:${mission.threadId}:${returned.assignment.agentId}`}, 0)) as acquired`);
        if (!lock?.acquired) return { status: 'deferred' as const, reasons: ['resource_busy'] };
        returned = await pendingBrowserReturn(tx, mission, task);
        if (!returned || !returned.terminal) return { status: 'deferred' as const, reasons: ['operation_in_flight'] };
        if (returned.assignment.control !== 'agent') return { status: 'deferred' as const, reasons: ['human_control'] };
        // Re-evaluate the ordinary budget after acquiring both serialization
        // locks; session continuity does not grant an extra attempt or tokens.
        now = await databaseNow(tx); admission = evaluate();
        if (!admission.allowed) return { status: 'deferred' as const, reasons: admission.reasons };
        if (!returned.caseKeys?.length) {
          await tx.update(missionTasks).set({ state: 'completed', updatedAt: now }).where(eq(missionTasks.id, task.id));
          return { status: 'deferred' as const, reasons: ['dependency'] };
        }
      }
      const [existing] = await tx.select().from(missionResourceClaims).where(and(eq(missionResourceClaims.poolKey, resource.poolKey), eq(missionResourceClaims.resourceKey, resource.resourceKey)));
      if (existing && existing.id !== returned?.claim.id) {
        // Expiry is uncertainty, never evidence that a browser or process stopped.
        if (existing.expiresAt <= now && existing.owner !== 'human') await tx.update(missionResourceClaims).set({ state: 'uncertain', updatedAt: now }).where(eq(missionResourceClaims.id, existing.id));
        await tx.update(missionTasks).set({ blockedReason: existing.owner === 'human' ? 'resource_human_control' : 'resource_busy', updatedAt: now }).where(eq(missionTasks.id, task.id));
        return { status: 'deferred' as const, reasons: [existing.owner === 'human' ? 'human_control' : 'resource_busy'] };
      }
    }
    const [attempt] = await tx.insert(missionAttempts).values({ id: randomUUID(), missionId: mission.id, taskId: task.id, runtime: runtimeScope(), kind: task.spec.kind, operationId: task.operationId,
      requestHash: missionHash({ spec: task.spec, planRevision: mission.planRevision, mandateRevision: mission.mandateRevision }), dispatchId: randomUUID(), attemptNo: attempts.filter(a => a.operationId === task.operationId).length + 1,
      planRevision: mission.planRevision!, mandateRevision: mission.mandateRevision!, supplementRound: task.supplementRound ?? 0, reservedTokens: admission.reservation.tokens, reservedToolCalls: admission.reservation.toolCalls,
      deadlineAt: new Date(Math.min(Date.parse(admission.reservation.deadlineAt), interim?.deadlineAt.getTime() ?? Infinity, returned?.deadlineAt.getTime() ?? Infinity)), status: 'reserved', leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() + mandate.limits.leaseMs), fence: returned ? returned.claim.fence + 1 : 1,
    }).returning();
    if (returned) {
      await tx.update(missionResourceClaims).set({ attemptId: attempt!.id, owner: 'agent', leaseToken: attempt!.leaseToken!, fence: attempt!.fence, expiresAt: attempt!.deadlineAt, updatedAt: now }).where(eq(missionResourceClaims.id, returned.claim.id));
      await recordBrowserHandoff(tx, mission, attempt!, returned.receipt, returned.caseKeys!);
      if (returned.receipt.preview) {
        await tx.update(missionAttempts).set({ executorResourceId: attempt!.dispatchId }).where(eq(missionAttempts.id, attempt!.id));
        attempt!.executorResourceId = attempt!.dispatchId;
      }
    } else if (resource) await tx.insert(missionResourceClaims).values({ id: randomUUID(), ...resource, missionId: mission.id, attemptId: attempt!.id, workspaceId: mission.workspaceId, runtime: runtimeScope(), leaseToken: attempt!.leaseToken!, fence: attempt!.fence, expiresAt: attempt!.deadlineAt });
    await tx.update(missionTasks).set({ state: 'running', blockedReason: null, updatedAt: now }).where(eq(missionTasks.id, task.id));
    await tx.update(missions).set({ lifecycle: 'running' }).where(eq(missions.id, mission.id));
    await recordMissionEvent(tx, mission, 'attempt_reserved', { attemptId: attempt!.id, taskId, dispatchId: attempt!.dispatchId, kind: task.spec.kind, reservedTokens: attempt!.reservedTokens, deadlineAt: attempt!.deadlineAt.toISOString() });
    return { status: 'reserved' as const, attempt: attempt!, task };
  });
}
/** Replays reuse a dispatch ID. A network error changes state, not identity. */
export async function markMissionDispatch(lease: MissionLease, attemptId: string, unknown = false) {
  return db.transaction(async tx => {
    const mission = await claimedMission(tx, lease);
    const [attempt] = await tx.select().from(missionAttempts).where(and(eq(missionAttempts.id, attemptId), eq(missionAttempts.missionId, mission.id)));
    if (!attempt || terminal.has(attempt.status) || attempt.cancelRequestedAt || attempt.mandateRevision !== mission.mandateRevision || attempt.planRevision !== mission.planRevision || attempt.deadlineAt <= await databaseNow(tx)) throw createError({ statusCode: 409, statusMessage: 'Försöket får inte startas.' });
    const [task] = await tx.select().from(missionTasks).where(and(eq(missionTasks.id, attempt.taskId), eq(missionTasks.missionId, mission.id)));
    if (!task) throw createError({ statusCode: 409 });
    await validateMissionComplement(tx, mission, task);
    await interimReportContext(tx, mission, task);
    await claimedMission(tx, lease);
    if (attempt.deadlineAt <= await databaseNow(tx)) throw createError({ statusCode: 409, statusMessage: 'Försökets tidsgräns passerade före start.' });
    const [saved] = await tx.update(missionAttempts).set({ status: unknown ? 'dispatch_unknown' : 'dispatching', updatedAt: new Date() }).where(eq(missionAttempts.id, attempt.id)).returning();
    await recordMissionEvent(tx, mission, unknown ? 'dispatch_unknown' : 'dispatch', { attemptId, dispatchId: attempt.dispatchId });
    return saved!;
  });
}

export async function authorizeMissionOperation(input: { userId: string; workspaceId: string; attemptId: string; dispatchId: string; callId: string; tool: string; input: unknown; url?: string }) {
  if (!input.callId || input.callId.length > 200 || !input.tool || input.tool.length > 80) throw createError({ statusCode: 400 });
  const [initial] = await db.select().from(missionAttempts).where(and(eq(missionAttempts.id, input.attemptId), eq(missionAttempts.runtime, runtimeScope())));
  if (!initial) throw createError({ statusCode: 404 });
  return db.transaction(async tx => {
    await lockMission(tx, initial.missionId);
    const [mission] = await tx.select().from(missions).where(and(eq(missions.id, initial.missionId), eq(missions.userId, input.userId), eq(missions.workspaceId, input.workspaceId), eq(missions.runtime, runtimeScope())));
    if (!mission) throw createError({ statusCode: 404 });
    await requireWorkspace(input.userId, input.workspaceId, tx);
    const [attempt] = await tx.select().from(missionAttempts).where(eq(missionAttempts.id, input.attemptId));
    const now = await databaseNow(tx), mandate = currentMandate(mission);
    if (!autonomyEnabled() || !attempt || attempt.dispatchId !== input.dispatchId || terminal.has(attempt.status) || attempt.cancelRequestedAt || !['running', 'waiting'].includes(mission.lifecycle!) || attempt.mandateRevision !== mission.mandateRevision || attempt.planRevision !== mission.planRevision || now >= attempt.deadlineAt) throw createError({ statusCode: 409, statusMessage: 'Uppdraget har pausats, avslutats eller förlorat sitt körmandat.' });
    const waits = await tx.select().from(missionWaits).where(and(eq(missionWaits.missionId, mission.id), eq(missionWaits.state, 'waiting')));
    if (waits.some(wait => wait.definition.planRevision === mission.planRevision && wait.definition.taskIds.includes(attempt.taskId))) throw createError({ statusCode: 409, statusMessage: 'Uppgiften väntar på användaren.' });
    const [task] = await tx.select().from(missionTasks).where(eq(missionTasks.id, attempt.taskId));
    if (task?.state !== 'running' || task.planRevision !== mission.planRevision) throw createError({ statusCode: 409, statusMessage: 'Uppgiften har inte ett aktivt körmandat.' });
    await validateMissionComplement(tx, mission, task);
    if (attempt.deadlineAt <= await databaseNow(tx)) throw createError({ statusCode: 409, statusMessage: 'Försökets tidsgräns passerade före verktygsanropet.' });
    await previewReturnAuthority(tx, mission, attempt, true);
    const tools: Record<string, string[]> = { discovery: ['research'], planning: ['plan'], browser_tests: ['browser', 'test_run', 'workspace'], repository_check: ['repository'], environment_setup: ['setup'], review: ['review'], report: ['report'] };
    if (!tools[attempt.kind]?.includes(input.tool)) throw createError({ statusCode: 403, statusMessage: 'Verktyget ingår inte i uppgiften.' });
    if (input.url && !mandate.allowedOrigins.includes(new URL(input.url).origin)) throw createError({ statusCode: 403, statusMessage: 'Adressen ligger utanför uppdragets mål.' });
    const callKey = missionHash({ callId: input.callId, tool: input.tool });
    const operationKey = `${callKey}:${missionHash({ input: input.input, url: input.url ?? null })}`;
    const previous = attempt.toolCallIds.find(id => id.startsWith(`${callKey}:`));
    if (previous) {
      if (previous !== operationKey) throw createError({ statusCode: 409, statusMessage: 'Verktygsanropets innehåll ändrades vid återförsök.' });
      return { allowed: true, replay: true, deadlineAt: attempt.deadlineAt.toISOString() };
    }
    if (attempt.toolCalls >= attempt.reservedToolCalls) throw createError({ statusCode: 409, statusMessage: 'Uppgiftens verktygsbudget är förbrukad.' });
    if (!mandate.allowedTaskKinds.includes(attempt.kind)) throw createError({ statusCode: 403 });
    await tx.update(missionAttempts).set({ toolCalls: attempt.toolCalls + 1, toolCallIds: [...attempt.toolCallIds, operationKey], updatedAt: now }).where(eq(missionAttempts.id, attempt.id));
    return { allowed: true, replay: false, deadlineAt: attempt.deadlineAt.toISOString() };
  });
}

/** Account a saved immutable test receipt without granting any new work.
 * Exhaustion, pause or cancellation must never discard an executor's result.
 * Stable run identity deduplicates both HTTP and model retries. */
export async function accountMissionTestReceipt(input: { userId: string; workspaceId: string; attemptId: string; dispatchId: string; runId: string }) {
  const { testRuns } = await import('../db/schema/test-runs');
  const [initial] = await db.select().from(missionAttempts).where(and(eq(missionAttempts.id, input.attemptId), eq(missionAttempts.runtime, runtimeScope())));
  if (!initial) throw createError({ statusCode: 404 });
  return db.transaction(async tx => {
    await lockMission(tx, initial.missionId);
    const [mission] = await tx.select().from(missions).where(and(eq(missions.id, initial.missionId), eq(missions.userId, input.userId), eq(missions.workspaceId, input.workspaceId), eq(missions.runtime, runtimeScope())));
    const [attempt] = await tx.select().from(missionAttempts).where(eq(missionAttempts.id, initial.id));
    const [run] = await tx.select().from(testRuns).where(and(eq(testRuns.id, input.runId), eq(testRuns.workspaceId, input.workspaceId), eq(testRuns.missionAttemptId, initial.id)));
    if (!mission || !attempt || attempt.dispatchId !== input.dispatchId || !run?.result) throw createError({ statusCode: 409, statusMessage: 'Kvittot måste tillhöra det ursprungliga körförsöket.' });
    const key = `test-receipt:${run.id}`;
    if (attempt.toolCallIds.includes(key)) return;
    await tx.update(missionAttempts).set({ toolCalls: attempt.toolCalls + 1, toolCallIds: [...attempt.toolCallIds, key], updatedAt: await databaseNow(tx) }).where(eq(missionAttempts.id, attempt.id));
  });
}

/** Only an authenticated executor adapter calls this with its confirmed receipt.
 * Late output is retained, but never grants permission for another task. */
export async function receiveMissionReceipt(attemptId: string, value: unknown, usage?: MissionAttemptUsage) {
  const receipt = dispatchReceiptSchema.parse(value), parsedUsage = usage && missionAttemptUsageSchema.parse(usage);
  const [initial] = await db.select().from(missionAttempts).where(and(eq(missionAttempts.id, attemptId), eq(missionAttempts.runtime, runtimeScope())));
  if (!initial) throw createError({ statusCode: 404 });
  return db.transaction(async tx => {
    await lockMission(tx, initial.missionId);
    const [mission] = await tx.select().from(missions).where(eq(missions.id, initial.missionId));
    const [attempt] = await tx.select().from(missionAttempts).where(eq(missionAttempts.id, attemptId));
    if (!mission || !attempt || receipt.dispatchId !== attempt.dispatchId) throw createError({ statusCode: 409 });
    const old = attempt.receipt;
    const allowedSources: Record<string, string[]> = { discovery: ['research', 'repository'], preview_discovery: ['research'], planning: ['material'], browser_tests: ['browser'], repository_check: ['repository'], environment_setup: ['setup'], review: ['test'], report: ['material'] };
    if (!allowedSources[attempt.kind]?.includes(receipt.sourceType)) throw createError({ statusCode: 409, statusMessage: 'Kvittot gäller fel slags utförare.' });
    await readMissionSource(tx, mission.workspaceId, receipt.sourceType, receipt.sourceId);
    if (old && (old.sourceType !== receipt.sourceType || old.sourceId !== receipt.sourceId)) throw createError({ statusCode: 409, statusMessage: 'Körningskvittots källidentitet är oföränderlig.' });
    if (old && receipt.sequence <= old.sequence) {
      if (receipt.sequence === old.sequence && missionHash(receipt) !== missionHash(old)) throw createError({ statusCode: 409, statusMessage: 'Motstridigt kvitto med samma sekvens.' });
      return { accepted: false, stale: true };
    }
    if (terminal.has(attempt.status)) return { accepted: false, stale: true };
    const status = receipt.status === 'accepted' ? 'running' : receipt.status === 'unknown' ? 'dispatch_unknown' : receipt.status;
    const isTerminal = terminal.has(status), now = await databaseNow(tx);
    await tx.update(missionAttempts).set({ receipt, status, ...(parsedUsage ? { usage: parsedUsage } : {}), updatedAt: now, ...(isTerminal ? { finishedAt: now, leaseToken: null, leaseUntil: null } : {}) }).where(eq(missionAttempts.id, attempt.id));
    const current = mission.mandateRevision === attempt.mandateRevision && mission.planRevision === attempt.planRevision && ['accepted', 'running', 'waiting'].includes(mission.lifecycle!) && !attempt.cancelRequestedAt;
    if (current && attempt.kind !== 'report') {
      const [task] = await tx.select().from(missionTasks).where(eq(missionTasks.id, attempt.taskId));
      if (task && !task.sources.some(s => s.type === receipt.sourceType && s.id === receipt.sourceId)) await tx.update(missionTasks).set({ sources: [...task.sources, { type: receipt.sourceType, id: receipt.sourceId }] }).where(eq(missionTasks.id, task.id));
      // A completed receipt is input for controller delivery validation. It is
      // deliberately NOT enough to mark a QA task completed here.
    }
    await recordMissionEvent(tx, mission, current ? 'executor_receipt' : 'late_executor_receipt', { attemptId, status, sourceType: receipt.sourceType, sourceId: receipt.sourceId, sequence: receipt.sequence, usage: parsedUsage ?? null }, `receipt:${attemptId}:${receipt.sequence}`);
    return { accepted: true, current };
  });
}
/** Release only after observing the physical resource stopped/returned. */
export async function releaseMissionResource(attemptId: string, executorResourceId: string | null, confirmedStopped: boolean) {
  if (!confirmedStopped) return false;
  return db.transaction(async tx => {
    const [claim] = await tx.select().from(missionResourceClaims).where(and(eq(missionResourceClaims.attemptId, attemptId), eq(missionResourceClaims.runtime, runtimeScope()))).for('update');
    if (!claim || claim.owner === 'human' || claim.executorResourceId !== executorResourceId) return false;
    const [attempt] = await tx.select().from(missionAttempts).where(eq(missionAttempts.id, attemptId));
    if (!attempt || !terminal.has(attempt.status)) return false;
    await tx.delete(missionResourceClaims).where(eq(missionResourceClaims.id, claim.id));
    return true;
  });
}
export async function expireMissionWaits(connection: WorkspaceDatabase, mission: ControlledMission) {
  const now = await databaseNow(connection);
  const waits = await connection.select().from(missionWaits).where(and(eq(missionWaits.missionId, mission.id), eq(missionWaits.state, 'waiting')));
  for (const wait of waits.filter(w => w.deadlineAt <= now)) {
    await connection.update(missionWaits).set({ state: 'expired' }).where(eq(missionWaits.id, wait.id));
    const blockedReason = `Inget svar före sista svarstid (${wait.deadlineAt.toISOString()}). Historisk obesvarad väntfråga: ”${wait.definition.question}”`;
    for (const taskId of wait.definition.taskIds) await connection.update(missionTasks).set({ state: 'blocked', blockedReason, updatedAt: now }).where(and(eq(missionTasks.id, taskId), eq(missionTasks.state, 'waiting')));
    await recordMissionEvent(connection, mission, 'wait_expired', { waitId: wait.id, taskIds: wait.definition.taskIds });
  }
}
