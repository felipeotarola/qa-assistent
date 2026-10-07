import type { MissionAttemptState, MissionClosureReason, MissionLifecycle, MissionPhase, MissionWait, MissionWaitAnswer } from './mission-control.ts';
import type { MissionTelemetry } from './mission-telemetry.ts';

export type MissionDetailPresentation = { mission: MissionPresentation; telemetry: MissionTelemetry };

export const MISSION_PRESENTATION_VERSION = 1;
// An overdue observation is a diagnostic, not proof that a process stopped.
export const MISSION_OBSERVATION_GRACE_MS = 90_000;
export type MissionAllowedAction = 'pause' | 'cancel' | 'resume';
type Instant = Date | string | null;
type AnswerKind = MissionWaitAnswer['kind'];
export type MissionReportPresentation = {
  id: string; itemId: string | null; status: 'queued' | 'running' | 'completed' | 'failed' | 'unknown';
  freshness: 'current' | 'stale' | 'unknown' | 'not_applicable'; deleted: boolean;
};
export type MissionPresentation = {
  version: typeof MISSION_PRESENTATION_VERSION; id: string; threadId: string; title: string;
  intent: 'explore' | 'verify' | 'regression' | 'report_only'; lifecycle: MissionLifecycle; phase: MissionPhase;
  mandateRevision: number; closureReason: MissionClosureReason | null;
  deadlineAt: string | null; reportDeadlineAt: string | null; closedAt: string | null; observedAt: string;
  allowedActions: MissionAllowedAction[];
  waits: { id: string; reason: MissionWait['reason']; question: string; deadlineAt: string;
    status: 'waiting' | 'deadline_passed'; allowedAnswers: AnswerKind[]; setupJobId?: string }[];
  nextStep: { code: 'cleanup' | 'answer' | 'wait_expired' | 'resume' | 'report_deleted' | 'read_report' | 'delivery_failed' | 'closed' | 'delayed' | 'continue' | 'resource_wait'; text: string };
  cleanupPending: boolean;
  resources: { held: number; humanControlled: number; uncertain: number };
  execution: { active: number; overdue: number; unconfirmedDispatch: number };
  scheduler: { state: 'not_required' | 'not_due' | 'recent_observation' | 'overdue' | 'not_observed'; lastObservedAt: string | null };
  workers: { state: 'idle' | 'awaiting_receipt' | 'receipt_observed' | 'deadline_passed'; lastReceiptAt: string | null };
  report: MissionReportPresentation | null;
};

/** Internal projection input. IDs used for joins, leases and executor metadata
 * never cross into the returned allowlist. Text must already be redacted by the
 * server. UI controls are hints; the command endpoint rechecks current authority. */
export type MissionPresentationInput = {
  mission: { id: string; threadId: string; title: string; intent: MissionPresentation['intent']; lifecycle: MissionLifecycle; phase: MissionPhase;
    mandateRevision: number; planRevision: number; closureReason: MissionClosureReason | null;
    deadlineAt: Instant; reportDeadlineAt: Instant; closedAt: Instant; heartbeatAt: Instant; nextWakeAt: Instant; leaseUntil: Instant; createdAt: Instant };
  attempts: { id: string; status: MissionAttemptState; mandateRevision: number; planRevision: number; deadlineAt: Instant;
    cancelRequestedAt: Instant; receipt: { receivedAt: string } | null }[];
  claims: { attemptId: string; owner: 'agent' | 'human'; state: 'claimed' | 'releasing' | 'uncertain'; expiresAt: Instant }[];
  waits: { id: string; state: 'waiting' | 'answered' | 'expired' | 'cancelled'; deadlineAt: Instant; definition: MissionWait }[];
  report: MissionReportPresentation | null; autonomyEnabled: boolean; now: Date;
  resourceWait?: 'busy' | 'human';
};
const activeStates = new Set<MissionAttemptState>(['reserved', 'dispatching', 'dispatch_unknown', 'running']);
const iso = (value: Instant) => value === null ? null : new Date(value).toISOString();
const time = (value: Instant) => value === null ? 0 : new Date(value).getTime();

/** Pure projection of saved facts. Reading never expires waits, frees claims,
 * restarts work or manufactures a worker/scheduler heartbeat. */
export function presentMission(input: MissionPresentationInput): MissionPresentation {
  const { mission: m, now } = input, at = now.getTime();
  const active = input.attempts.filter(a => activeStates.has(a.status));
  const overdue = active.filter(a => time(a.deadlineAt) <= at).length;
  const needsCleanup = (claim: MissionPresentationInput['claims'][number]) => {
    const attempt = input.attempts.find(a => a.id === claim.attemptId);
    return ['paused', 'cancelling', 'closed'].includes(m.lifecycle) || claim.state !== 'claimed' || time(claim.expiresAt) <= at
      || !attempt || !activeStates.has(attempt.status) || attempt.cancelRequestedAt !== null
      || attempt.mandateRevision !== m.mandateRevision || attempt.planRevision !== m.planRevision;
  };
  const cleanupPending = input.claims.some(needsCleanup);
  const allowedActions: MissionAllowedAction[] = [];
  if (['accepted', 'running', 'waiting'].includes(m.lifecycle)) allowedActions.push('pause', 'cancel');
  if (m.lifecycle === 'paused') allowedActions.push('cancel');
  // Conservative until every physical claim is released, even if an executor
  // has already sent a terminal receipt. Human takeover is never auto-release.
  if (['paused', 'closed'].includes(m.lifecycle) && !active.length && !input.claims.length && input.autonomyEnabled) allowedActions.push('resume');
  const answerable = ['accepted', 'running', 'waiting'].includes(m.lifecycle);
  const waits: MissionPresentation['waits'] = input.waits.filter(w => w.state === 'waiting'
    && w.definition.mandateRevision === m.mandateRevision && w.definition.planRevision === m.planRevision).map((w): MissionPresentation['waits'][number] => {
    const expired = time(w.deadlineAt) <= at;
    const kinds: AnswerKind[] = [];
    if (answerable && !expired) {
      if (w.definition.reason === 'clarification') kinds.push('text');
      if (w.definition.reason === 'configuration') kinds.push('environment_consent');
      if (w.definition.reason === 'human_browser') kinds.push('browser_returned');
      kinds.push('decline');
    }
    return { id: w.id, reason: w.definition.reason, question: w.definition.question, deadlineAt: iso(w.deadlineAt)!,
      status: expired ? 'deadline_passed' : 'waiting', allowedAnswers: kinds,
      ...(w.definition.reason === 'configuration' && w.definition.setupJobId ? { setupJobId: w.definition.setupJobId } : {}) };
  }).sort((a, b) => a.deadlineAt.localeCompare(b.deadlineAt) || a.id.localeCompare(b.id));
  const schedulerRequired = m.lifecycle !== 'closed' && (m.lifecycle !== 'paused' || active.length > 0 || cleanupPending);
  const due = Math.max(time(m.nextWakeAt ?? m.createdAt), time(m.leaseUntil));
  const scheduler: MissionPresentation['scheduler'] = {
    state: !schedulerRequired ? 'not_required' : at < due ? 'not_due'
      : at > due + MISSION_OBSERVATION_GRACE_MS ? 'overdue' : m.heartbeatAt && at - time(m.heartbeatAt) <= MISSION_OBSERVATION_GRACE_MS ? 'recent_observation' : 'not_observed',
    // This is the last persisted controller claim, not global scheduler health.
    lastObservedAt: iso(m.heartbeatAt),
  };
  const receipts = active.flatMap(a => a.receipt ? [iso(a.receipt.receivedAt)!] : []).sort();
  const workers: MissionPresentation['workers'] = {
    state: !active.length ? 'idle' : overdue ? 'deadline_passed' : receipts.length === active.length ? 'receipt_observed' : 'awaiting_receipt',
    lastReceiptAt: receipts.at(-1) ?? null,
  };
  let nextStep: MissionPresentation['nextStep'];
  if (cleanupPending) nextStep = { code: 'cleanup', text: 'Inväntar bekräftad frigöring av kvarvarande resurser.' };
  else if (m.lifecycle === 'paused') nextStep = { code: 'resume', text: active.length ? 'Inväntar stoppbekräftelse innan uppdraget kan återupptas.'
    : !input.autonomyEnabled ? 'Nya starter är tillfälligt pausade.' : 'Återuppta för att ge uppdraget ett nytt mandat och en ny tidsgräns.' };
  else if (waits.some(w => w.allowedAnswers.length)) nextStep = { code: 'answer', text: 'Besvara den öppna frågan. Redan tillåtet oberoende arbete kan fortsätta.' };
  else if (waits.some(w => w.status === 'deadline_passed') && answerable) nextStep = { code: 'wait_expired', text: 'Svarstiden har löpt ut. Inget svar antas; inväntar styrningens sammanställning av hindret.' };
  else if (input.report?.deleted) nextStep = { code: 'report_deleted', text: 'Den sparade rapporten har tagits bort.' };
  else if (m.lifecycle === 'closed' && m.closureReason === 'delivery_failed') nextStep = { code: 'delivery_failed', text: 'Uppdraget avslutades utan bekräftad rapportleverans.' };
  else if (m.lifecycle === 'closed' && input.report?.status === 'completed') nextStep = { code: 'read_report', text: input.report.freshness === 'stale' ? 'Läs rapporten med förbehåll: dess underlag har ändrats.' : 'Öppna den sparade rapporten och dess bedömningar.' };
  else if (m.lifecycle === 'closed') nextStep = { code: 'closed', text: 'Uppdraget är avslutat. Ett avslut är inte ett testgodkännande.' };
  else if (scheduler.state === 'overdue' || overdue) nextStep = { code: 'delayed', text: 'En sparad tidsgräns har passerats. Utförarens aktuella tillstånd är inte bekräftat.' };
  else if (answerable && !active.length && input.resourceWait) nextStep = { code: 'resource_wait', text: input.resourceWait === 'human'
    ? 'Körplatsen används manuellt. Uppdraget fortsätter automatiskt när den lämnas tillbaka.'
    : 'Väntar på körplats. Ett tidigare arbete använder resursen eller inväntar bekräftad frigöring. Uppdraget fortsätter automatiskt inom sin tidsgräns.' };
  else nextStep = { code: 'continue', text: m.lifecycle === 'cancelling' ? 'Inväntar stopp och sammanställning av utfört arbete.' : 'Uppdraget fortsätter inom sitt mandat. Chatten behöver inte vara öppen.' };
  return {
    version: MISSION_PRESENTATION_VERSION, id: m.id, threadId: m.threadId, title: m.title, intent: m.intent, lifecycle: m.lifecycle, phase: m.phase,
    mandateRevision: m.mandateRevision, closureReason: m.closureReason, deadlineAt: iso(m.deadlineAt), reportDeadlineAt: iso(m.reportDeadlineAt),
    closedAt: iso(m.closedAt), observedAt: now.toISOString(), allowedActions, waits, nextStep, cleanupPending,
    resources: { held: input.claims.length, humanControlled: input.claims.filter(c => c.owner === 'human').length,
      uncertain: input.claims.filter(c => c.state === 'uncertain' || time(c.expiresAt) <= at).length },
    execution: { active: active.length, overdue, unconfirmedDispatch: active.filter(a => a.status === 'dispatch_unknown').length },
    scheduler, workers, report: input.report && { id: input.report.id, itemId: input.report.itemId, status: input.report.status, freshness: input.report.freshness, deleted: input.report.deleted },
  };
}
