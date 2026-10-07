import { z } from 'zod';
import { regressionDeliverySchema } from './mission-regression.ts';
import { testTargetSchema } from './test-run.ts';
import { toolJson } from './tool-json.ts';
import type { EvidenceProvenance } from './evidence-provenance.ts';
import type { Assessment, RuleFinding } from './result-assessment.ts';
import type { DeliveryProjection } from './mission-delivery.ts';

export const sourceTypes = ['test', 'browser', 'setup', 'repository', 'research', 'material'] as const;
// A supported criterion needs at least one citation per selected test run.
export const MAX_CRITERION_DELIVERIES = 30;
const caseKeySchema = z.string().regex(/^[a-f0-9-]{36}:[a-f0-9-]{36}$/i);
export const criterionDeliverySchema = z.discriminatedUnion('kind', [
  regressionDeliverySchema,
  z.object({ kind: z.literal('test_cases'), caseKeys: z.array(caseKeySchema).min(1).max(MAX_CRITERION_DELIVERIES).refine(keys => new Set(keys).size === keys.length, 'Duplicate delivery cases') }),
  z.object({ kind: z.literal('source'), sourceTypes: z.array(z.enum(sourceTypes)).min(1).max(sourceTypes.length).refine(types => new Set(types).size === types.length, 'Duplicate delivery source types'),
    sourceRefs: z.array(z.object({ type: z.enum(sourceTypes), id: z.string().uuid() })).min(1).max(MAX_CRITERION_DELIVERIES)
      .refine(refs => new Set(refs.map(ref => `${ref.type}:${ref.id}`)).size === refs.length, 'Duplicate delivery sources').optional(),
  }).refine(delivery => !delivery.sourceRefs?.some(ref => !delivery.sourceTypes.includes(ref.type)), 'Exact sources must have a requested type'),
]);
export const criterionSchema = z.object({ id: z.string().regex(/^[\w-]{1,80}$/), text: z.string().trim().min(1).max(2000), delivery: criterionDeliverySchema.optional() });
export const missionConfigSchema = z.object({
  title: z.string().trim().min(1).max(200), goal: z.string().trim().min(1).max(10000),
  scope: z.string().max(5000), criteria: z.array(criterionSchema).min(1).max(50),
  target: testTargetSchema.nullable(),
  caseKeys: z.array(caseKeySchema).max(500).refine(keys => new Set(keys).size === keys.length, 'Duplicate selected cases'),
  automaticReports: z.boolean().default(true),
}).refine(c => new Set(c.criteria.map(r => r.id)).size === c.criteria.length, 'Duplicate criteria')
  .refine(c => c.criteria.every(r => r.delivery?.kind !== 'test_cases' || r.delivery.caseKeys.every(key => c.caseKeys.includes(key))), 'Criterion delivery must use selected cases')
  .refine(c => c.criteria.every(r => r.delivery?.kind !== 'regression_comparison' || c.caseKeys.includes(r.delivery.caseKey)), 'Regression comparison must use a selected case');
export type MissionConfig = z.infer<typeof missionConfigSchema>;
export type EvidenceRead = { id: string; unavailable?: boolean; reason?: string; origin?: string; text?: string; limited?: boolean; observedAt?: string | null; image?: { data: string; mediaType: string }; digest?: string };
const taskSchema = z.object({
  title: z.string().trim().min(1).max(300), actor: z.enum(['main', 'browser', 'repo', 'vps']),
  criterionIds: z.array(z.string().max(80)).min(1).max(50),
  parentId: z.string().uuid().optional(), dependsOn: z.array(z.string().uuid()).max(30).default([]),
});
export const missionActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('create'), requestId: z.string().uuid(), config: toolJson(missionConfigSchema) }),
  z.object({ action: z.literal('read'), missionId: z.string().uuid() }),
  z.object({ action: z.literal('update'), missionId: z.string().uuid(), expectedRevision: z.number().int().positive(), config: toolJson(missionConfigSchema), reason: z.string().trim().min(1).max(2000), status: z.enum(['active', 'closed']) }),
  z.object({ action: z.literal('task'), missionId: z.string().uuid(), requestId: z.string().uuid(), task: toolJson(taskSchema, 10000) }),
  z.object({ action: z.literal('attach'), missionId: z.string().uuid(), taskId: z.string().uuid(), sourceType: z.enum(sourceTypes), sourceId: z.string().uuid() }),
  z.object({ action: z.literal('report'), missionId: z.string().uuid(), retry: z.boolean().default(false) }),
]);
export { missionBindingSchema, type MissionBinding } from './mission-binding.ts';
// Version 1 records remain readable history. Only current, attested evidence may
// support a new assessment; absent policy/provenance never inherits authority.
export type EvidenceRef = { id: string; title: string; itemId: string | null; version: number | null; hash: string; kind: 'image' | 'text' | 'observation'; origin: 'tool' | 'agent' | 'user' | 'unknown' | 'source'; evidencePolicyVersion?: number; provenance?: EvidenceProvenance | null; excerpt: string; url: string | null; observedAt: string | null; unavailable: boolean };
export type WorkResult = {
  sourceRevision?: string;
  context?: { resultId: string; missionId: string; taskId: string; workspaceId: string; runtime: string; actor: string; parentId: string | null; criterionIds: string[] };
  claims?: { id: string; requirement: string; reportedStatus: string; reportedActual: string }[];
  schemaVersion: 1 | 2; sourceType: typeof sourceTypes[number]; sourceId: string; attemptId: string;
  status: 'planned' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  reportedOutcome: 'achieved' | 'partial' | 'blocked' | 'unknown';
  summary: string; limitations: string[]; target: z.infer<typeof testTargetSchema> | null;
  startedAt: string | null; finishedAt: string | null; evidence: EvidenceRef[];
  assessment: { status?: 'queued' | 'running' | 'completed' | 'failed'; finishedAt?: string | null; inputHash?: string; verdict: string; summary: string; stale: boolean; id?: string; reviewerVersion?: string; findings?: Assessment['findings']; ruleFindings?: RuleFinding[]; sourceHash?: string } | null;
};
export type MissionTaskView = { id: string; title: string; actor: string; criterionIds: string[]; parentId: string | null; dependsOn: string[]; state?: string | null; blockedReason?: string | null; sources: WorkResult[] };
export type MissionSnapshot = {
  // Missing on historical snapshots means final; partial is evidence coverage,
  // whereas this purpose identifies an intentionally intermediate delivery.
  reportPurpose?: 'interim' | 'final';
  // Content identity is separate from orchestration/event revision.
  inputFingerprint?: string;
  schemaVersion: 1 | 2; missionId: string; workspaceId: string; revision: number; config: MissionConfig;
  status: string; capturedAt: string; tasks: MissionTaskView[];
  tests: { key: string; title: string; status: string; runId: string | null; review: string; target: string; originalOutcome: string | null; manualReview: string | null }[];
  metrics: { id: string; label: string; data: { label: string; value: number }[] }[];
  gaps: string[];
  delivery?: DeliveryProjection;
};

/** Keep a source's limitations attached to that source when projecting a report.
 * A discovery without a release identity cannot invalidate a later setup probe.
 */
export function sourceScopedLimitations(result: Pick<WorkResult, 'sourceType' | 'sourceId' | 'limitations'>, taskTitle: string): string[] {
  return result.limitations.map(limitation => `${taskTitle} [${result.sourceType}:${result.sourceId}]: ${limitation}`);
}

/** Tool reports are data, never proof. Redact common credential formats before persistence. */
export function redactReportText(text: string) {
  return text.replace(/\bBearer\s+[\w.+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:[\w-]*(?:authorization|api[_-]?key|token|secret|password|anon[_-]?key|service[_-]?role[_-]?key))["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[REDACTED JWT]')
    .replace(/(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[REDACTED]@')
    .replace(/\b(?:sk-(?:proj-)?[\w-]{15,}|gh[pousr]_[\w]{20,}|sb_secret_[\w-]+)\b/g, '[REDACTED]');
}

export function workStatus(status: string): WorkResult['status'] {
  if (['completed', 'passed', 'succeeded', 'done', 'review'].includes(status)) return 'completed';
  if (['failed', 'timeout', 'interrupted', 'blocked', 'needs_configuration'].includes(status)) return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (['starting', 'running', 'queued', 'preparing', 'installing', 'cleaning', 'configuring', 'dispatch_unknown'].includes(status)) return 'running';
  return 'unknown';
}
