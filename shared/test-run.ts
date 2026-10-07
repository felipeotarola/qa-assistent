import { z } from 'zod';
import { missionBindingSchema } from './mission-binding.ts';
import type { TestCase } from './test-plan';
import type { RunReview } from './test-requirement';
import type { AssessmentView } from './result-assessment';
import { observationScopeSchema, testTargetSchema, type TestTarget } from './test-target.ts';
import { toolJson } from './tool-json.ts';
export { testTargetSchema, type TestTarget } from './test-target.ts';

// Normalize gateway representations only at the tool boundary. The canonical
// persisted target still owns identity validation and observation refinements.
const toolTestTargetSchema = toolJson(z.object({
  ...testTargetSchema.shape,
  scope: toolJson(observationScopeSchema, 2000).optional(),
}), 20000).pipe(testTargetSchema);

const runCheckSchema = z.object({
    id: z.string().max(80),
    status: z.enum(['verified', 'mismatch', 'unverified', 'blocked']),
    actual: z.string().trim().min(1).max(5000),
});
const resultFields = {
  outcome: z.enum(['passed', 'failed', 'inconclusive', 'blocked', 'interrupted']),
  actual: z.string().trim().min(1).max(20000),
  observations: z.array(z.object({ title: z.string().trim().min(1).max(300), detail: z.string().trim().min(1).max(5000), kind: z.enum(['note', 'requirement_gap', 'defect']).optional() })).max(30),
  evidenceItemIds: z.array(z.string().uuid()).max(30),
};
// Keep historical receipts unchanged. Legacy prose is never interpreted as a
// declaration of completeness, nor silently upgraded to the typed contract.
const legacyRunResultSchema = z.object({
  ...resultFields,
  schemaVersion: z.never().optional(),
  remaining: z.never().optional(),
  suggestedFollowUps: z.never().optional(),
  checks: z.array(runCheckSchema).max(200).optional(),
  unverified: z.string().max(10000),
}).refine(r => r.outcome !== 'passed' || (!r.unverified.trim() && r.observations.every(o => o.kind === 'note') && (!r.checks || r.checks.every(c => c.status === 'verified'))), 'Unverified requirements or unresolved observations cannot be passed');
export const runResultV2Schema = z.object({
  ...resultFields,
  schemaVersion: z.literal(2),
  checks: z.array(runCheckSchema).max(200).describe('Exactly one result for every original check returned by START, including blocked or untested checks.'),
  remaining: z.array(z.object({
    checkId: z.string().min(1).max(80),
    reason: z.string().trim().min(1).max(5000),
  }).strict()).max(200).describe('Exactly the original checks marked unverified or blocked, with reasons. Use [] when none remain; do not put completion prose or optional suggestions here.'),
  suggestedFollowUps: z.array(z.string().trim().min(1).max(2000)).max(10).optional().describe('Optional new testing ideas outside the original checks. Informational only: these do not grant permission or schedule more work. Never move unmet original checks here.'),
}).strict().superRefine((result, ctx) => {
  const incomplete = result.checks.filter(check => ['unverified', 'blocked'].includes(check.status));
  const remaining = result.remaining.map(check => check.checkId);
  if (new Set(result.checks.map(check => check.id)).size !== result.checks.length || new Set(remaining).size !== remaining.length
    || remaining.length !== incomplete.length || remaining.some(id => !incomplete.some(check => check.id === id))) {
    ctx.addIssue({ code: 'custom', message: 'Remaining scope must identify exactly the unverified or blocked checks, once each.' });
  }
  if (result.outcome === 'passed' && (result.remaining.length || result.checks.some(check => check.status !== 'verified') || result.observations.some(observation => observation.kind !== 'note'))) {
    ctx.addIssue({ code: 'custom', message: 'Unverified requirements or unresolved observations cannot be passed' });
  }
});
export const runResultSchema = z.union([runResultV2Schema, legacyRunResultSchema]);
const commonRunActions = [
  z.object({ action: z.literal('list'), itemId: z.string().uuid() }),
  z.object({ action: z.literal('assess'), runId: z.string().uuid() }),
  z.object({ action: z.literal('start'), mission: missionBindingSchema.optional(), itemId: z.string().uuid(), caseId: z.string().uuid(), expectedVersion: z.union([z.number(), z.string().regex(/^[1-9]\d*$/).transform(Number)]).pipe(z.number().int().positive()), requestId: z.string().uuid(), environment: z.string().trim().min(1).max(1000), target: toolTestTargetSchema.optional() }),
] as const;
// API accepts old immutable receipts; models only author the current contract.
export const testRunActionSchema = z.discriminatedUnion('action', [
  ...commonRunActions,
  z.object({ action: z.literal('finish'), runId: z.string().uuid(), result: toolJson(runResultSchema) }),
]);
export const testRunToolActionSchema = z.discriminatedUnion('action', [
  ...commonRunActions,
  z.object({ action: z.literal('finish'), runId: z.string().uuid(), result: toolJson(runResultV2Schema) }),
]);
export type RunResult = z.infer<typeof runResultSchema>;

/** Display and delivery use explicit scope; legacy text stays conservative. */
export function runResultScope(result: RunResult | null | undefined): { remaining: { checkId: string | null; reason: string }[]; suggestedFollowUps: string[] } {
  if (result === null || result === undefined) return { remaining: [], suggestedFollowUps: [] };
  // Reads may encounter malformed historical JSON even though current writes
  // are validated. Missing scope is unknown, never an implicit completed run.
  if (!runResultSchema.safeParse(result).success) return {
    remaining: [{ checkId: null, reason: 'Resultatets återstående omfattning saknas eller är ogiltig.' }], suggestedFollowUps: [],
  };
  return result.schemaVersion === 2
    ? { remaining: result.remaining, suggestedFollowUps: result.suggestedFollowUps ?? [] }
    : { remaining: result.unverified.trim() ? [{ checkId: null, reason: result.unverified }] : [], suggestedFollowUps: [] };
}

// Derived from the immutable run snapshot, never from the agent's narrowed task.
export function runChecks(snapshot: TestCase) {
  const steps = snapshot.checksVersion === 2
    ? snapshot.steps.split(/(?=^[\t ]*\d+[.)][\t ]+)/m).filter(s => s.trim())
    : snapshot.steps.trim().split(/(?:^|\s+)(?=\d+[.)]\s)/).filter(s => s.trim());
  return [
    ...(snapshot.preconditions.trim() ? [{ id: 'preconditions', requirement: snapshot.preconditions }] : []),
    ...steps.map((requirement, index) => ({ id: `step-${index + 1}`, requirement: requirement.trim() })),
    { id: 'expected', requirement: snapshot.expected },
  ];
}

export function runVerificationError(snapshot: TestCase, result: RunResult): string | null {
  const required = runChecks(snapshot);
  const checks = result.checks ?? [];
  if (new Set(checks.map(c => c.id)).size !== checks.length || checks.some(c => !required.some(r => r.id === c.id))) return 'Unknown or duplicate check IDs. Use the checks returned by START.';
  if (result.schemaVersion === 2) {
    if (!runResultV2Schema.safeParse(result).success) return 'Remaining scope must agree with the original check results.';
    if (checks.length !== required.length) return 'Include every START check exactly once, also when blocked or interrupted. Mark untested checks unverified or blocked and include them in remaining.';
  }
  if (result.outcome !== 'passed') return null;
  if (!snapshot.steps.trim() || !snapshot.expected.trim()) return 'Incomplete test definition cannot pass.';
  if (checks.length !== required.length || required.some(r => !checks.some(c => c.id === r.id && c.status === 'verified'))) return 'Full case verification required. Assess every START check, including all original steps and expected behavior. Save partial coverage as inconclusive or blocked, never passed.';
  return null;
}

export function runCoverage(snapshot: TestCase, result: RunResult) {
  const checks = runChecks(snapshot).map(check => ({
    ...check,
    status: result.checks?.find(c => c.id === check.id)?.status ?? 'unverified',
    actual: result.checks?.find(c => c.id === check.id)?.actual ?? 'Ingen verifiering dokumenterad.',
  }));
  const steps = checks.filter(c => c.id.startsWith('step-'));
  return { recorded: Boolean(result.checks?.length), checks, total: steps.length, verified: steps.filter(c => c.status === 'verified').length };
}
export type TestRun = {
  id: string; workspaceId: string; itemId: string; caseId: string; planVersion: number;
  snapshot: TestCase; environment: string; threadId: string;
  target?: TestTarget | null;
  startedAt: string; finishedAt: string | null; result: RunResult | null;
  reviews?: RunReview[];
  assessments?: AssessmentView[];
  captures?: { id: string; itemId: string | null; url: string; title: string; action: string; error: string | null; createdAt: string }[];
};
export function effectiveRunOutcome(run: TestRun) {
  return run.reviews?.[0]?.outcome ?? run.result?.outcome ?? 'running';
}
export const runLabels = { passed: 'Godkänt', failed: 'Underkänt', inconclusive: 'Behöver bedömas', blocked: 'Blockerat', interrupted: 'Avbrutet', running: 'Påbörjat · saknar slutresultat', none: 'Ingen sparad körning' };
export function latestCaseRun(runs: TestRun[], itemId: string, caseId: string) {
  return runs.filter(r => r.itemId === itemId && r.caseId === caseId).sort((a,b) => b.startedAt.localeCompare(a.startedAt))[0];
}
