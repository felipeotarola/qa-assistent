import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { z } from 'zod';
import { MISSION_PLANNING_BROWSER_EXECUTION, missionPlanningInputSchema, validateMissionPlanningDraft, plannedTestCase, DEFAULT_NEW_MISSION_CASES, MAX_PLANNING_CONTEXT_CHARS, MISSION_PLANNER_VERSION, missionPlanningFailureSchema, planningFailureAllowsRepair, type MissionPlanningFailure, type MissionPlanningInput } from '../../shared/mission-planning';
import { missionAttemptUsageSchema, type MissionAttemptUsage } from '../../shared/mission-control';
import { testPlanSchema, caseReady } from '../../shared/test-plan';
import { missionConfigSchema } from '../../shared/mission';
import { normalizeEvidenceProvenance, sanitizeEvidenceUrl } from '../../shared/evidence-provenance';
import { runtimeScope } from '../../shared/runtime-scope';
import { saveItem, ownedItem, requireWorkspace, type WorkspaceDatabase } from './workspaces';
import { claimedMission, databaseNow, type MissionLease, type MissionAttempt } from './mission-attempts';
import { autonomyEnabled, currentMandate, addMissionTask, lockMission, recordMissionEvent, type ControlledMission } from './mission-control';
import { missionHash, readMissionSource } from './mission-sources';
import { missionRedactor, redactMissionValue } from './mission-redaction';

export type MissionPlanningResult = {
  itemId: string | null; version: number | null; caseKeys: string[]; taskIds: string[];
  planVersions: { itemId: string; version: number }[];
  blockedCases: { caseKey: string; reason: string }[]; limitations: string[];
};
const sourceDocument = z.object({ title: z.string().default(''), text: z.string(), links: z.array(z.object({ url: z.string(), label: z.string() })).default([]), omittedOversizedContent: z.boolean().default(false) });
const completedKey = (taskId: string) => `planning-completed:${taskId}`;
async function planningContext(tx: WorkspaceDatabase, lease: MissionLease, attemptId: string) {
  const mission = await claimedMission(tx, lease);
  if (mission.intent === 'report_only') throw createError({ statusCode: 403, statusMessage: 'En rapportsammanställning får inte planera nya tester.' });
  const [attempt] = await tx.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.id, attemptId), eq(schema.missionAttempts.missionId, mission.id), eq(schema.missionAttempts.runtime, runtimeScope())));
  const [task] = attempt ? await tx.select().from(schema.missionTasks).where(and(eq(schema.missionTasks.id, attempt.taskId), eq(schema.missionTasks.missionId, mission.id))) : [];
  if (!attempt || attempt.kind !== 'planning' || task?.spec?.kind !== 'planning' || attempt.mandateRevision !== mission.mandateRevision || attempt.planRevision !== mission.planRevision || task.planRevision !== mission.planRevision) throw createError({ statusCode: 409, statusMessage: 'Planeringen tillhör inte det aktuella körförsöket.' });
  const [completed] = await tx.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, completedKey(task.id))));
  return { mission, task, attempt, completed };
}
async function requireActivePlanning(tx: WorkspaceDatabase, value: Awaited<ReturnType<typeof planningContext>>) {
  const { mission, task, attempt } = value, now = await databaseNow(tx);
  if (!autonomyEnabled() || mission.status !== 'active' || !['accepted', 'running', 'waiting'].includes(mission.lifecycle!) || !mission.deadlineAt || mission.deadlineAt <= now
    || !['reserved', 'dispatching', 'running'].includes(attempt.status) || attempt.cancelRequestedAt || attempt.deadlineAt <= now || task.state !== 'running') throw createError({ statusCode: 409, statusMessage: 'Planeringen har stoppats eller förlorat sitt mandat.' });
  const waits = await tx.select().from(schema.missionWaits).where(and(eq(schema.missionWaits.missionId, mission.id), eq(schema.missionWaits.state, 'waiting')));
  if (waits.some(wait => wait.definition.planRevision === mission.planRevision && wait.definition.taskIds.includes(task.id))) throw createError({ statusCode: 409, statusMessage: 'Planeringen väntar på användaren.' });
}
async function buildPlanningInput(tx: WorkspaceDatabase, mission: ControlledMission, task: Awaited<ReturnType<typeof planningContext>>['task']) {
  const mandate = currentMandate(mission), target = mission.config.target;
  if (!target || !mandate.allowedOrigins.includes(new URL(target.url).origin)) throw createError({ statusCode: 409, statusMessage: 'Ett verifierat och tillåtet testmål krävs före planering.' });
  const redact = await missionRedactor(tx, mission.workspaceId);
  const sources: MissionPlanningInput['sources'] = [], selectedCases: MissionPlanningInput['selectedCases'] = [], limitations: string[] = [];
  // Explicit selections are authoritative; no model changes their wording,
  // type, expected behavior or IDs. Their whole item version is fenced.
  for (const key of mission.admission!.caseKeys) {
    const [itemId, caseId] = key.split(':');
    const item = await ownedItem(mission.userId, mission.workspaceId, itemId!, tx);
    const testCase = item.content.kind === 'test_plan' && item.content.cases.find(c => c.id === caseId);
    if (!testCase) throw createError({ statusCode: 409, statusMessage: 'Ett valt testfall har tagits bort.' });
    selectedCases.push({ key, version: item.version, sourceHash: missionHash({ content: item.content, version: item.version }), testCase });
  }
  if (!selectedCases.length) for (const ref of task.spec?.kind === 'planning' ? task.spec.sourceRefs : []) {
    if (sources.length >= 4) { limitations.push('Ytterligare källor ligger utanför planeringens kontextbudget.'); break; }
    if (ref.type !== 'research') { limitations.push('En källa är inte ett sparat webbobservationsunderlag och används inte för nya webbtestfall.'); continue; }
    const item = await ownedItem(mission.userId, mission.workspaceId, ref.id, tx), provenance = normalizeEvidenceProvenance(item.provenance);
    const observedAt = provenance?.observedAt ? Date.parse(provenance.observedAt) : NaN;
    if (item.content.kind !== 'text' || provenance?.origin !== 'tool' || provenance.producer !== 'research-page' || !provenance.url || !Number.isFinite(observedAt)
      || target.scope && observedAt < Date.parse(target.scope.capturedAt) || !mandate.allowedOrigins.includes(new URL(provenance.url).origin)) {
      limitations.push('En källa saknar aktuell verktygsproveniens för testmålet.'); continue;
    }
    let parsed: z.infer<typeof sourceDocument>;
    try { parsed = sourceDocument.parse(JSON.parse(item.content.text)); }
    catch { limitations.push('Ett källunderlag kunde inte läsas som en sparad webbservation.'); continue; }
    const links = parsed.links.flatMap(link => {
      const url = sanitizeEvidenceUrl(link.url);
      return url && mandate.allowedOrigins.includes(new URL(url).origin) ? [{ url, label: redact(link.label).slice(0, 160) }] : [];
    });
    const uniqueLinks = [...new Map(links.map(link => [link.url, link])).values()];
    sources.push({ itemId: item.id, version: item.version, sourceHash: missionHash({ content: item.content, provenance, version: item.version }),
      url: provenance.url, title: redact(parsed.title).slice(0, 300), text: redact(parsed.text).slice(0, 12_000), links: uniqueLinks.slice(0, 40),
      limited: parsed.omittedOversizedContent || parsed.text.length >= 12_000 || parsed.links.length >= 100 || uniqueLinks.length > 40 });
  }
  if (!sources.length && !selectedCases.length) throw createError({ statusCode: 409, statusMessage: 'Aktuellt sparat observationsunderlag saknas för planeringen.' });
  if (sources.some(source => source.limited)) limitations.push('Källtext eller länkar är begränsade; planen är ingen fullständig sidinventering.');
  const input = missionPlanningInputSchema.parse({ schemaVersion: 1, goal: redact(mission.config.goal), intent: mission.intent, target, allowedOrigins: mandate.allowedOrigins,
    browserExecution: MISSION_PLANNING_BROWSER_EXECUTION, maxCases: selectedCases.length ? mandate.limits.maxCases : Math.min(DEFAULT_NEW_MISSION_CASES, mandate.limits.maxCases), sources, selectedCases, limitations: [...new Set(limitations)].slice(0, 20) });
  // Long query strings can consume more context than page text. Keep earlier
  // observed navigation first and disclose deterministic truncation.
  while (!selectedCases.length && JSON.stringify(input).length > MAX_PLANNING_CONTEXT_CHARS) {
    const last = [...input.sources].reverse().find(source => source.links.length);
    if (!last) throw createError({ statusCode: 409, statusMessage: 'Planeringsunderlaget ryms inte inom kontextbudgeten.' });
    last.links.pop(); last.limited = true;
    const note = 'Länkunderlaget har avgränsats till planeringens kontextbudget.';
    if (!input.limitations.includes(note)) input.limitations.push(note);
  }
  return input;
}
/** Called only inside the controller terminal transaction, while its exact
 * mission lock is held. Diagnostic and retry intent cannot be split by a crash. */
export async function recordMissionPlanningFailure(tx: WorkspaceDatabase, mission: ControlledMission, attempt: MissionAttempt, diagnostic: MissionPlanningFailure, usage: MissionAttemptUsage) {
  const safe = missionPlanningFailureSchema.parse(diagnostic), measured = missionAttemptUsageSchema.parse(usage);
  const [prepared] = await tx.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, `planning-input:${attempt.id}`)));
  const [task] = await tx.select().from(schema.missionTasks).where(and(eq(schema.missionTasks.id, attempt.taskId), eq(schema.missionTasks.missionId, mission.id)));
  const family = await tx.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.missionId, mission.id), eq(schema.missionAttempts.operationId, attempt.operationId)));
  const sameEpoch = family.filter(value => value.planRevision === attempt.planRevision && value.mandateRevision === attempt.mandateRevision);
  const originalDeadlineAt = new Date(Math.min(...sameEpoch.map(value => value.deadlineAt.getTime()), attempt.deadlineAt.getTime()));
  const now = await databaseNow(tx), mandate = currentMandate(mission);
  const retry = attempt.kind === 'planning' && attempt.runtime === mission.runtime && attempt.missionId === mission.id
    && task?.spec?.kind === 'planning' && task.state === 'running' && task.planRevision === mission.planRevision
    && prepared?.payload.plannerVersion === MISSION_PLANNER_VERSION && typeof prepared.payload.fingerprint === 'string'
    && planningFailureAllowsRepair(safe) && measured.tokens !== null && measured.tokens !== undefined
    && !!measured.provider && measured.provider.providerCalls > 0 && measured.provider.unknownCalls === 0 && measured.provider.totalTokens !== null
    && family.length < mandate.limits.maxOperationAttempts && originalDeadlineAt > now && !!mission.deadlineAt && mission.deadlineAt > now
    && attempt.mandateRevision === mission.mandateRevision && attempt.planRevision === mission.planRevision && !attempt.cancelRequestedAt
    && ['accepted', 'running', 'waiting'].includes(mission.lifecycle!) && autonomyEnabled();
  await recordMissionEvent(tx, mission, 'planning_failed', { version: 1, attemptId: attempt.id, taskId: attempt.taskId,
    operationId: attempt.operationId, plannerVersion: MISSION_PLANNER_VERSION, fingerprint: prepared?.payload.fingerprint ?? null,
    diagnostic: safe, retryScheduled: retry, originalDeadlineAt: originalDeadlineAt.toISOString() }, `planning-failure:${attempt.id}`);
  return retry;
}
/** Reuse normal logical retries, but never extend the original operation's
 * deadline or silently substitute new input while repairing its failed draft. */
async function planningRetryContext(tx: WorkspaceDatabase, context: Awaited<ReturnType<typeof planningContext>>) {
  const { mission, attempt } = context;
  const family = await tx.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.missionId, mission.id), eq(schema.missionAttempts.operationId, attempt.operationId),
    eq(schema.missionAttempts.planRevision, attempt.planRevision), eq(schema.missionAttempts.mandateRevision, attempt.mandateRevision)));
  const originalDeadline = new Date(Math.min(...family.map(value => value.deadlineAt.getTime()), attempt.deadlineAt.getTime()));
  if (originalDeadline < attempt.deadlineAt) {
    await tx.update(schema.missionAttempts).set({ deadlineAt: originalDeadline }).where(eq(schema.missionAttempts.id, attempt.id));
    attempt.deadlineAt = originalDeadline;
  }
  const previous = family.filter(value => value.attemptNo < attempt.attemptNo).sort((a, b) => b.attemptNo - a.attemptNo)[0];
  if (!previous) return { deadlineAt: originalDeadline, fingerprint: null, repair: undefined };
  const [input] = await tx.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, `planning-input:${previous.id}`)));
  if (input && input.payload.plannerVersion !== MISSION_PLANNER_VERSION) throw createError({ statusCode: 409, statusMessage: 'Planerarens kontrakt har ändrats; det gamla försöket återupptas inte.' });
  const [failure] = await tx.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, `planning-failure:${previous.id}`)));
  const parsed = missionPlanningFailureSchema.safeParse(failure?.payload.diagnostic);
  const repair = failure?.payload.retryScheduled === true && parsed.success && planningFailureAllowsRepair(parsed.data) ? parsed.data : undefined;
  const [started] = await tx.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, `planning-model:${previous.id}`)));
  // Generic lease recovery may mark a direct task pending. Once physical
  // admission was recorded, only a measured structural failure permits repair;
  // a missing response after a crash remains unknown and cannot be replayed.
  if (started && (!repair || !previous.usage?.provider || previous.usage.provider.providerCalls !== 1
    || previous.usage.provider.unknownCalls !== 0 || previous.usage.provider.totalTokens === null)) {
    throw createError({ statusCode: 409, statusMessage: 'Det tidigare planeringsanropets utfall är inte säkert att återta automatiskt.' });
  }
  return { deadlineAt: originalDeadline, fingerprint: input?.payload.fingerprint ?? null, repair };
}

/** Short snapshot transaction; model work must happen after this returns. */
export async function prepareMissionPlanning(lease: MissionLease, attemptId: string) {
  return db.transaction(async tx => {
    const context = await planningContext(tx, lease, attemptId);
    if (context.completed) return { status: 'completed' as const, result: context.completed.payload.result as MissionPlanningResult };
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${context.mission.workspaceId}`}, 0))`);
    await claimedMission(tx, lease);
    const retry = await planningRetryContext(tx, context);
    await requireActivePlanning(tx, context);
    const input = await buildPlanningInput(tx, context.mission, context.task), fingerprint = missionHash({ plannerVersion: MISSION_PLANNER_VERSION, input });
    if (retry.fingerprint !== null && retry.fingerprint !== fingerprint) throw createError({ statusCode: 409, statusMessage: 'Planeringsunderlaget ändrades; det tidigare försöket återtas inte automatiskt.' });
    const eventKey = `planning-input:${attemptId}`;
    const [prior] = await tx.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, context.mission.id), eq(schema.missionEvents.eventKey, eventKey)));
    if (prior && prior.payload.fingerprint !== fingerprint) throw createError({ statusCode: 409, statusMessage: 'Planeringsunderlaget ändrades. Ett nytt avgränsat försök krävs.' });
    if (!prior) await recordMissionEvent(tx, context.mission, 'planning_prepared', { attemptId, fingerprint, plannerVersion: MISSION_PLANNER_VERSION }, eventKey);
    await claimedMission(tx, lease);
    return { status: 'prepared' as const, input, fingerprint, deadlineAt: retry.deadlineAt, repair: retry.repair };
  });
}

/** One physical planning invocation per logical attempt. The fixed single-step
 * SDK workflow uses no tools or automatic retries; a crash keeps its reservation
 * unknown and can only recover through a separately admitted logical attempt. */
export async function admitMissionPlanningModel(lease: MissionLease, attemptId: string, fingerprint: string) {
  return db.transaction(async tx => {
    const context = await planningContext(tx, lease, attemptId), { mission, attempt } = context;
    await requireActivePlanning(tx, context);
    const [prepared] = await tx.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, `planning-input:${attempt.id}`)));
    if (prepared?.payload.plannerVersion !== MISSION_PLANNER_VERSION || prepared.payload.fingerprint !== fingerprint) throw createError({ statusCode: 409, statusMessage: 'Planeringsanropet saknar rätt frysta indata.' });
    const key = `planning-model:${attempt.id}`;
    const [started] = await tx.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, key)));
    if (started) throw createError({ statusCode: 409, statusMessage: 'Planeringsanropets fysiska start är redan registrerad.' });
    await recordMissionEvent(tx, mission, 'planning_model_started', { version: 1, attemptId: attempt.id, dispatchId: attempt.dispatchId,
      operationId: attempt.operationId, requestHash: attempt.requestHash, mandateRevision: attempt.mandateRevision, planRevision: attempt.planRevision,
      fingerprint, plannerVersion: MISSION_PLANNER_VERSION, invocationId: `${attempt.dispatchId}:planner:0` }, key);
    await requireActivePlanning(tx, context);
  });
}

/** A late measurement is history, not authorization. Record it under the exact
 * immutable attempt/input identity even after pause, cancellation or closure.
 * Unknown fields may become known for that invocation; known fields never
 * change and an older unknown receipt cannot erase a later measurement. */
export async function recordMissionPlanningUsage(original: MissionAttempt, fingerprint: string, value: MissionAttemptUsage) {
  const usage = missionAttemptUsageSchema.parse(value);
  if (!usage.provider) return; // A missing meter is not a measured zero.
  if (usage.provider.providerCalls > 1 || usage.tokens !== usage.provider.totalTokens || (usage.toolCalls ?? 0) !== 0) throw createError({ statusCode: 409, statusMessage: 'Planeringsmätningen matchar inte ett enda fysiskt anrop.' });
  return db.transaction(async tx => {
    await lockMission(tx, original.missionId);
    const [mission] = await tx.select().from(schema.missions).where(and(eq(schema.missions.id, original.missionId), eq(schema.missions.runtime, runtimeScope())));
    const [attempt] = await tx.select().from(schema.missionAttempts).where(eq(schema.missionAttempts.id, original.id));
    if (!mission || !attempt || attempt.kind !== 'planning' || attempt.missionId !== mission.id || attempt.runtime !== mission.runtime
      || ['dispatchId', 'operationId', 'requestHash', 'taskId', 'mandateRevision', 'planRevision'].some(key => attempt[key as keyof MissionAttempt] !== original[key as keyof MissionAttempt])) throw createError({ statusCode: 409, statusMessage: 'Planeringsmätningens ursprung matchar inte försöket.' });
    await requireWorkspace(mission.userId, mission.workspaceId, tx);
    const rows = await tx.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), inArray(schema.missionEvents.eventKey,
      [`planning-input:${attempt.id}`, `planning-model:${attempt.id}`, `planning-usage:${attempt.id}`, `planning-usage-refined:${attempt.id}`])));
    const prepared = rows.find(event => event.eventKey === `planning-input:${attempt.id}`);
    const started = rows.find(event => event.eventKey === `planning-model:${attempt.id}`);
    const identity = { version: 1, attemptId: attempt.id, dispatchId: attempt.dispatchId, operationId: attempt.operationId, requestHash: attempt.requestHash,
      mandateRevision: attempt.mandateRevision, planRevision: attempt.planRevision, fingerprint, plannerVersion: MISSION_PLANNER_VERSION, invocationId: `${attempt.dispatchId}:planner:0` };
    if (prepared?.payload.fingerprint !== fingerprint || prepared.payload.plannerVersion !== MISSION_PLANNER_VERSION
      || usage.provider!.providerCalls > 0 && (!started || missionHash(started.payload) !== missionHash(identity))) throw createError({ statusCode: 409, statusMessage: 'Planeringsmätningen saknar ett matchande fysiskt startkvitto.' });
    // A denied repeated admission has a fresh empty meter. It cannot declare
    // that an earlier recorded start did not spend anything after a crash.
    if (started && usage.provider!.providerCalls === 0) throw createError({ statusCode: 409, statusMessage: 'Ett tidigare startat planeringsanrop kan inte bokföras som ett nytt nollanrop.' });
    const first = rows.find(event => event.eventKey === `planning-usage:${attempt.id}`);
    const refined = rows.find(event => event.eventKey === `planning-usage-refined:${attempt.id}`);
    const prior = (refined ?? first)?.payload.usage as MissionAttemptUsage | undefined;
    if (prior) {
      if (missionHash(prior) === missionHash(usage) || first && missionHash(first.payload.usage) === missionHash(usage)) return attempt.usage;
      const old = prior.provider!;
      const compatible = old.providerCalls === usage.provider!.providerCalls && usage.provider!.unknownCalls <= old.unknownCalls
        && (['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'durationMs'] as const).every(key => old[key] === null || old[key] === usage.provider![key]);
      if (refined || !compatible || old.unknownCalls === 0 || usage.provider!.unknownCalls !== 0 || usage.provider!.totalTokens === null) throw createError({ statusCode: 409, statusMessage: 'Planeringsmätningen motsäger redan sparad historik.' });
    }
    const saved = { ...attempt.usage, ...usage, toolCalls: Math.max(attempt.usage?.toolCalls ?? 0, attempt.toolCalls, usage.toolCalls ?? 0) };
    await tx.update(schema.missionAttempts).set({ usage: saved }).where(eq(schema.missionAttempts.id, attempt.id));
    // Unlike a workflow event, accounting must not change wake-up, dirty-state,
    // phase, task, mandate or completion. Allocate audit sequence only.
    const revision = mission.revision + 1;
    await tx.update(schema.missions).set({ revision }).where(eq(schema.missions.id, mission.id));
    await tx.insert(schema.missionEvents).values({ id: randomUUID(), missionId: mission.id, revision, kind: 'planning_usage_recorded',
      payload: { ...identity, usage }, eventKey: `${prior ? 'planning-usage-refined' : 'planning-usage'}:${attempt.id}` });
    return saved;
  });
}
/** All plan material, case selection and following tasks commit together. */
export async function persistMissionPlanning(lease: MissionLease, attemptId: string, fingerprint: string, draft: unknown, value: MissionAttemptUsage) {
  const usage = missionAttemptUsageSchema.parse(value);
  return db.transaction(async tx => {
    const context = await planningContext(tx, lease, attemptId), { mission, task, attempt } = context, draftHash = missionHash(draft);
    if (context.completed) {
      if (context.completed.payload.attemptId !== attemptId || context.completed.payload.fingerprint !== fingerprint || context.completed.payload.draftHash !== draftHash) throw createError({ statusCode: 409, statusMessage: 'Planeringskvittot har redan ett annat innehåll.' });
      return context.completed.payload.result as MissionPlanningResult;
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${mission.workspaceId}`}, 0))`);
    await claimedMission(tx, lease); await requireActivePlanning(tx, context);
    const [prepared] = await tx.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.eventKey, `planning-input:${attemptId}`)));
    const input = await buildPlanningInput(tx, mission, task);
    if (!prepared || prepared.payload.fingerprint !== fingerprint || missionHash({ plannerVersion: MISSION_PLANNER_VERSION, input }) !== fingerprint) throw createError({ statusCode: 409, statusMessage: 'Planeringsunderlaget har ändrats. Inget nytt test har startats.' });
    let itemId: string | null = null, version: number | null = null;
    let selections = input.selectedCases;
    const limitations = [...input.limitations];
    if (!selections.length) {
      const parsed = validateMissionPlanningDraft(input, draft), redact = await missionRedactor(tx, mission.workspaceId);
      const safe = redactMissionValue(parsed, redact);
      const content = testPlanSchema.parse({ kind: 'test_plan', summary: `${safe.summary}\n\nUtforskande förväntningar är hypoteser, inte fastställda produktkrav.\n${safe.limitations.join('\n')}`,
        cases: safe.cases.map(testCase => plannedTestCase(testCase, randomUUID())), sources: input.sources.map(({ itemId, version }) => ({ itemId, version })) });
      const item = await saveItem(mission.userId, mission.workspaceId, { title: safe.title, content, threadId: mission.threadId }, tx, { provenance: { version: 1, origin: 'agent', producer: 'agent-authored', observedAt: null } });
      itemId = item.id; version = item.version; limitations.push(...safe.limitations);
      selections = content.cases.map(testCase => ({ key: `${item.id}:${testCase.id}`, testCase, version: item.version, sourceHash: missionHash({ content, version: item.version }) }));
    } else if (draft !== null) throw createError({ statusCode: 409, statusMessage: 'Befintliga testfall ska användas utan omskrivning.' });
    const caseKeys = selections.map(c => c.key), blockedCases = selections.flatMap(c => c.testCase.type !== 'browser'
      ? [{ caseKey: c.key, reason: `Testtypen ${c.testCase.type} stöds inte av den autonoma webbkörningen.` }]
      : !caseReady(c.testCase) ? [{ caseKey: c.key, reason: 'Testfallet saknar titel, steg eller förväntat resultat.' }] : []);
    const planVersions = [...new Map(selections.map(c => [c.key.split(':')[0]!, { itemId: c.key.split(':')[0]!, version: c.version }])).values()];
    const config = missionConfigSchema.parse({ ...mission.config, caseKeys, criteria: mission.config.criteria.map(criterion => task.criterionIds.includes(criterion.id) && criterion.delivery?.kind !== 'regression_comparison'
      ? { ...criterion, delivery: { kind: 'test_cases', caseKeys } } : criterion) });
    const [updated] = await tx.update(schema.missions).set({ config, phase: 'execute' }).where(eq(schema.missions.id, mission.id)).returning();
    const taskIds: string[] = [], runnable = caseKeys.filter(key => !blockedCases.some(blocked => blocked.caseKey === key));
    if (runnable.length) {
      const next = await addMissionTask(tx, updated!, { operationId: `browser:${mission.planRevision}:0`, title: 'Genomför planens webbtester', criterionIds: task.criterionIds,
        dependsOn: [task.id], spec: { kind: 'browser_tests', caseKeys: runnable, target: input.target, planVersions } });
      taskIds.push(next.id);
    }
    if (blockedCases.length) {
      const blocked = await addMissionTask(tx, updated!, { operationId: `browser:${mission.planRevision}:unsupported`, title: 'Testfall som behöver annan utförare', criterionIds: task.criterionIds,
        dependsOn: [task.id], spec: { kind: 'browser_tests', caseKeys: blockedCases.map(c => c.caseKey), target: input.target, planVersions } });
      await tx.update(schema.missionTasks).set({ state: 'blocked', blockedReason: [...new Set(blockedCases.map(c => c.reason))].join(' '), updatedAt: await databaseNow(tx) }).where(eq(schema.missionTasks.id, blocked.id));
      taskIds.push(blocked.id);
    }
    const refs = [...new Set(selections.map(c => c.key.split(':')[0]!))].map(id => ({ type: 'material' as const, id }));
    const results = await Promise.all(refs.map(ref => readMissionSource(tx, mission.workspaceId, ref.type, ref.id)));
    const now = await databaseNow(tx), result: MissionPlanningResult = { itemId, version, caseKeys, taskIds, planVersions, blockedCases, limitations: [...new Set(limitations)] };
    await tx.update(schema.missionTasks).set({ state: 'completed', sources: refs, results, updatedAt: now }).where(eq(schema.missionTasks.id, task.id));
    // A late model receipt may have refined this attempt between the caller's
    // return and this locked publication. Never overwrite it with older usage.
    const settledUsage = attempt.usage?.provider ? attempt.usage : usage;
    await tx.update(schema.missionAttempts).set({ status: 'completed', usage: { ...settledUsage, toolCalls: Math.max(settledUsage.toolCalls ?? 0, attempt.toolCalls) },
      receipt: { version: 1, dispatchId: attempt.dispatchId, sourceType: 'material', sourceId: refs[0]!.id, status: 'completed', sequence: 1, receivedAt: now.toISOString() }, finishedAt: now, updatedAt: now, leaseToken: null, leaseUntil: null }).where(eq(schema.missionAttempts.id, attempt.id));
    await recordMissionEvent(tx, updated!, 'planning_completed', { attemptId, fingerprint, draftHash, result, plannerVersion: MISSION_PLANNER_VERSION }, completedKey(task.id));
    // clock_timestamp rather than transaction time: locks/SQL may have waited.
    await claimedMission(tx, lease);
    if (attempt.deadlineAt <= await databaseNow(tx)) throw createError({ statusCode: 409, statusMessage: 'Planeringens tidsbudget tog slut innan planen sparades.' });
    return result;
  });
}
