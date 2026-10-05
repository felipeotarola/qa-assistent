import { z } from 'zod';
import type { ExternalIssue } from './external';

export const requirementProposalSchema = z.object({
  action: z.literal('propose'),
  itemId: z.string().uuid(), caseId: z.string().uuid(),
  expectedVersion: z.union([z.number(), z.string().regex(/^[1-9]\d*$/).transform(Number)]).pipe(z.number().int().positive()),
  requestId: z.string().uuid(),
  question: z.string().trim().min(1).max(3000),
  clarification: z.string().trim().max(5000).default(''),
  expected: z.string().trim().max(5000).default(''),
  issueId: z.string().trim().max(100).optional(),
  sourceItemId: z.string().uuid().optional(),
});
export const requirementToolSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), itemId: z.string().uuid(), caseId: z.string().uuid() }),
  requirementProposalSchema,
]);
export const requirementPublishSchema = z.object({ action: z.literal('publish'), id: z.string().uuid(), expectedVersion: z.number().int().positive() });
export type RequirementProposal = z.infer<typeof requirementProposalSchema>;
export type TestRequirement = {
  id: string; itemId: string; caseId: string; question: string; clarification: string; expected: string;
  planVersion: number; sourceItemId: string | null; sourceVersion: number | null;
  issue: ExternalIssue | null; createdAt: string; publishedAt: string | null;
  appliedVersion: number | null; materialId: string | null;
};
export function requirementSection(id: string, caseId: string, question: string, clarification: string, expected: string) {
  return `## Kravförtydligande för test ${caseId}\n\nBesluts-ID: ${id}\n\n### Fråga\n${question}\n\n### Beslutat krav\n${clarification}\n\n### Förväntat resultat framöver\n${expected}\n\nDetta är det senaste förtydligandet för detta testfall och ersätter tidigare förtydliganden vid konflikt. Tidigare körningar bedöms separat.`;
}
export const runReviewSchema = z.object({
  runId: z.string().uuid(), requestId: z.string().uuid(),
  outcome: z.enum(['passed', 'failed', 'inconclusive']),
  reason: z.string().trim().min(10).max(5000),
});
export type RunReview = { id: string; outcome: 'passed' | 'failed' | 'inconclusive'; reason: string; userId: string; authorName?: string; createdAt: string };
