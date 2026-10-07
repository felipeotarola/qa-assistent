import { z } from 'zod';

/** Private server receipt. Never accepted from a model or returned in tool data. */
export const browserReturnReceiptSchema = z.object({
  version: z.literal(1),
  waitId: z.string().uuid(), sourceAttemptId: z.string().uuid(), taskId: z.string().uuid(),
  assignmentId: z.string().uuid(), physicalSessionId: z.string().uuid(), claimId: z.string().uuid(),
  sourceDispatchId: z.string().uuid(), runtime: z.string().min(1),
  planRevision: z.number().int().positive(), mandateRevision: z.number().int().positive(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/), policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  deadlineAt: z.string().datetime(), blockedRunId: z.string().uuid().nullable(),
  // Optional for older receipts. The server independently validates the
  // acknowledged takeover event; this is not a model-selected retry list.
  humanTakeover: z.object({ eventId: z.string().uuid(), runId: z.string().uuid() }).strict().optional(),
  // Absent in historical/public receipts. This only identifies immutable
  // creation metadata; it grants neither a new origin nor a longer lifetime.
  preview: z.object({ creationAttemptId: z.string().uuid(), creationRequestHash: z.string().regex(/^[a-f0-9]{64}$/),
    setupJobId: z.string().uuid(), sandboxId: z.string().uuid() }).strict().optional(),
}).strict();
export type BrowserReturnReceipt = z.infer<typeof browserReturnReceiptSchema>;

/** A human-return continuation may retry its explicitly interrupted last case
 * and the exact case active at an acknowledged human takeover. Completed
 * outcomes are never replaced merely because login changed.
 * This selects work, not evidence: every selected case needs a new full run. */
export function browserReturnCases(caseKeys: string[], runs: { id: string; itemId: string; caseId: string; finishedAt: unknown; result: { outcome: string } | null }[], blockedRunId: string | null, takeoverRunId: string | null = null) {
  if (!caseKeys.length || new Set(caseKeys).size !== caseKeys.length) throw new Error('Invalid return selection');
  const selected: string[] = [];
  for (const key of caseKeys) {
    const own = runs.filter(run => `${run.itemId}:${run.caseId}` === key);
    if (!own.length) { selected.push(key); continue; }
    // Preserve even an incomplete reported pass/fail for independent review;
    // AUTH return is not permission to retry a product outcome.
    if (own.some(run => run.result && ['passed', 'failed'].includes(run.result.outcome))) continue;
    if (own.some(run => !run.finishedAt || !run.result)) throw new Error('Original browser outcome is unknown');
    if (own.some(run => (run.id === blockedRunId || run.id === takeoverRunId) && ['blocked', 'interrupted'].includes(run.result!.outcome)
      // Only the server-bound active-at-takeover run may resume an inconclusive
      // outcome. An ordinary last run or another case gains no retry right.
      || run.id === takeoverRunId && run.result!.outcome === 'inconclusive')) selected.push(key);
  }
  return selected;
}

/** Private acknowledgement of a real agent -> human transition. It describes
 * the run active before that transition, never what the human did in the UI. */
export const browserTakeoverReceiptSchema = z.object({
  version: z.literal(1), id: z.string().uuid(),
  missionId: z.string().uuid(), userId: z.string().min(1), workspaceId: z.string().uuid(), threadId: z.string().min(1),
  sourceAttemptId: z.string().uuid(), sourceDispatchId: z.string().uuid(), taskId: z.string().uuid(),
  assignmentId: z.string().uuid(), physicalSessionId: z.string().uuid(), claimId: z.string().uuid(),
  runtime: z.string().min(1), fence: z.number().int().positive(),
  planRevision: z.number().int().positive(), mandateRevision: z.number().int().positive(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/), policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  deadlineAt: z.string().datetime(), requestedAt: z.string().datetime(), confirmedAt: z.string().datetime(),
  run: z.object({ id: z.string().uuid(), itemId: z.string().uuid(), caseId: z.string().uuid(),
    planVersion: z.number().int().positive(), startedAt: z.string().datetime() }).strict().nullable(),
}).strict();
export type BrowserTakeoverReceipt = z.infer<typeof browserTakeoverReceiptSchema>;
export type BrowserTakeoverScope = Omit<BrowserTakeoverReceipt, 'id' | 'run' | 'requestedAt' | 'confirmedAt'>;

/** Pure identity/time check after the original executor has settled. A later
 * interrupted run cannot erase this exact earlier human-affected case. */
export function browserTakeoverRunId(takeover: BrowserTakeoverReceipt, scope: BrowserTakeoverScope,
  runs: { id: string; itemId: string; caseId: string; planVersion: number; workspaceId: string; threadId: string;
    runtime: string | null; missionAttemptId: string | null; startedAt: Date; finishedAt: Date | null; result: { outcome: string } | null }[], before: Date, requireSettled = true) {
  if (Object.entries(scope).some(([key, value]) => takeover[key as keyof BrowserTakeoverScope] !== value)
    || Date.parse(takeover.requestedAt) > Date.parse(takeover.confirmedAt)
    || Date.parse(takeover.confirmedAt) > before.getTime()
    || Date.parse(takeover.confirmedAt) >= Date.parse(takeover.deadlineAt)) throw new Error('Invalid browser takeover scope');
  if (!takeover.run) return null;
  const matches = runs.filter(run => run.id === takeover.run!.id), run = matches[0];
  if (matches.length !== 1 || !run || run.itemId !== takeover.run.itemId || run.caseId !== takeover.run.caseId
    || run.planVersion !== takeover.run.planVersion || run.workspaceId !== scope.workspaceId || run.threadId !== scope.threadId
    || run.runtime !== scope.runtime || run.missionAttemptId !== scope.sourceAttemptId
    || run.startedAt.toISOString() !== takeover.run.startedAt || run.startedAt.getTime() > Date.parse(takeover.requestedAt)
    || run.finishedAt && run.finishedAt.getTime() < Date.parse(takeover.requestedAt)) throw new Error('Invalid browser takeover run');
  // A timely owner may return while Iris is settling. Nomination may be saved,
  // but reservation still requires the terminal original and its own outcome.
  if (!run.finishedAt && !run.result && !requireSettled) return run.id;
  if (!run.finishedAt || !run.result) throw new Error('Original browser outcome is unknown');
  // Keep the nominated identity even if settlement later reports pass/fail.
  // browserReturnCases excludes those outcomes without invalidating other
  // independently eligible work in the same timely return.
  return run.id;
}
