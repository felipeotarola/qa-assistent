import { z } from 'zod';
import { missionBindingSchema } from './mission-binding.ts';
import type { TestCase } from './test-plan';
import type { RunReview } from './test-requirement';
import type { AssessmentView } from './result-assessment';
export const testTargetSchema = z.object({
  environment: z.string().trim().max(200),
  url: z.string().trim().max(2000).refine(value => { if (!value) return true; try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }, 'Ange en http- eller https-adress utan inloggningsuppgifter'),
  revision: z.string().trim().max(200),
});
export type TestTarget = z.infer<typeof testTargetSchema>;

export const runResultSchema = z.object({
  checks: z.array(z.object({
    id: z.string().max(80),
    status: z.enum(['verified', 'mismatch', 'unverified', 'blocked']),
    actual: z.string().trim().min(1).max(5000),
  })).max(200).optional().describe('Assess every check returned by START against the original case. Never omit untested steps or narrow their scope.'),
  outcome: z.enum(['passed', 'failed', 'inconclusive', 'blocked', 'interrupted']),
  actual: z.string().trim().min(1).max(20000),
  unverified: z.string().max(10000),
  observations: z.array(z.object({ title: z.string().trim().min(1).max(300), detail: z.string().trim().min(1).max(5000), kind: z.enum(['note', 'requirement_gap', 'defect']).optional() })).max(30),
  evidenceItemIds: z.array(z.string().uuid()).max(30),
}).refine(r => r.outcome !== 'passed' || (!r.unverified.trim() && r.observations.every(o => o.kind === 'note') && (!r.checks || r.checks.every(c => c.status === 'verified'))), 'Unverified requirements or unresolved observations cannot be passed');
export const testRunActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), itemId: z.string().uuid() }),
  z.object({ action: z.literal('assess'), runId: z.string().uuid() }),
  z.object({ action: z.literal('start'), mission: missionBindingSchema.optional(), itemId: z.string().uuid(), caseId: z.string().uuid(), expectedVersion: z.union([z.number(), z.string().regex(/^[1-9]\d*$/).transform(Number)]).pipe(z.number().int().positive()), requestId: z.string().uuid(), environment: z.string().trim().min(1).max(1000), target: testTargetSchema.optional() }),
  z.object({ action: z.literal('finish'), runId: z.string().uuid(), result: z.union([
    runResultSchema,
    z.string().max(200000).transform((value, ctx) => {
      try { return JSON.parse(value) as unknown; }
      catch { ctx.addIssue({ code: 'custom', message: 'Result must be valid JSON' }); return z.NEVER; }
    }).pipe(runResultSchema),
  ]) }),
]);
export type RunResult = z.infer<typeof runResultSchema>;

// Derived from the immutable run snapshot, never from the agent's narrowed task.
export function runChecks(snapshot: TestCase) {
  const steps = snapshot.steps.trim().split(/(?:^|\s+)(?=\d+[.)]\s)/).filter(s => s.trim());
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
