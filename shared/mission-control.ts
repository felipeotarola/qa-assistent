import { z } from 'zod';
import { planDefinitionRefSchema } from './report-selection.ts';
import { providerUsageSchema } from './provider-usage.ts';
import { sourceTypes } from './mission.ts';
import { testTargetSchema } from './test-run.ts';
import { toolJson } from './tool-json.ts';
import { missionComplementSchema } from './mission-complement.ts';

export const MISSION_CONTROLLER_VERSION = 1;
export const missionIntents = ['explore', 'verify', 'regression', 'report_only'] as const;
export const missionTaskKinds = ['discovery', 'preview_discovery', 'planning', 'browser_tests', 'repository_check', 'environment_setup', 'review', 'report'] as const;
export const missionLifecycles = ['accepted', 'running', 'waiting', 'paused', 'cancelling', 'closed'] as const;
export const missionPhases = ['discover', 'plan', 'prepare', 'execute', 'review', 'complement', 'report', 'idle'] as const;
export const missionTaskStates = ['pending', 'ready', 'running', 'waiting', 'completed', 'blocked', 'failed', 'cancelled'] as const;
export const missionAttemptStates = ['reserved', 'dispatching', 'dispatch_unknown', 'running', 'completed', 'failed', 'cancelled'] as const;
export const missionClosureReasons = ['investigated', 'criteria_satisfied', 'blocked', 'budget_exhausted', 'deadline', 'cancelled', 'delivery_failed'] as const;

// Admission accounting is conservative, not an exact monetary hard cap. Known
// usage replaces its reservation; unknown usage keeps the reservation charged.
export const DEFAULT_MISSION_LIMITS = Object.freeze({
  workMs: 60 * 60_000, userWaitMs: 15 * 60_000, maxCases: 8,
  maxLogicalAttempts: 12, maxOperationAttempts: 2, maxParallel: 2, maxSupplementRounds: 2,
  maxTokens: 2_000_000, tokensPerAttempt: 100_000, browserTokensPerAttempt: 1_000_000,
  maxToolCalls: 300, toolCallsPerAttempt: 60, maxAttemptMs: 15 * 60_000,
  leaseMs: 90_000, reportDeliveryMs: 10 * 60_000, maxReportAttempts: 3,
});
const positiveInt = z.number().int().positive();
export const missionBudgetSchema = z.object({
  workMs: positiveInt.max(DEFAULT_MISSION_LIMITS.workMs),
  userWaitMs: positiveInt.max(DEFAULT_MISSION_LIMITS.userWaitMs),
  maxCases: positiveInt.max(DEFAULT_MISSION_LIMITS.maxCases),
  maxLogicalAttempts: positiveInt.max(DEFAULT_MISSION_LIMITS.maxLogicalAttempts),
  maxOperationAttempts: positiveInt.max(DEFAULT_MISSION_LIMITS.maxOperationAttempts),
  maxParallel: positiveInt.max(DEFAULT_MISSION_LIMITS.maxParallel),
  maxSupplementRounds: z.number().int().min(0).max(DEFAULT_MISSION_LIMITS.maxSupplementRounds),
  maxTokens: positiveInt.max(DEFAULT_MISSION_LIMITS.maxTokens),
  tokensPerAttempt: positiveInt.max(DEFAULT_MISSION_LIMITS.tokensPerAttempt),
  // Absent on older mandates: retain their original per-attempt allowance.
  browserTokensPerAttempt: positiveInt.max(DEFAULT_MISSION_LIMITS.browserTokensPerAttempt).optional(),
  maxToolCalls: positiveInt.max(DEFAULT_MISSION_LIMITS.maxToolCalls),
  toolCallsPerAttempt: positiveInt.max(DEFAULT_MISSION_LIMITS.toolCallsPerAttempt),
  maxAttemptMs: positiveInt.max(DEFAULT_MISSION_LIMITS.maxAttemptMs),
  leaseMs: positiveInt.max(DEFAULT_MISSION_LIMITS.leaseMs),
  reportDeliveryMs: positiveInt.max(DEFAULT_MISSION_LIMITS.reportDeliveryMs),
  maxReportAttempts: positiveInt.max(DEFAULT_MISSION_LIMITS.maxReportAttempts),
}).strict().refine(value => value.tokensPerAttempt <= value.maxTokens
  && value.toolCallsPerAttempt <= value.maxToolCalls && value.maxAttemptMs <= value.workMs
  && value.userWaitMs <= value.workMs && value.maxOperationAttempts <= value.maxLogicalAttempts,
'Per-attempt and wait limits must fit the mission budget');
export type MissionBudget = z.infer<typeof missionBudgetSchema>;

const uuid = z.string().uuid();
const instant = z.string().datetime({ offset: true });
const caseKey = z.string().regex(/^[a-f0-9-]{36}:[a-f0-9-]{36}$/i);
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const httpUrl = z.string().trim().min(1).max(2000).refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}, 'Expected an HTTP(S) URL without credentials');
// These are input formats, not SSRF authorization. Existing network checks must
// still resolve/validate every navigation and redirect at execution time.
const repositoryUrl = z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
const repositoryRef = z.string().max(150).regex(/^(?:[\w][\w./-]*)?$/).refine(value => !value.includes('..'));
function targetSchema(defaultSurface: 'checks' | 'auto') {
  return z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('public_url'), url: httpUrl }).strict(),
    z.object({ kind: z.literal('repository'), url: repositoryUrl, ref: repositoryRef.default(''), surface: z.enum(['auto', 'checks', 'application']).default(defaultSurface).describe('auto: general repository QA with no chosen test surface; inspect first, prefer an identified test/static-check command, otherwise use an observed start/dev entry with the existing environment gates. checks: explicitly requested library/CLI/test-suite/static-check scope, never broadened to browser QA. application: requested running-app or browser behavior, including conditional startup needed for that behavior.') }).strict(),
  ]);
}
// Older stored targets without a surface keep their original checks semantics.
export const missionTargetSchema = targetSchema('checks');
const missionIntakeTargetSchema = targetSchema('auto');
export const missionSourceRefSchema = z.object({ type: z.enum(sourceTypes), id: uuid }).strict();
const sourceRefs = z.array(missionSourceRefSchema).max(200).refine(values => unique(values.map(value => `${value.type}:${value.id}`)), 'Duplicate sources');
const selectedCases = z.array(caseKey).max(DEFAULT_MISSION_LIMITS.maxCases).refine(unique, 'Duplicate selected cases');
const admissionShape = {
  requestId: uuid, intent: z.enum(missionIntents), title: z.string().trim().min(1).max(200).optional(),
  goal: z.string().trim().min(1).max(10000), target: toolJson(missionTargetSchema.nullable(), 5000).default(null),
  caseKeys: selectedCases.default([]), sourceRefs: sourceRefs.default([]),
};
export const missionAdmissionSchema = z.object(admissionShape).strict()
  .refine(value => value.intent === 'report_only' || value.target !== null, 'Execution requires an explicit target');
export type MissionAdmission = z.infer<typeof missionAdmissionSchema>;
// Model intake may explicitly select a plan definition. Stored execution/source
// contracts remain canonical; only the authenticated intake resolves this alias.
const intakeAdmissionShape = { ...admissionShape, target: toolJson(missionIntakeTargetSchema.nullable(), 5000).default(null), sourceRefs: z.array(z.union([missionSourceRefSchema, planDefinitionRefSchema])).max(200)
  .refine(values => unique(values.map(value => `${value.type === 'plan_definition' ? 'material' : value.type}:${value.id}`)), 'Duplicate sources').default([]) };
export const missionIntakeAdmissionSchema = z.object(intakeAdmissionShape).strict()
  .refine(value => value.intent === 'report_only' || value.target !== null, 'Execution requires an explicit target')
  .refine(value => value.intent === 'report_only' || !value.sourceRefs.some(ref => ref.type === 'plan_definition'), 'Plan definitions are report-only selections');
export type MissionIntakeAdmission = z.infer<typeof missionIntakeAdmissionSchema>;
export type MissionTarget = z.infer<typeof missionTargetSchema>;

export const missionTaskSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('discovery'), target: missionTargetSchema }).strict(),
  z.object({ kind: z.literal('preview_discovery'), setupJobId: uuid }).strict(),
  z.object({ kind: z.literal('planning'), sourceRefs: sourceRefs.default([]) }).strict(),
  z.object({ kind: z.literal('browser_tests'), caseKeys: selectedCases.min(1), target: testTargetSchema,
    planVersions: z.array(z.object({ itemId: uuid, version: positiveInt }).strict()).max(DEFAULT_MISSION_LIMITS.maxCases).optional(),
    complement: missionComplementSchema.optional(),
  }).strict(),
  z.object({ kind: z.literal('repository_check'), repositoryId: uuid, mode: z.enum(['inspect', 'test']), script: z.string().max(80).regex(/^[\w][\w:-]*$/).optional(),
    inspectedRunId: uuid.optional(), expectedCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
    directory: z.string().max(200).optional(), args: z.array(z.string().max(300)).max(20).optional(),
  }).strict().refine(value => value.mode !== 'test' || !!value.inspectedRunId && !!value.expectedCommit, 'Test execution requires an inspected run and exact commit'),
  z.object({ kind: z.literal('environment_setup'), repoUrl: repositoryUrl, ref: repositoryRef.default(''),
    phase: z.enum(['prepare', 'apply']), inspectedRunId: uuid, expectedCommit: z.string().regex(/^[a-f0-9]{40}$/),
    sourceSetupJobId: uuid.optional(), planHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), consentId: uuid.optional(),
    approvedPreparation: z.object({ sourceSetupJobId: uuid, consentId: uuid, consentRevision: positiveInt, vaultRevision: positiveInt,
      planHash: z.string().regex(/^[a-f0-9]{64}$/), }).strict().optional(),
  }).strict().refine(value => value.phase === 'prepare' ? !value.sourceSetupJobId && !value.planHash && !value.consentId : !!value.sourceSetupJobId && !!value.planHash && !value.approvedPreparation, 'Apply requires a saved preparation plan'),
  z.object({ kind: z.literal('review'), runIds: z.array(uuid).min(1).max(DEFAULT_MISSION_LIMITS.maxCases).refine(unique, 'Duplicate runs') }).strict(),
  z.object({ kind: z.literal('report'), sourceRefs: sourceRefs.default([]), partial: z.boolean().default(false), purpose: z.enum(['interim', 'final']).optional() }).strict(),
]);
export type MissionTaskSpec = z.infer<typeof missionTaskSpecSchema>;
export type MissionTaskKind = typeof missionTaskKinds[number];
export type MissionLifecycle = typeof missionLifecycles[number];
export type MissionPhase = typeof missionPhases[number];
export type MissionTaskState = typeof missionTaskStates[number];
export const missionDependencyRequirementsSchema = z.array(z.object({ taskId: uuid, require: z.enum(['completed', 'terminal', 'available']) }).strict())
  .max(30).refine(values => unique(values.map(value => value.taskId)), 'Duplicate dependency');
export type MissionDependencyRequirement = z.infer<typeof missionDependencyRequirementsSchema>[number];
export type MissionAttemptState = typeof missionAttemptStates[number];
export type MissionClosureReason = typeof missionClosureReasons[number];

export const missionMandateSchema = z.object({
  version: z.literal(1), intent: z.enum(missionIntents), target: missionTargetSchema.nullable(),
  allowedTaskKinds: z.array(z.enum(missionTaskKinds)).min(1).refine(unique, 'Duplicate task kinds'),
  allowedOrigins: z.array(httpUrl.refine(value => new URL(value).origin === value, 'Use an exact origin')).max(20).refine(unique),
  repositoryUrls: z.array(repositoryUrl).max(10).refine(unique), consentIds: z.array(uuid).max(30).refine(unique),
  issuedAt: instant, deadlineAt: instant, limits: missionBudgetSchema,
}).strict().superRefine((value, context) => {
  const duration = Date.parse(value.deadlineAt) - Date.parse(value.issuedAt);
  if (duration <= 0 || duration > value.limits.workMs) context.addIssue({ code: 'custom', path: ['deadlineAt'], message: 'Deadline must fit the authorized work period' });
  if (value.intent === 'report_only' && value.allowedTaskKinds.some(kind => !['review', 'report'].includes(kind))) context.addIssue({ code: 'custom', path: ['allowedTaskKinds'], message: 'Report-only cannot authorize execution' });
  if (value.intent !== 'report_only' && value.target === null) context.addIssue({ code: 'custom', path: ['target'], message: 'Execution requires a target' });
  if (value.target?.kind === 'public_url' && !value.allowedOrigins.includes(new URL(value.target.url).origin)) context.addIssue({ code: 'custom', path: ['allowedOrigins'], message: 'Target origin must be explicitly authorized' });
  if (value.target?.kind === 'repository' && !value.repositoryUrls.includes(value.target.url)) context.addIssue({ code: 'custom', path: ['repositoryUrls'], message: 'Target repository must be explicitly authorized' });
});
export type MissionMandate = z.infer<typeof missionMandateSchema>;

export const missionWaitReasons = ['clarification', 'authentication', 'configuration', 'authorization', 'human_browser'] as const;
export const missionWaitAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().trim().min(1).max(5000) }).strict(),
  z.object({ kind: z.literal('environment_consent'), consentId: uuid }).strict(),
  z.object({ kind: z.literal('browser_returned'), sessionId: uuid }).strict(),
  z.object({ kind: z.literal('decline'), reason: z.string().trim().max(2000).default('') }).strict(),
]);
export type MissionWaitAnswer = z.infer<typeof missionWaitAnswerSchema>;
export const typedWaitSchema = z.object({
  reason: z.enum(missionWaitReasons), taskIds: z.array(uuid).min(1).max(30).refine(unique),
  question: z.string().trim().min(1).max(3000), mandateRevision: positiveInt, planRevision: positiveInt,
  setupJobId: uuid.optional(),
  requestedAt: instant, deadlineAt: instant,
}).strict().refine(value => Date.parse(value.deadlineAt) > Date.parse(value.requestedAt), 'Wait deadline must follow the question');
export type MissionWait = z.infer<typeof typedWaitSchema>;

const revisionAction = { missionId: uuid, requestId: uuid, expectedMandateRevision: positiveInt };
export const missionControlActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept'), ...intakeAdmissionShape }).strict()
    .refine(value => value.intent === 'report_only' || value.target !== null, 'Execution requires an explicit target')
    .refine(value => value.intent === 'report_only' || !value.sourceRefs.some(ref => ref.type === 'plan_definition'), 'Plan definitions are report-only selections'),
  z.object({ action: z.literal('pause'), ...revisionAction, reason: z.string().trim().max(2000).default('') }).strict(),
  z.object({ action: z.literal('cancel'), ...revisionAction, reason: z.string().trim().max(2000).default('') }).strict(),
  z.object({ action: z.literal('resume'), ...revisionAction }).strict(),
  z.object({ action: z.literal('answer'), ...revisionAction, waitId: uuid, answer: toolJson(missionWaitAnswerSchema, 6000) }).strict(),
]);
export type MissionControlAction = z.infer<typeof missionControlActionSchema>;

export const dispatchReceiptSchema = z.object({
  version: z.literal(1), dispatchId: uuid, sourceType: z.enum(sourceTypes), sourceId: uuid,
  status: z.enum(['accepted', 'running', 'completed', 'failed', 'cancelled', 'unknown']),
  sequence: z.number().int().nonnegative(), receivedAt: instant,
}).strict();
export type DispatchReceipt = z.infer<typeof dispatchReceiptSchema>;
export const missionAttemptUsageSchema = z.object({
  tokens: z.number().int().nonnegative().nullable(), toolCalls: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  provider: providerUsageSchema.optional(),
}).strict();
export type MissionAttemptUsage = z.infer<typeof missionAttemptUsageSchema>;
export type MissionReservation = { tokens: number; toolCalls: number; deadlineAt: string };
export type MissionAttemptBudgetView = {
  operationId: string; kind: MissionTaskKind; status: MissionAttemptState; reservedTokens: number; reservedToolCalls: number;
  usage: MissionAttemptUsage | null; toolCalls?: number;
};
const activeAttempts = new Set<MissionAttemptState>(['reserved', 'dispatching', 'dispatch_unknown', 'running']);

/** Call under the mission lock, then persist the returned reservation before dispatch. */
export function evaluateAttemptAdmission(input: {
  mandate: MissionMandate; kind: MissionTaskKind; operationId: string; attempts: MissionAttemptBudgetView[];
  now: string; supplementRound?: number; usesModel?: boolean; reportDeadlineAt?: string; reportPurpose?: 'interim' | 'final';
}): { allowed: boolean; reasons: string[]; reservation: MissionReservation } {
  const mandate = missionMandateSchema.parse(input.mandate), limits = mandate.limits;
  const now = Date.parse(instant.parse(input.now));
  const report = input.kind === 'report', interim = report && input.reportPurpose === 'interim';
  const lastReportDeadline = Date.parse(mandate.deadlineAt) + limits.reportDeliveryMs;
  const deadline = report && !interim ? Math.min(lastReportDeadline, input.reportDeadlineAt ? Date.parse(instant.parse(input.reportDeadlineAt)) : lastReportDeadline) : Date.parse(mandate.deadlineAt);
  const attempts = input.attempts.filter(attempt => report === (attempt.kind === 'report'));
  // Optional progress reporting must leave one complete final reservation.
  const reportAttempts = Math.max(0, limits.maxReportAttempts - (interim ? 1 : 0));
  const maxAttempts = report ? reportAttempts : limits.maxLogicalAttempts;
  const tokens = input.usesModel === false ? 0 : input.kind === 'browser_tests'
    ? Math.min(limits.browserTokensPerAttempt ?? limits.tokensPerAttempt, limits.maxTokens)
    : limits.tokensPerAttempt;
  const reservation = { tokens, toolCalls: limits.toolCallsPerAttempt, deadlineAt: new Date(Math.min(deadline, now + limits.maxAttemptMs)).toISOString() };
  const reasons: string[] = [];
  if (!Number.isFinite(now) || now >= deadline) reasons.push('deadline');
  if (!mandate.allowedTaskKinds.includes(input.kind)) reasons.push('task_not_authorized');
  if (attempts.length >= maxAttempts) reasons.push('logical_attempt_budget');
  if (attempts.filter(attempt => attempt.operationId === input.operationId).length >= (interim ? 1 : report ? limits.maxReportAttempts : limits.maxOperationAttempts)) reasons.push('operation_attempt_budget');
  if (attempts.some(attempt => attempt.operationId === input.operationId && activeAttempts.has(attempt.status))) reasons.push('operation_in_flight');
  if (input.attempts.filter(attempt => activeAttempts.has(attempt.status)).length >= limits.maxParallel) reasons.push('parallel_budget');
  const round = input.supplementRound ?? 0;
  if (!Number.isInteger(round) || round < 0 || round > limits.maxSupplementRounds) reasons.push('supplement_budget');
  // Until a terminal receipt confirms final usage, reserve at least the admitted
  // amount even when partial telemetry arrives during the running operation.
  const charge = (attempt: MissionAttemptBudgetView, metric: 'tokens' | 'toolCalls') => {
    const reserved = metric === 'tokens' ? attempt.reservedTokens : attempt.reservedToolCalls;
    const actual = attempt.usage?.[metric];
    const charged = actual == null ? reserved : activeAttempts.has(attempt.status) ? Math.max(reserved, actual) : actual;
    return metric === 'toolCalls' ? Math.max(charged, attempt.toolCalls ?? 0) : charged;
  };
  if (attempts.reduce((sum, attempt) => sum + charge(attempt, 'tokens'), 0) + tokens > (report ? reportAttempts * limits.tokensPerAttempt : limits.maxTokens)) reasons.push('token_budget');
  if (attempts.reduce((sum, attempt) => sum + charge(attempt, 'toolCalls'), 0) + reservation.toolCalls > (report ? reportAttempts * limits.toolCallsPerAttempt : limits.maxToolCalls)) reasons.push('tool_budget');
  return { allowed: reasons.length === 0, reasons, reservation };
}

/** Deadline passage is never approval; this only calculates a finite wait. */
export function missionWaitDeadline(mandate: MissionMandate, requestedAt: string): string {
  missionMandateSchema.parse(mandate);
  const requested = Date.parse(instant.parse(requestedAt));
  return new Date(Math.min(Date.parse(mandate.deadlineAt), requested + mandate.limits.userWaitMs)).toISOString();
}

/** Physical pool identity must come from server configuration, never runtime or user input. */
export function missionResourceIdentity(kind: 'browser' | 'otto', poolKey: string, workspaceId?: string) {
  if (!poolKey.trim() || poolKey.length > 200) throw new Error('A stable physical pool key is required');
  if (kind === 'browser') uuid.parse(workspaceId);
  return { poolKey, resourceKey: kind === 'otto' ? 'otto' : `browser:${workspaceId}` };
}

/** Shared commit/dispatch fence; runtime services must also lock and check current ownership. */
export function missionFenceMatches(current: {
  controllerVersion: number | null; lifecycle: string | null; mandateRevision: number | null;
  planRevision: number | null; leaseToken: string | null; leaseUntil: Date | string | null; fence: number | null;
}, expected: { mandateRevision: number; planRevision: number; leaseToken: string; fence: number }, now: Date | string) {
  const expiry = current.leaseUntil == null ? NaN : new Date(current.leaseUntil).getTime();
  return current.controllerVersion === MISSION_CONTROLLER_VERSION
    && ['accepted', 'running', 'waiting'].includes(current.lifecycle ?? '')
    && current.mandateRevision === expected.mandateRevision && current.planRevision === expected.planRevision
    && current.leaseToken === expected.leaseToken && current.fence === expected.fence
    && expiry > new Date(now).getTime();
}
