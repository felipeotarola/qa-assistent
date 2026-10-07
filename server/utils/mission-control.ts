import type { MissionRequestSource } from '../../shared/mission-request-context';
import { randomUUID } from 'node:crypto';
import { browserAttemptAssignment, recordBrowserReturn } from './mission-browser-return';
import { freezeMissionRegression } from './mission-regression';
import { regressionHistoryRefs } from '../../shared/mission-regression';
import { resolveReportSelection } from './report-selection';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { missions, missionTasks, missionEvents, missionAttempts, missionWaits } from '../db/schema/missions';
import { DEFAULT_MISSION_LIMITS, MISSION_CONTROLLER_VERSION, missionAdmissionSchema, missionIntakeAdmissionSchema, missionControlActionSchema, missionMandateSchema, missionTaskSpecSchema, missionWaitDeadline, typedWaitSchema, type MissionAdmission, type MissionMandate, type MissionTaskSpec, type MissionWait } from '../../shared/mission-control';
import { MAX_CRITERION_DELIVERIES, type MissionConfig } from '../../shared/mission';
import { runtimeScope } from '../../shared/runtime-scope';
import { requireWorkspace, type WorkspaceDatabase } from './workspaces';
import { missionHash, readMissionSource } from './mission-sources';
import { ownedMission } from './missions';
import { missionRedactor, redactMissionValue } from './mission-redaction';
import { getThreadForUser } from './threads';
import { hasTargetIdentity, sameTarget } from '../../shared/test-target';
import { authorizeEnvironmentConsent } from './environment-consents';

export type ControlledMission = typeof missions.$inferSelect;
export const activeAttemptStates = ['reserved', 'dispatching', 'dispatch_unknown', 'running'];
export function autonomyEnabled() { return process.env.MISSIONS_ENABLED !== 'false' && process.env.AUTONOMOUS_MISSIONS_ENABLED === 'true'; }
export async function lockMission(connection: WorkspaceDatabase, id: string) {
  await connection.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mission:${id}`}, 0))`);
}
/** All callers hold the mission lock; use the returned row after every event. */
export async function recordMissionEvent(connection: WorkspaceDatabase, mission: ControlledMission, kind: string, payload: Record<string, unknown>, eventKey?: string) {
  const [current] = await connection.select().from(missions).where(eq(missions.id, mission.id));
  if (!current) throw createError({ statusCode: 404 });
  const [saved] = await connection.update(missions).set({ revision: current.revision + 1, updatedAt: new Date(), dirtySince: current.dirtySince ?? new Date(), nextWakeAt: new Date() }).where(eq(missions.id, mission.id)).returning();
  await connection.insert(missionEvents).values({ id: randomUUID(), missionId: mission.id, revision: saved!.revision, kind, payload, eventKey });
  return saved!;
}
export function currentMandate(mission: ControlledMission): MissionMandate {
  if (mission.controllerVersion !== MISSION_CONTROLLER_VERSION) throw createError({ statusCode: 409, statusMessage: 'Uppdraget använder inte autonom styrning.' });
  return missionMandateSchema.parse(mission.mandate);
}
function admissionMandate(admission: MissionAdmission, now: Date): MissionMandate {
  return missionMandateSchema.parse({ version: 1, intent: admission.intent, target: admission.target,
    allowedTaskKinds: admission.intent === 'report_only' ? ['review', 'report'] : admission.target?.kind === 'repository'
      ? ['discovery', 'preview_discovery', 'planning', 'repository_check', 'environment_setup', 'browser_tests', 'review', 'report'] : ['discovery', 'planning', 'browser_tests', 'review', 'report'],
    allowedOrigins: admission.target?.kind === 'public_url' ? [new URL(admission.target.url).origin] : [],
    repositoryUrls: admission.target?.kind === 'repository' ? [admission.target.url] : [], consentIds: [],
    issuedAt: now.toISOString(), deadlineAt: new Date(now.getTime() + DEFAULT_MISSION_LIMITS.workMs).toISOString(), limits: { ...DEFAULT_MISSION_LIMITS },
  });
}
export function observationTarget(admission: MissionAdmission, now: Date) {
  return admission.target?.kind === 'public_url' ? { environment: 'Publik webb', url: admission.target.url, revision: '', scope: { kind: 'observation' as const, id: randomUUID(), capturedAt: now.toISOString() } } : null;
}
export async function validateTaskMandate(connection: WorkspaceDatabase, mission: ControlledMission, spec: MissionTaskSpec) {
  const mandate = currentMandate(mission);
  if (!mandate.allowedTaskKinds.includes(spec.kind)) throw createError({ statusCode: 403, statusMessage: 'Uppgiften ligger utanför mandatet.' });
  if (spec.kind === 'browser_tests' && (!mission.config.target || !sameTarget(spec.target, mission.config.target) || spec.caseKeys.some(key => !mission.config.caseKeys.includes(key)) || !mandate.allowedOrigins.includes(new URL(spec.target.url).origin))) throw createError({ statusCode: 403, statusMessage: 'Testuppgiften avviker från uppdragets urval eller mål.' });
  if (spec.kind === 'discovery' && missionHash(spec.target) !== missionHash(mandate.target)) throw createError({ statusCode: 403 });
  if (spec.kind === 'environment_setup' && (!mandate.repositoryUrls.includes(spec.repoUrl) || spec.consentId && !mandate.consentIds.includes(spec.consentId) || spec.approvedPreparation && !mandate.consentIds.includes(spec.approvedPreparation.consentId))) throw createError({ statusCode: 403 });
  if (spec.kind === 'preview_discovery') {
    const [job] = await connection.select().from(schema.setupJobs).where(and(eq(schema.setupJobs.id, spec.setupJobId), eq(schema.setupJobs.workspaceId, mission.workspaceId), eq(schema.setupJobs.runtime, runtimeScope())));
    if (!job?.autonomy || job.autonomy.execution.missionId !== mission.id || job.autonomy.environmentExecution.phase !== 'apply'
      || !job.result?.environment || !mandate.repositoryUrls.includes(job.result.environment.repoUrl)) throw createError({ statusCode: 403, statusMessage: 'Previewn måste tillhöra uppdragets verifierade miljö.' });
  }
  if (spec.kind === 'repository_check') {
    const [repository] = await connection.select().from(schema.repositories).where(and(eq(schema.repositories.id, spec.repositoryId), eq(schema.repositories.workspaceId, mission.workspaceId)));
    if (!repository || !mandate.repositoryUrls.includes(repository.url)) throw createError({ statusCode: 403 });
  }
  if (spec.kind === 'planning' || spec.kind === 'report') for (const ref of spec.sourceRefs) await readMissionSource(connection, mission.workspaceId, ref.type, ref.id);
  if (spec.kind === 'review') for (const id of spec.runIds) await readMissionSource(connection, mission.workspaceId, 'test', id);
}
export async function addMissionTask(connection: WorkspaceDatabase, mission: ControlledMission, input: {
  operationId: string; title: string; spec: MissionTaskSpec; criterionIds?: string[]; dependsOn?: string[]; supplementRound?: number;
}) {
  const spec = missionTaskSpecSchema.parse(input.spec);
  await validateTaskMandate(connection, mission, spec);
  const criterionIds = input.criterionIds ?? mission.config.criteria.map(c => c.id);
  const dependencies = input.dependsOn ?? [];
  const [old] = await connection.select().from(missionTasks).where(and(eq(missionTasks.missionId, mission.id), eq(missionTasks.operationId, input.operationId)));
  if (old) {
    if (missionHash({ spec: old.spec, criterionIds: old.criterionIds, dependsOn: old.dependsOn, supplementRound: old.supplementRound }) !== missionHash({ spec, criterionIds, dependsOn: dependencies, supplementRound: input.supplementRound ?? 0 })) throw createError({ statusCode: 409, statusMessage: 'En logisk uppgift får inte ändras vid återförsök.' });
    return old;
  }
  if (criterionIds.some(id => !mission.config.criteria.some(c => c.id === id))) throw createError({ statusCode: 400, statusMessage: 'Okänt kriterium.' });
  const tasks = await connection.select().from(missionTasks).where(eq(missionTasks.missionId, mission.id));
  if (dependencies.some(id => !tasks.some(t => t.id === id))) throw createError({ statusCode: 400, statusMessage: 'Okänt uppgiftsberoende.' });
  if (tasks.length >= 200) throw createError({ statusCode: 409, statusMessage: 'Uppdraget har nått uppgiftsgränsen.' });
  const [task] = await connection.insert(missionTasks).values({ id: randomUUID(), requestId: randomUUID(), missionId: mission.id, title: input.title,
    actor: spec.kind === 'browser_tests' ? 'browser' : spec.kind === 'repository_check' ? 'repo' : spec.kind === 'environment_setup' ? 'vps' : 'main',
    criterionIds, dependsOn: dependencies, dependencyRequirements: dependencies.map(taskId => ({ taskId, require: 'completed' as const })),
    spec, state: 'pending', operationId: input.operationId, planRevision: mission.planRevision, supplementRound: input.supplementRound ?? 0,
  }).returning();
  return task!;
}

/** Freeze existing execution identities once, separately from the request hash.
 * Resuming a report rereads these sources; it never adopts a later test run. */
async function savedReportInputs(connection: WorkspaceDatabase, workspaceId: string, admission: MissionAdmission, selectLatest: boolean) {
  const refs = [...admission.sourceRefs];
  if (selectLatest) for (const key of admission.caseKeys) {
    const [itemId, caseId] = key.split(':');
    const [run] = await connection.select({ id: schema.testRuns.id }).from(schema.testRuns).where(and(
      eq(schema.testRuns.workspaceId, workspaceId), eq(schema.testRuns.runtime, runtimeScope()),
      eq(schema.testRuns.itemId, itemId!), eq(schema.testRuns.caseId, caseId!),
      sql`${schema.testRuns.finishedAt} is not null and ${schema.testRuns.result} is not null`,
    )).orderBy(desc(schema.testRuns.finishedAt), desc(schema.testRuns.startedAt), desc(schema.testRuns.id)).limit(1);
    if (run && !refs.some(ref => ref.type === 'test' && ref.id === run.id)) refs.push({ type: 'test', id: run.id });
  }
  if (refs.length > 200) throw createError({ statusCode: 400, statusMessage: 'Avgränsa rapporten till högst 200 sparade källor inklusive valda testkörningar.' });
  const sources = [];
  for (const ref of refs) sources.push(await readMissionSource(connection, workspaceId, ref.type, ref.id));
  const runIds = refs.filter(ref => ref.type === 'test').map(ref => ref.id);
  const runs = runIds.length ? await connection.select().from(schema.testRuns).where(and(eq(schema.testRuns.workspaceId, workspaceId), inArray(schema.testRuns.id, runIds))) : [];
  const testSources = sources.filter(source => source.sourceType === 'test');
  const firstTarget = testSources[0]?.target;
  const target = firstTarget && hasTargetIdentity(firstTarget) && testSources.every(source => source.target && hasTargetIdentity(source.target) && sameTarget(firstTarget, source.target)) ? firstTarget : null;
  const missing = admission.caseKeys.filter(key => !runs.some(run => `${run.itemId}:${run.caseId}` === key && run.finishedAt && run.result));
  const itemIds = [...new Set(runs.map(run => run.itemId))];
  const items = itemIds.length ? await connection.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.workspaceId, workspaceId), inArray(schema.workspaceItems.id, itemIds))) : [];
  const changed = runs.filter(run => !items.some(item => item.id === run.itemId && !item.deletedAt && item.version === run.planVersion));
  const limitations = [
    ...(missing.length ? [`${missing.length} valda testfall saknar en avslutad körning i det frysta urvalet. Inga nya tester startas.`] : []),
    ...(testSources.length && !target ? ['Testkällorna avser olika mål eller saknar känd målidentitet. Ingen gemensam miljö, version eller observation antas.'] : []),
    ...(changed.length ? [`${changed.length} sparade körningar avser en annan testplansversion än den aktuella. De är historiskt underlag och verifierar inte den ändrade testbeskrivningen.`] : []),
  ];
  const scope = ['Sammanställ sparade resultat. Starta inga nya tester.',
    ...(admission.caseKeys.length ? ['Körningsurvalet frystes vid rapportbeställningen till den senaste avslutade körningen per valt testfall. Uttryckligen angivna källor bevaras.'] : []), ...limitations].join(' ');
  return { refs, sources, target, scope, partial: limitations.length > 0 || sources.some(source => source.status !== 'completed'), limitations };
}

export async function acceptMission(userId: string, workspaceId: string, threadId: string, value: unknown, requestSource?: MissionRequestSource) {
  const input = missionIntakeAdmissionSchema.parse(value);
  await requireWorkspace(userId, workspaceId);
  const thread = await getThreadForUser(userId, threadId);
  if (!thread || thread.workspaceId !== workspaceId) throw createError({ statusCode: 404, statusMessage: 'Chatten hittades inte.' });
  const requestHash = missionHash(requestSource ? { input, requestSource } : input), redact = await missionRedactor(db, workspaceId);
  const redactedInput = redactMissionValue(input, redact);
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mission-create:${workspaceId}:${runtimeScope()}:${input.requestId}`}, 0))`);
    const [existing] = await tx.select().from(missions).where(and(eq(missions.workspaceId, workspaceId), eq(missions.runtime, runtimeScope()), eq(missions.requestId, input.requestId)));
    if (existing) {
      if (existing.userId !== userId || existing.requestHash !== requestHash || existing.controllerVersion !== 1) throw createError({ statusCode: 409, statusMessage: 'Begäran finns med ett annat innehåll.' });
      return existing;
    }
    if (!autonomyEnabled()) throw createError({ statusCode: 503, statusMessage: 'Nya autonoma uppdrag är pausade.' });
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspaceId}`}, 0))`);
    const admission = missionAdmissionSchema.parse({ ...redactedInput,
      sourceRefs: input.intent === 'report_only' ? await resolveReportSelection(tx, workspaceId, redactedInput.sourceRefs) : redactedInput.sourceRefs });
    for (const key of input.caseKeys) {
      const [item] = await tx.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.id, key.split(':')[0]!), eq(schema.workspaceItems.workspaceId, workspaceId)));
      if (!item || item.deletedAt || item.content.kind !== 'test_plan' || !item.content.cases.some(c => c.id === key.split(':')[1])) throw createError({ statusCode: 404, statusMessage: 'Ett valt testfall saknas i workspacet.' });
    }
    const report = input.intent === 'report_only' ? await savedReportInputs(tx, workspaceId, admission, true) : null;
    const sources = report?.sources ?? [];
    if (!report) for (const ref of admission.sourceRefs) sources.push(await readMissionSource(tx, workspaceId, ref.type, ref.id));
    if (input.intent === 'report_only' && !sources.length && !input.caseKeys.length) throw createError({ statusCode: 400, statusMessage: 'Välj det sparade underlag som ska sammanställas.' });
    const frozenAdmission = report ? { ...admission, sourceRefs: report.refs } : admission;
    const regression = admission.intent === 'regression' && admission.caseKeys.length ? await freezeMissionRegression(tx, workspaceId, admission.caseKeys) : null;
    for (const source of regression?.sources ?? []) if (!sources.some(value => value.sourceType === source.sourceType && value.sourceId === source.sourceId)) sources.push(source);
    const now = new Date(), mandate = admissionMandate(frozenAdmission, now);
    if (mandate.target?.kind === 'repository') {
      // Only previously explicit, scoped grants enter the initial mandate.
      // Plan, expiry, revision and names are checked again at actual release.
      const available = await tx.select().from(schema.environmentConsents).where(and(eq(schema.environmentConsents.workspaceId, workspaceId), eq(schema.environmentConsents.userId, userId),
        eq(schema.environmentConsents.runtime, runtimeScope()), eq(schema.environmentConsents.repoUrl, mandate.target.url), sql`${schema.environmentConsents.revokedAt} is null`, sql`${schema.environmentConsents.expiresAt} > clock_timestamp()`)).orderBy(desc(schema.environmentConsents.createdAt)).limit(30);
      mandate.consentIds = available.map(consent => consent.id);
    }
    // The user's goal remains the planning context. Generated QA criteria cover
    // the reviewed work, not proof that this report already existed before it
    // was written. Report persistence is acknowledged by the controller.
    const qaCriterion = `${report ? 'De valda testfallens befintliga' : 'Varje valt testfalls'} körningar har avslutats och deras utförda steg och faktiska utfall är underbyggda av sparat underlag och granskning. Ett underbyggt negativt utfall är ett färdigt QA-resultat; otestade eller oklara delar är leveransluckor.`;
    const criteria: MissionConfig['criteria'] = input.caseKeys.length
      ? [{ id: 'qa', text: qaCriterion, delivery: { kind: 'test_cases', caseKeys: input.caseKeys } }]
      : admission.intent === 'report_only' ? [] : [{ id: 'qa', text: qaCriterion }];
    // Explicit selection means every selected source, not any one source of
    // its type. Keep citation groups bounded while preserving exact run IDs.
    if (report) for (let offset = 0; offset < admission.sourceRefs.length; offset += MAX_CRITERION_DELIVERIES) {
      const sourceRefs = admission.sourceRefs.slice(offset, offset + MAX_CRITERION_DELIVERIES);
      criteria.push({ id: criteria.length ? `sources-${offset / MAX_CRITERION_DELIVERIES + 1}` : 'qa', text: `Varje angiven källa i urval ${offset + 1}–${offset + sourceRefs.length} har granskats mot läst underlag. Slutsatserna skiljer på underbyggda observationer, påståenden och luckor. Ett underbyggt negativt resultat är ett färdigt granskningsresultat.`,
        delivery: { kind: 'source', sourceTypes: [...new Set(sourceRefs.map(ref => ref.type))], sourceRefs } });
    }
    criteria.push(...regression?.criteria ?? []);
    const config: MissionConfig = { title: admission.title ?? admission.goal.slice(0, 160), goal: admission.goal,
      scope: report?.scope ?? 'Avgränsad QA inom angivet mål. Ingen produktkod ändras och inga konton eller köp skapas.',
      criteria,
      target: report ? report.target : observationTarget(admission, now), caseKeys: input.caseKeys, automaticReports: false,
    };
    const [mission] = await tx.insert(missions).values({ id: randomUUID(), workspaceId, userId, threadId, runtime: runtimeScope(), requestId: input.requestId, requestHash,
      controllerVersion: 1, admission: frozenAdmission, intent: admission.intent, mandate, planRevision: 1, mandateRevision: 1, lifecycle: 'accepted', phase: input.intent === 'report_only' ? 'report' : 'discover',
      config, deadlineAt: new Date(mandate.deadlineAt), fence: 0, nextWakeAt: now,
    }).returning();
    const first = await addMissionTask(tx, mission!, { operationId: 'initial:1', title: input.intent === 'report_only' ? 'Sammanställ sparat underlag' : 'Upptäck testobjektet',
      spec: report ? { kind: 'report', partial: report.partial, sourceRefs: report.refs } : { kind: 'discovery', target: input.target! },
    });
    if (sources.length || report?.limitations.length) await tx.update(missionTasks).set({ sources: [...frozenAdmission.sourceRefs, ...regressionHistoryRefs(config).filter(ref => !frozenAdmission.sourceRefs.some(saved => saved.type === ref.type && saved.id === ref.id))], results: sources, ...(report?.limitations.length ? { blockedReason: report.limitations.join(' ') } : {}) }).where(eq(missionTasks.id, first.id));
    return recordMissionEvent(tx, mission!, 'accepted', { intent: admission.intent, taskId: first.id, requestHash, ...(requestSource ? { requestSource } : {}) }, `accept:${input.requestId}`);
  });
}

export async function createMissionWait(connection: WorkspaceDatabase, mission: ControlledMission, value: Pick<MissionWait, 'reason' | 'taskIds' | 'question'> & Pick<Partial<MissionWait>, 'setupJobId'>) {
  await lockMission(connection, mission.id);
  const mandate = currentMandate(mission), now = new Date().toISOString();
  const redact = await missionRedactor(connection, mission.workspaceId);
  const wait = typedWaitSchema.parse({ ...value, question: redact(value.question), mandateRevision: mission.mandateRevision, planRevision: mission.planRevision, requestedAt: now, deadlineAt: missionWaitDeadline(mandate, now) });
  const identity = (definition: MissionWait) => missionHash({ reason: definition.reason, taskIds: [...definition.taskIds].sort(), mandateRevision: definition.mandateRevision, planRevision: definition.planRevision });
  const baseWaitKey = identity(wait);
  const previous = (await connection.select().from(missionWaits).where(eq(missionWaits.missionId, mission.id)).orderBy(desc(missionWaits.createdAt), desc(missionWaits.id)))
    .filter(row => identity(row.definition) === baseWaitKey);
  const pending = previous.find(row => row.state === 'waiting');
  if (pending) return pending;
  // Repeated scheduler observations share the open question. A later takeover
  // after an answered occurrence gets a new identity, preserving the old answer.
  // Mission locking serializes both first creation and this occurrence chain.
  const waitKey = previous[0] ? missionHash({ baseWaitKey, previousWaitId: previous[0].id }) : baseWaitKey;
  const tasks = await connection.select().from(missionTasks).where(eq(missionTasks.missionId, mission.id));
  if (wait.taskIds.some(id => !tasks.some(t => t.id === id && t.planRevision === mission.planRevision && !['completed', 'failed', 'blocked', 'cancelled'].includes(t.state!)))) throw createError({ statusCode: 400, statusMessage: 'Väntan måste gälla en aktiv uppgift i aktuell plan.' });
  const [saved] = await connection.insert(missionWaits).values({ id: randomUUID(), missionId: mission.id, waitKey, definition: wait, deadlineAt: new Date(wait.deadlineAt), state: 'waiting' }).returning();
  for (const taskId of wait.taskIds) await connection.update(missionTasks).set({ state: 'waiting', blockedReason: wait.question }).where(eq(missionTasks.id, taskId));
  await recordMissionEvent(connection, mission, 'waiting_for_user', { waitId: saved!.id, reason: wait.reason, taskIds: wait.taskIds, deadlineAt: wait.deadlineAt });
  return saved!;
}

/** User actions revoke execution immediately; adapters acknowledge cancellation
 * separately. A UI status never pretends an external process has stopped. */
export async function controlMission(userId: string, workspaceId: string, threadId: string, value: unknown, requestSource?: MissionRequestSource) {
  const action = missionControlActionSchema.parse(value);
  if (action.action === 'accept') { const { action: _action, ...input } = action; return acceptMission(userId, workspaceId, threadId, input, requestSource); }
  const redact = await missionRedactor(db, workspaceId);
  return db.transaction(async tx => {
    await lockMission(tx, action.missionId);
    let mission = await ownedMission(userId, workspaceId, action.missionId, tx);
    const mandate = currentMandate(mission), eventKey = `control:${action.requestId}`, actionHash = missionHash(action);
    const [replay] = await tx.select().from(missionEvents).where(and(eq(missionEvents.missionId, mission.id), eq(missionEvents.eventKey, eventKey)));
    if (replay) { if (replay.payload.actionHash !== actionHash) throw createError({ statusCode: 409, statusMessage: 'Begäran har redan använts.' }); return mission; }
    if (mission.mandateRevision !== action.expectedMandateRevision) throw createError({ statusCode: 409, statusMessage: 'Uppdraget har ändrats. Läs aktuell status.' });
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspaceId}`}, 0))`);
    if (action.action === 'answer') {
      const [wait] = await tx.select().from(missionWaits).where(and(eq(missionWaits.id, action.waitId), eq(missionWaits.missionId, mission.id)));
      if (!wait || wait.state !== 'waiting' || wait.deadlineAt <= new Date() || wait.definition.mandateRevision !== mission.mandateRevision || wait.definition.planRevision !== mission.planRevision || !['accepted', 'running', 'waiting'].includes(mission.lifecycle!)) throw createError({ statusCode: 409, statusMessage: 'Väntan gäller inte längre. Ett sent svar startar inget arbete.' });
      if (action.answer.kind === 'environment_consent') {
        const [consent] = await tx.select().from(schema.environmentConsents).where(and(eq(schema.environmentConsents.id, action.answer.consentId), eq(schema.environmentConsents.workspaceId, workspaceId), eq(schema.environmentConsents.userId, userId), eq(schema.environmentConsents.runtime, runtimeScope())));
        if (!consent || consent.revokedAt || consent.expiresAt <= new Date() || wait.definition.reason !== 'configuration' || !mandate.repositoryUrls.includes(consent.repoUrl)) throw createError({ statusCode: 409, statusMessage: 'Ett aktuellt medgivande för denna miljö krävs.' });
        if (wait.definition.setupJobId) {
          const tasks = await tx.select().from(missionTasks).where(and(eq(missionTasks.missionId, mission.id), inArray(missionTasks.id, wait.definition.taskIds)));
          if (tasks.length !== wait.definition.taskIds.length || tasks.some(task => task.spec?.kind !== 'environment_setup' || task.spec.phase !== 'apply'
            || task.spec.sourceSetupJobId !== wait.definition.setupJobId || task.spec.planHash !== consent.planHash || task.spec.repoUrl !== consent.repoUrl)) throw createError({ statusCode: 409, statusMessage: 'Medgivandet gäller en annan startplan.' });
          await authorizeEnvironmentConsent(userId, workspaceId, { consentId: consent.id, consentRevision: consent.revision, vaultRevision: consent.vaultRevision,
            setupJobId: wait.definition.setupJobId, expectedPlanHash: consent.planHash }, { connection: tx, deadline: new Date(Math.min(wait.deadlineAt.getTime(), mission.deadlineAt!.getTime())) });
          for (const task of tasks) if (task.spec?.kind === 'environment_setup') await tx.update(missionTasks).set({ spec: { ...task.spec, consentId: consent.id } }).where(eq(missionTasks.id, task.id));
        }
        // Executor admission checks the exact plan and Vault revision again.
        const updated = { ...mandate, consentIds: [...new Set([...mandate.consentIds, consent.id])] };
        await tx.update(missions).set({ mandate: updated, mandateRevision: mission.mandateRevision! + 1, fence: mission.fence! + 1, leaseToken: null, leaseUntil: null }).where(eq(missions.id, mission.id));
        await tx.update(missionAttempts).set({ cancelRequestedAt: new Date() }).where(and(eq(missionAttempts.missionId, mission.id), sql`${missionAttempts.status} in ('reserved','dispatching','dispatch_unknown','running')`));
        // Adding an explicit consent does not change other questions or extend
        // their deadlines. Carry them forward into the new execution epoch.
        const otherWaits = await tx.select().from(missionWaits).where(and(eq(missionWaits.missionId, mission.id), eq(missionWaits.state, 'waiting')));
        for (const other of otherWaits) {
          if (other.id === wait.id || other.definition.planRevision !== mission.planRevision || other.definition.mandateRevision !== mission.mandateRevision) continue;
          const definition = { ...other.definition, mandateRevision: mission.mandateRevision! + 1 };
          const waitKey = missionHash({ reason: definition.reason, taskIds: [...definition.taskIds].sort(), mandateRevision: definition.mandateRevision, planRevision: definition.planRevision });
          await tx.update(missionWaits).set({ definition, waitKey }).where(eq(missionWaits.id, other.id));
        }
      } else if (action.answer.kind === 'browser_returned') {
        const denied = () => createError({ statusCode: 409, statusMessage: 'Testets ursprungliga webbläsare är inte återlämnad.' });
        // One physical return cannot answer a question for several tasks. The
        // controller creates one human-browser wait per executing browser task.
        if (wait.definition.reason !== 'human_browser' || wait.definition.taskIds.length !== 1) throw denied();
        const [task] = await tx.select().from(missionTasks).where(and(eq(missionTasks.id, wait.definition.taskIds[0]!), eq(missionTasks.missionId, mission.id)));
        const [attempt] = await tx.select().from(missionAttempts).where(and(eq(missionAttempts.missionId, mission.id), eq(missionAttempts.taskId, wait.definition.taskIds[0]!)))
          .orderBy(desc(missionAttempts.attemptNo), desc(missionAttempts.createdAt), desc(missionAttempts.id)).limit(1);
        const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
        const now = new Date(clock!.now);
        if (!task || task.spec?.kind !== 'browser_tests' || task.state !== 'waiting' || task.planRevision !== mission.planRevision
          || !attempt || attempt.kind !== 'browser_tests' || attempt.runtime !== runtimeScope() || ![...activeAttemptStates, 'completed', 'failed'].includes(attempt.status)
          || attempt.mandateRevision !== mission.mandateRevision || attempt.planRevision !== mission.planRevision || attempt.cancelRequestedAt
          || attempt.createdAt > wait.createdAt || attempt.deadlineAt <= now || !mission.deadlineAt || mission.deadlineAt <= now || wait.deadlineAt <= now) throw denied();
        const [job] = await tx.select().from(schema.browserJobs).where(and(eq(schema.browserJobs.id, attempt.dispatchId), eq(schema.browserJobs.threadId, mission.threadId), eq(schema.browserJobs.runtime, runtimeScope())));
        if (!job?.sessionId || ['cancelled', 'cancelling'].includes(job.status)) throw denied();
        // Iris may end its turn when human control blocks the next model step.
        // A physical terminal receipt permits returning that exact browser;
        // the old attempt stays terminal and only a new bounded attempt may run.
        if (!activeAttemptStates.includes(attempt.status) && (!attempt.finishedAt || !['completed', 'failed'].includes(job.status))) throw denied();
        const returnedAssignment = await browserAttemptAssignment(tx, mission, attempt, job.sessionId);
        if (!returnedAssignment || returnedAssignment.sessionId !== action.answer.sessionId) throw denied();
        // Browser operations hold browser -> mission/content locks. This answer
        // already holds mission/content: do not block in the opposite order.
        const [lock] = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${`browser:${workspaceId}:${job.threadId}:${returnedAssignment.agentId}`}, 0)) as acquired`);
        if (!lock?.acquired) throw createError({ statusCode: 409, statusMessage: 'Webbläsarkontrollen uppdateras. Läs status och försök igen.' });
        // Same lock as controlBrowser(), held through the answer commit. A later
        // takeover still wins the per-operation control check in browserAction.
        const [assignment] = await tx.select().from(schema.browserAssignments).where(and(eq(schema.browserAssignments.workspaceId, workspaceId), eq(schema.browserAssignments.userId, userId),
          eq(schema.browserAssignments.id, returnedAssignment.id), eq(schema.browserAssignments.threadId, job.threadId), eq(schema.browserAssignments.agentId, returnedAssignment.agentId), eq(schema.browserAssignments.sessionId, action.answer.sessionId)));
        if (!assignment || assignment.control !== 'agent' || !assignment.expiresAt || assignment.expiresAt <= now) throw denied();
        const claims = await tx.select().from(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, attempt.id));
        if (claims.length !== 1 || claims.some(claim => claim.missionId !== mission.id || claim.workspaceId !== workspaceId || claim.runtime !== runtimeScope()
          || claim.executorResourceId !== assignment.sessionId || claim.state !== 'claimed' || claim.expiresAt <= now)) throw denied();
        await recordBrowserReturn(tx, mission, task, attempt, wait, assignment, claims[0]!);
      } else if (action.answer.kind === 'text' && ['configuration', 'authentication', 'human_browser', 'authorization'].includes(wait.definition.reason)) throw createError({ statusCode: 400, statusMessage: 'Ett textsvar ersätter inte inloggning, kontrollåterlämning eller medgivande.' });
      const declined = action.answer.kind === 'decline';
      await tx.update(missionWaits).set({ state: declined ? 'cancelled' : 'answered', answer: redactMissionValue(action.answer, redact), answerRequestId: action.requestId, answeredAt: new Date() }).where(eq(missionWaits.id, wait.id));
      const remaining = await tx.select().from(missionWaits).where(and(eq(missionWaits.missionId, mission.id), eq(missionWaits.state, 'waiting')));
      for (const id of wait.definition.taskIds) {
        const prerequisite = remaining.find(other => other.definition.planRevision === mission.planRevision && other.definition.taskIds.includes(id));
        // A timed-out/declined prerequisite is not undone by another answer.
        await tx.update(missionTasks).set({ state: declined ? 'blocked' : prerequisite ? 'waiting' : 'pending', blockedReason: declined ? 'Användaren avböjde.' : prerequisite?.definition.question ?? null }).where(and(eq(missionTasks.id, id), eq(missionTasks.state, 'waiting')));
      }
      await tx.update(missions).set({ lifecycle: 'running', nextWakeAt: new Date() }).where(eq(missions.id, mission.id));
    } else if (action.action === 'resume') {
      if (!autonomyEnabled()) throw createError({ statusCode: 503, statusMessage: 'Nya starter är pausade.' });
      if (!['paused', 'closed'].includes(mission.lifecycle!)) throw createError({ statusCode: 409, statusMessage: 'Uppdraget är inte pausat eller avslutat.' });
      const pending = await tx.select().from(missionAttempts).where(and(eq(missionAttempts.missionId, mission.id), sql`${missionAttempts.status} in ('reserved','dispatching','dispatch_unknown','running')`));
      if (pending.length) throw createError({ statusCode: 409, statusMessage: 'Tidigare utförare måste bekräfta stopp innan uppdraget kan återupptas.' });
      const now = new Date(), admission = missionAdmissionSchema.parse(mission.admission);
      const renewed = admissionMandate(admission, now);
      const report = admission.intent === 'report_only' ? await savedReportInputs(tx, workspaceId, admission, false) : null;
      const config = { ...mission.config, ...(report ? { target: report.target, scope: report.scope } : { target: admission.target?.kind === 'repository' ? null : observationTarget(admission, now) ?? mission.config.target }) };
      [mission] = await tx.update(missions).set({ mandate: renewed, mandateRevision: mission.mandateRevision! + 1, planRevision: mission.planRevision! + 1,
        lifecycle: 'accepted', status: 'active', phase: admission.intent === 'report_only' ? 'report' : 'discover', closureReason: null, closedAt: null,
        deadlineAt: new Date(renewed.deadlineAt), reportDeadlineAt: null, config, leaseToken: null, leaseUntil: null, fence: mission.fence! + 1, nextWakeAt: now,
      }).where(eq(missions.id, mission.id)).returning() as [ControlledMission];
      await tx.update(missionTasks).set({ state: 'cancelled' }).where(and(eq(missionTasks.missionId, mission.id), sql`${missionTasks.state} in ('pending','ready','waiting','running')`));
      await tx.update(missionWaits).set({ state: 'cancelled' }).where(and(eq(missionWaits.missionId, mission.id), eq(missionWaits.state, 'waiting')));
      const first = await addMissionTask(tx, mission, { operationId: `initial:${mission.planRevision}`, title: 'Återupptaget uppdrag', spec: report ? { kind: 'report', partial: report.partial, sourceRefs: report.refs } : { kind: 'discovery', target: admission.target! } });
      if (report) await tx.update(missionTasks).set({ sources: report.refs, results: report.sources, blockedReason: report.limitations.length ? report.limitations.join(' ') : null }).where(eq(missionTasks.id, first.id));
      else {
        // Reattach the original historical identities; no newest-run query.
        const refs = regressionHistoryRefs(config);
        if (refs.length) await tx.update(missionTasks).set({ sources: refs, results: [] }).where(eq(missionTasks.id, first.id));
      }
    } else {
      if (mission.lifecycle === 'closed') throw createError({ statusCode: 409, statusMessage: 'Uppdraget är redan avslutat.' });
      await tx.update(missions).set({ lifecycle: action.action === 'pause' ? 'paused' : 'cancelling', mandateRevision: mission.mandateRevision! + 1,
        closureReason: action.action === 'cancel' ? 'cancelled' : null, leaseToken: null, leaseUntil: null, fence: mission.fence! + 1, nextWakeAt: new Date(),
      }).where(eq(missions.id, mission.id));
      await tx.update(missionAttempts).set({ cancelRequestedAt: new Date() }).where(and(eq(missionAttempts.missionId, mission.id), sql`${missionAttempts.status} in ('reserved','dispatching','dispatch_unknown','running')`));
      await tx.update(missionWaits).set({ state: 'cancelled' }).where(and(eq(missionWaits.missionId, mission.id), eq(missionWaits.state, 'waiting')));
    }
    return recordMissionEvent(tx, mission, `control_${action.action}`, { actionHash, ...(action.action === 'pause' || action.action === 'cancel' ? { reason: redact(action.reason) } : {}), ...(action.action === 'answer' ? { waitId: action.waitId } : {}) }, eventKey);
  });
}
