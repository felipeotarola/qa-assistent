/// <reference lib="dom" />
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { chromium } from 'playwright-core';
import { canonicalExecutionPayload } from '../../shared/mission-execution.mjs';
import { sanitizeEvidenceUrl } from '../../shared/evidence-provenance';
import { runtimeScope } from '../../shared/runtime-scope';
import { readyMissionEnvironment } from './mission-environment-scope';
import { buildMissionExecution, requireMissionExecutor } from './mission-executor-admission';
import { lockMission, recordMissionEvent } from './mission-control';
import { claimedMission, databaseNow, type MissionLease } from './mission-attempts';
import { repositoryRunner } from './repositories';
import { sandboxScope } from './sandbox-scope';
import { policyDigest, type BrowserPolicy } from './browser-mission-guard';
import type { VpsBrowserSession } from './vps-browser';
import { saveItem } from './workspaces';
import { missionRedactor, redactMissionValue } from './mission-redaction';
import { browserReturnReceiptSchema } from '../../shared/mission-browser-return';
import { matchPreviewHandoffReceipt, type PreviewHandoffReceipt } from '../../shared/preview-handoff.mjs';
import { browserAttemptAssignment, previewCreation, previewReturnAuthority } from './mission-browser-return';
import { withBrowserLock, assertBrowserLock } from './browser-lock';

const denied = () => createError({ statusCode: 409, statusMessage: 'Previewn saknar ett aktuellt uppdrag och en verifierad miljö.' });
const hash = (value: unknown) => createHash('sha256').update(canonicalExecutionPayload(value)).digest('hex');
async function context(attemptId: string) {
  return db.transaction(async tx => {
    const [attempt] = await tx.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.id, attemptId), eq(schema.missionAttempts.runtime, runtimeScope())));
    if (!attempt) throw denied();
    await lockMission(tx, attempt.missionId);
    const [savedMission] = await tx.select().from(schema.missions).where(eq(schema.missions.id, attempt.missionId));
    if (!savedMission) throw denied();
    const execution = buildMissionExecution(savedMission, attempt);
    const { mission, task } = await requireMissionExecutor(tx, execution);
    const [ready] = await tx.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, `environment-ready:${mission.planRevision}`)));
    const setupJobId = task.spec?.kind === 'preview_discovery' ? task.spec.setupJobId : task.spec?.kind === 'browser_tests' && typeof ready?.payload.setupJobId === 'string' ? ready.payload.setupJobId : null;
    if (!setupJobId) throw denied();
    const env = await readyMissionEnvironment(tx, mission, setupJobId);
    return { mission, task, attempt, execution, env, scope: sandboxScope(mission.userId, env.job.threadId, env.job.sessionKey) };
  });
}

export async function openMissionPreview(attemptId: string, expectedPolicy?: BrowserPolicy) {
  const initial = await context(attemptId);
  // A transferred attempt can only use its saved physical session through the
  // assignment alias. It must never fall through to ordinary preview creation.
  const transfer = await db.transaction(tx => previewReturnAuthority(tx, initial.mission, initial.attempt, true));
  if (transfer) throw denied();
  const expectedEnvironment = { jobId: initial.env.job.id, planHash: initial.env.config.planHash, processId: initial.env.plan.processId };
  if (!expectedEnvironment.processId) throw denied();
  const target = await repositoryRunner<{ origin: string; envJobId: string; planHash: string }>('/preview', { action: 'target', ...initial.scope, workspaceId: initial.mission.workspaceId, port: initial.env.plan.port,
    execution: initial.execution, expectedEnvironment });
  // This address is a receipt from the private runner, never model input.
  const address = new URL(target.origin);
  if (target.envJobId !== initial.env.job.id || target.planHash !== initial.env.config.planHash || address.origin !== target.origin || address.protocol !== 'http:'
    || !/^172\.30\.0\.\d{1,3}$/.test(address.hostname) || Number(address.port) !== initial.env.plan.port) throw denied();
  const prepared = await db.transaction(async tx => {
    await lockMission(tx, initial.mission.id);
    const { mission, attempt, task } = await requireMissionExecutor(tx, initial.execution);
    const env = await readyMissionEnvironment(tx, mission, initial.env.job.id);
    const deadlineAt = new Date(Math.min(attempt.deadlineAt.getTime(), env.deadlineAt.getTime(), mission.deadlineAt!.getTime())).toISOString();
    const policy: BrowserPolicy = { version: 1, allowedOrigins: [target.origin], readOnly: true, deadlineAt };
    if (expectedPolicy && policyDigest(policy) !== policyDigest(expectedPolicy)) throw denied();
    const payload = { sandboxId: initial.scope.id, port: env.plan.port, execution: initial.execution, policy, expectedEnvironment };
    const requestHash = hash(payload), eventKey = `preview-intent:${attempt.id}`;
    const [prior] = await tx.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, eventKey)));
    if (prior && prior.payload.requestHash !== requestHash) throw denied();
    const [opened] = await tx.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, `preview-opened:${attempt.id}`)));
    const [claim] = await tx.select().from(schema.missionResourceClaims).where(and(eq(schema.missionResourceClaims.attemptId, attempt.id), eq(schema.missionResourceClaims.missionId, mission.id), eq(schema.missionResourceClaims.runtime, runtimeScope())));
    if (!claim || claim.resourceKey !== `browser:${mission.workspaceId}` || claim.owner !== 'agent' || claim.state !== 'claimed' || claim.expiresAt <= await databaseNow(tx)
      || claim.workspaceId !== mission.workspaceId || claim.leaseToken !== attempt.leaseToken || claim.fence !== attempt.fence
      || attempt.executorResourceId && attempt.executorResourceId !== attempt.dispatchId) throw denied();
    if (opened ? !prior || opened.payload.attemptId !== attempt.id || opened.payload.requestHash !== requestHash || opened.payload.sandboxId !== initial.scope.id
      || typeof opened.payload.sessionId !== 'string' || !opened.payload.sessionId || claim.executorResourceId !== opened.payload.sessionId
      : claim.executorResourceId !== null) throw denied();
    // The request identity is known before the provider starts. The physical
    // session is not: keep its reservation unbound until an exact receipt is
    // durably saved, including after a lost acknowledgement/status recovery.
    await tx.update(schema.missionAttempts).set({ executorResourceId: attempt.dispatchId }).where(eq(schema.missionAttempts.id, attempt.id));
    if (!prior) await recordMissionEvent(tx, mission, 'preview.intent', { requestHash, payload, setupJobId: env.job.id }, eventKey);
    if (task.spec?.kind === 'preview_discovery') {
      // Resolves the already-authorized repository application to its assigned
      // isolated origin. No arbitrary private origin enters this mandate.
      if (mission.config.target && mission.config.target.url !== `${target.origin}/`) throw denied();
      await tx.update(schema.missions).set({ config: { ...mission.config, target: { environment: 'Isolerad testmiljö', url: `${target.origin}/`, revision: env.plan.commit } },
        mandate: { ...mission.mandate!, allowedOrigins: [target.origin] } }).where(eq(schema.missions.id, mission.id));
    }
    return { policy, payload, requestHash, existingIntent: !!prior };
  });
  type Session = VpsBrowserSession & { sandboxId: string; previewUrl: string };
  const request = { ...initial.scope, workspaceId: initial.mission.workspaceId, port: initial.env.plan.port,
    execution: initial.execution, policy: prepared.policy, expectedEnvironment };
  // A lost response never authorizes another browser. Read the original exact
  // session; confirmed absence ends this attempt instead of replaying navigation.
  const session = prepared.existingIntent
    ? (await repositoryRunner<{ session?: Session }>('/preview', { action: 'status', ...request })).session
    : await repositoryRunner<Session>('/preview', { action: 'open', ...request });
  if (!session) throw denied();
  if (session.sandboxId !== initial.scope.id || session.previewUrl !== target.origin || session.policyVersion !== 1 || session.policyDigest !== policyDigest(prepared.policy)) throw denied();
  await db.transaction(async tx => {
    await lockMission(tx, initial.mission.id);
    const { mission, attempt } = await requireMissionExecutor(tx, initial.execution);
    const eventKey = `preview-opened:${attemptId}`;
    const [prior] = await tx.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, eventKey)));
    if (prior && (prior.payload.sessionId !== session.sessionId || prior.payload.sandboxId !== session.sandboxId || prior.payload.requestHash !== prepared.requestHash)) throw denied();
    const [claim] = await tx.select().from(schema.missionResourceClaims).where(and(eq(schema.missionResourceClaims.attemptId, attempt.id), eq(schema.missionResourceClaims.missionId, mission.id), eq(schema.missionResourceClaims.runtime, runtimeScope()))).for('update');
    if (!claim || claim.resourceKey !== `browser:${mission.workspaceId}` || claim.workspaceId !== mission.workspaceId || claim.owner !== 'agent' || claim.state !== 'claimed'
      || claim.leaseToken !== attempt.leaseToken || claim.fence !== attempt.fence || claim.expiresAt <= await databaseNow(tx)
      || !session.sessionId || claim.executorResourceId && claim.executorResourceId !== session.sessionId) throw denied();
    if (!claim.executorResourceId) await tx.update(schema.missionResourceClaims).set({ executorResourceId: session.sessionId, updatedAt: await databaseNow(tx) }).where(eq(schema.missionResourceClaims.id, claim.id));
    if (!prior) await recordMissionEvent(tx, mission, 'preview.opened', { attemptId, sessionId: session.sessionId, sandboxId: session.sandboxId, requestHash: prepared.requestHash }, eventKey);
  });
  return { session, policy: prepared.policy };
}

/** Persist before HTTP; unknown acknowledgement recovers by status only.
 * The browser lock is held, but all mission/Vault transactions finish before
 * the fixed worker callback acquires the same database locks. */
export async function handoffMissionPreview(attemptId: string) {
  const [binding] = await db.select().from(schema.missionEvents).where(eq(schema.missionEvents.eventKey, `browser-return-handoff:${attemptId}`));
  if (!binding || !browserReturnReceiptSchema.parse(binding.payload.receipt).preview) return false;
  const initial = await context(attemptId);
  const preliminary = await db.transaction(tx => previewReturnAuthority(tx, initial.mission, initial.attempt, false));
  if (!preliminary) return false;
  return withBrowserLock(`browser:${initial.mission.workspaceId}:${initial.mission.threadId}:${preliminary.assignment.agentId}`, async () => {
    const prepared = await db.transaction(async tx => {
      await lockMission(tx, initial.mission.id);
      const { mission, attempt } = await requireMissionExecutor(tx, initial.execution);
      const transfer = await previewReturnAuthority(tx, mission, attempt, false);
      if (!transfer) throw denied();
      await assertBrowserLock();
      if (!transfer.intent) await recordMissionEvent(tx, mission, 'preview.handoff_intent', { requestHash: transfer.requestHash, payload: transfer.input }, `preview-handoff-intent:${attempt.id}`);
      return transfer;
    });
    const request = { ...prepared.scope, workspaceId: initial.mission.workspaceId };
    let raw: unknown;
    const readStatus = async () => {
      // No fresh handoff, control switch, browser or navigation on recovery.
      const status = await repositoryRunner<{ handoff?: PreviewHandoffReceipt }>('/preview', { action: 'status', ...request,
        port: prepared.creation.payload.port, execution: prepared.creation.payload.execution, policy: prepared.creation.payload.policy,
        expectedEnvironment: prepared.creation.payload.expectedEnvironment });
      return status.handoff;
    };
    if (prepared.intent) raw = await readStatus();
    else {
      try { raw = await repositoryRunner('/preview', { action: 'handoff', ...request, handoff: prepared.input }); }
      catch { raw = await readStatus(); }
    }
    const receipt = matchPreviewHandoffReceipt(raw, prepared.input, prepared.receipt.policyDigest);
    await db.transaction(async tx => {
      await lockMission(tx, initial.mission.id);
      const { mission, attempt } = await requireMissionExecutor(tx, initial.execution);
      const transfer = await previewReturnAuthority(tx, mission, attempt, false);
      if (!transfer?.intent || transfer.requestHash !== prepared.requestHash || transfer.ack && hash(transfer.ack) !== hash(receipt)) throw denied();
      await assertBrowserLock();
      if (!transfer.ack) await recordMissionEvent(tx, mission, 'preview.handoff_ack', { receipt }, `preview-handoff-ack:${attempt.id}`);
    });
    return true;
  });
}

/** Revocation permits this exact physical cleanup, never another start. */
export async function closeMissionPreview(attemptId: string) {
  const [attempt] = await db.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.id, attemptId), eq(schema.missionAttempts.runtime, runtimeScope())));
  if (!attempt) throw denied();
  const [handoff] = await db.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, attempt.missionId), eq(schema.missionEvents.eventKey, `browser-return-handoff:${attempt.id}`)));
  const receipt = handoff ? browserReturnReceiptSchema.parse(handoff.payload.receipt) : null;
  const creationId = receipt?.preview?.creationAttemptId ?? attempt.id;
  const [intent] = await db.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, attempt.missionId), eq(schema.missionEvents.eventKey, `preview-intent:${creationId}`)));
  if (receipt?.preview && !intent) throw denied();
  if (!intent) return { cleanupConfirmed: true, executorResourceId: attempt.executorResourceId };
  const [job] = typeof intent.payload.setupJobId === 'string' ? await db.select().from(schema.setupJobs).where(and(eq(schema.setupJobs.id, intent.payload.setupJobId), eq(schema.setupJobs.runtime, runtimeScope()))) : [];
  const [mission] = await db.select().from(schema.missions).where(and(eq(schema.missions.id, attempt.missionId), eq(schema.missions.runtime, runtimeScope())));
  if (!job?.autonomy || !mission || job.workspaceId !== mission.workspaceId || job.autonomy.execution.missionId !== mission.id) throw denied();
  if (receipt?.preview) await previewCreation(db, mission, attempt);
  const [browserJob] = await db.select().from(schema.browserJobs).where(and(eq(schema.browserJobs.id, attempt.dispatchId), eq(schema.browserJobs.runtime, mission.runtime), eq(schema.browserJobs.threadId, mission.threadId)));
  const assignment = await browserAttemptAssignment(db, mission, attempt, browserJob?.sessionId);
  const close = async () => {
    // Read after acquiring the same lock used by returned-session transfer.
    // The lock-only connection holds no application-row locks across HTTP.
    await assertBrowserLock();
    const [claim] = await db.select().from(schema.missionResourceClaims).where(and(eq(schema.missionResourceClaims.missionId, mission.id), eq(schema.missionResourceClaims.resourceKey, `browser:${mission.workspaceId}`)));
    if (claim && claim.attemptId !== attempt.id) return { cleanupConfirmed: false, executorResourceId: attempt.executorResourceId };
    const payload = intent.payload.payload as { execution: unknown; expectedEnvironment: unknown; port: number; policy: BrowserPolicy };
    const request = { ...sandboxScope(mission.userId, job.threadId, job.sessionKey), workspaceId: mission.workspaceId,
      port: payload.port, execution: payload.execution, expectedEnvironment: payload.expectedEnvironment, policy: payload.policy };
    let confirmed = false;
    try {
      const result = await repositoryRunner<{ confirmed?: boolean }>('/preview', { action: 'close', ...request });
      confirmed = result.confirmed === true;
    } catch { /* An uncertain close requires a physical read, not another start. */ }
    await assertBrowserLock();
    if (!confirmed) {
      const status = await repositoryRunner<{ cleanupConfirmed: boolean }>('/preview', { action: 'status', ...request });
      confirmed = status.cleanupConfirmed === true;
    }
    await assertBrowserLock();
    return { cleanupConfirmed: confirmed, executorResourceId: claim?.executorResourceId ?? attempt.executorResourceId };
  };
  // Discovery and an unacknowledged initial open have no human assignment to
  // transfer. A returned session always resolves its immutable assignment alias.
  return assignment ? withBrowserLock(`browser:${mission.workspaceId}:${mission.threadId}:${assignment.agentId}`, close) : close();
}

/** One fresh browser, one observed page, no model or authentication. Evidence
 * is saved before cleanup; unknown navigation outcomes are never retried here. */
export async function discoverMissionPreview(lease: MissionLease, attemptId: string) {
  const { session } = await openMissionPreview(attemptId);
  const browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 15_000 });
  try {
    const page = await browser.contexts()[0]!.newPage();
    const response = await page.goto(session.previewUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    const observed = await page.evaluate(() => {
      // Never persist an unredacted prefix of an oversized value: a credential
      // could straddle the truncation boundary. Drop the whole field instead.
      const bounded = (value: string, limit: number) => value.length <= limit ? value : '';
      const title = document.title, text = document.body.innerText;
      return { title: bounded(title, 300), text: bounded(text, 12_000), omittedOversizedContent: title.length > 300 || text.length > 12_000,
        links: [...document.querySelectorAll('a[href]')].slice(0, 100).flatMap(a => {
          const url = (a as HTMLAnchorElement).href;
          return url.length <= 2000 ? [{ url, label: bounded((a.textContent ?? '').trim(), 160) }] : [];
        }) };
    });
    const observedAt = new Date().toISOString(), url = sanitizeEvidenceUrl(page.url());
    if (!url || new URL(url).origin !== session.previewUrl) throw denied();
    return await db.transaction(async tx => {
      const mission = await claimedMission(tx, lease);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${mission.workspaceId}`}, 0))`);
      const [attempt] = await tx.select().from(schema.missionAttempts).where(eq(schema.missionAttempts.id, attemptId));
      if (!attempt) throw denied();
      await requireMissionExecutor(tx, buildMissionExecution(mission, attempt));
      const redact = await missionRedactor(tx, mission.workspaceId);
      if (redact(url) !== url) throw createError({ statusCode: 409, statusMessage: 'Previewadressen innehåller skyddad information och kan inte sparas som källa.' });
      const source = redactMissionValue({ ...observed, url, httpStatus: response?.status() ?? null, observedAt, limitation: 'En sida observerad i ny isolerad preview-session. Detta är planeringsunderlag, inte funktionella testresultat.' }, redact);
      const item = await saveItem(mission.userId, mission.workspaceId, { title: `Källa: ${source.title.slice(0, 180)}`, content: { kind: 'text', text: JSON.stringify(source) }, threadId: mission.threadId! }, tx,
        { provenance: { version: 1, origin: 'tool', producer: 'research-page', sourceType: 'research', observedAt, url } });
      await recordMissionEvent(tx, mission, 'preview.observation', { attemptId, itemId: item.id, observedAt, url }, `preview-observation:${attemptId}`);
      return item;
    });
  } finally { await browser.close().catch(() => {}); }
}
