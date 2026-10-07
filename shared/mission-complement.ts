import { z } from 'zod';

/** Server-issued linkage only. None of these identities is chosen by Klara.
 * A complement reruns the unchanged case; it never executes next-step prose.
 */
export const missionComplementSchema = z.object({
  version: z.literal(1),
  sourceTaskId: z.string().uuid(), sourceAttemptId: z.string().uuid(),
  runId: z.string().uuid(), assessmentId: z.string().uuid(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  reviewerVersion: z.string().min(1).max(80), planRevision: z.number().int().positive(),
  caseKey: z.string().regex(/^[a-f0-9-]{36}:[a-f0-9-]{36}$/i),
  gapIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(202),
}).strict();
export type MissionComplement = z.infer<typeof missionComplementSchema>;

/** Count committed logical rounds per case/plan, including failures, stopped
 * work and different gap names. Retries of one round do not reset its budget.
 */
export function nextComplementRound(input: {
  planRevision: number; caseKey: string; maxRounds: number;
  tasks: { planRevision: number | null; supplementRound: number | null;
    spec: { kind: string; caseKeys?: string[] } | null }[];
}) {
  const previous = input.tasks.filter(task => task.planRevision === input.planRevision
    && task.spec?.kind === 'browser_tests' && task.spec.caseKeys?.includes(input.caseKey));
  if (!Number.isInteger(input.maxRounds) || input.maxRounds < 0
    || previous.some(task => !Number.isInteger(task.supplementRound) || task.supplementRound! < 0)) return null;
  const round = Math.max(0, ...previous.map(task => task.supplementRound!)) + 1;
  return round <= input.maxRounds ? round : null;
}
