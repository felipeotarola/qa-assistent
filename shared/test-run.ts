import { z } from 'zod';
import type { TestCase } from './test-plan';
import type { RunReview } from './test-requirement';
export const testTargetSchema = z.object({
  environment: z.string().trim().max(200),
  url: z.string().trim().max(2000).refine(value => { if (!value) return true; try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }, 'Ange en http- eller https-adress utan inloggningsuppgifter'),
  revision: z.string().trim().max(200),
});
export type TestTarget = z.infer<typeof testTargetSchema>;

export const runResultSchema = z.object({
  outcome: z.enum(['passed', 'failed', 'inconclusive', 'blocked', 'interrupted']),
  actual: z.string().trim().min(1).max(20000),
  unverified: z.string().max(10000),
  observations: z.array(z.object({ title: z.string().trim().min(1).max(300), detail: z.string().trim().min(1).max(5000), kind: z.enum(['note', 'requirement_gap', 'defect']).optional() })).max(30),
  evidenceItemIds: z.array(z.string().uuid()).max(30),
}).refine(r => r.outcome !== 'passed' || (!r.unverified.trim() && r.observations.every(o => o.kind === 'note')), 'Unverified requirements or unresolved observations cannot be passed');
export const testRunActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), itemId: z.string().uuid() }),
  z.object({ action: z.literal('start'), itemId: z.string().uuid(), caseId: z.string().uuid(), expectedVersion: z.union([z.number(), z.string().regex(/^[1-9]\d*$/).transform(Number)]).pipe(z.number().int().positive()), requestId: z.string().uuid(), environment: z.string().trim().min(1).max(1000), target: testTargetSchema.optional() }),
  z.object({ action: z.literal('finish'), runId: z.string().uuid(), result: z.union([
    runResultSchema,
    z.string().max(200000).transform((value, ctx) => {
      try { return JSON.parse(value) as unknown; }
      catch { ctx.addIssue({ code: 'custom', message: 'Result must be valid JSON' }); return z.NEVER; }
    }).pipe(runResultSchema),
  ]) }),
]);
export type RunResult = z.infer<typeof runResultSchema>;
export type TestRun = {
  id: string; workspaceId: string; itemId: string; caseId: string; planVersion: number;
  snapshot: TestCase; environment: string; threadId: string;
  target?: TestTarget | null;
  startedAt: string; finishedAt: string | null; result: RunResult | null;
  reviews?: RunReview[];
  captures?: { id: string; itemId: string | null; url: string; title: string; action: string; error: string | null; createdAt: string }[];
};
export function effectiveRunOutcome(run: TestRun) {
  return run.reviews?.[0]?.outcome ?? run.result?.outcome ?? 'running';
}
export const runLabels = { passed: 'Godkänt', failed: 'Underkänt', inconclusive: 'Behöver bedömas', blocked: 'Blockerat', interrupted: 'Avbrutet', running: 'Påbörjat · saknar slutresultat', none: 'Ingen sparad körning' };
export function latestCaseRun(runs: TestRun[], itemId: string, caseId: string) {
  return runs.filter(r => r.itemId === itemId && r.caseId === caseId).sort((a,b) => b.startedAt.localeCompare(a.startedAt))[0];
}
