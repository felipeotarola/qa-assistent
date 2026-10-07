import { createHash, randomUUID } from 'node:crypto';
import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import { db } from '@nuxthub/db';
import { resultAssessments as jobs } from '../db/schema/result-assessments';
import { testRuns } from '../db/schema/test-runs';
import { testCaptures } from '../db/schema/test-captures';
import { workspaceItems } from '../db/schema/workspaces';
import { browserReturnContext } from './mission-browser-return';
import { requireWorkspace } from './workspaces';
import { runChecks } from '../../shared/test-run';
import { REVIEWER_VERSION, REVIEW_HASH_VERSION, REVIEW_MODEL, reviewRules, type ReviewInput, type ReviewEvidence, type AssessmentView } from '../../shared/result-assessment';
import { runtimeScope } from '../../shared/runtime-scope';
import { EVIDENCE_POLICY_VERSION, normalizeEvidenceProvenance } from '../../shared/evidence-provenance';

function canonicalReview(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalReview);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalReview(child)]));
  return value;
}
export function hashReview(input: unknown) {
  // Normalize JSON semantics first (Date.toJSON, omitted undefined properties),
  // then sort object keys recursively. Array order and all evidence identities
  // remain significant. The prefix distinguishes historical raw-JSON hashes.
  const json = JSON.stringify(input);
  if (json === undefined) throw new TypeError('Review fingerprint requires JSON input');
  return createHash('sha256').update(`review-input-v${REVIEW_HASH_VERSION}\n${JSON.stringify(canonicalReview(JSON.parse(json)))}`).digest('hex');
}
export function autoReviewEnabled(_workspaceId: string) {
  // Automatic review is part of finishing a test. Explicit emergency opt-out only.
  return process.env.RESULT_REVIEW_ENABLED !== 'false';
}
type Reader = Pick<typeof db, 'select'>;
export async function buildReviewInput(workspaceId: string, runId: string, reader: Reader = db): Promise<ReviewInput> {
  const [run] = await reader.select().from(testRuns).where(and(eq(testRuns.id, runId), eq(testRuns.workspaceId, workspaceId)));
  if (!run?.result || !run.finishedAt) throw createError({ statusCode: 409, statusMessage: 'En avslutad testkörning krävs.' });
  const captures = await reader.select().from(testCaptures).where(eq(testCaptures.runId, run.id)).orderBy(testCaptures.createdAt, testCaptures.id);
  const itemIds = [...new Set([...run.result.evidenceItemIds, ...captures.flatMap(c => c.itemId ? [c.itemId] : [])])].sort();
  const items = itemIds.length ? await reader.select().from(workspaceItems).where(and(eq(workspaceItems.workspaceId, workspaceId), inArray(workspaceItems.id, itemIds))) : [];
  return assembleReviewInput(run, captures, items, await reviewBrowserContext(reader, run));
}

async function reviewBrowserContext(reader: Reader, run: typeof testRuns.$inferSelect) {
  if (!run.missionAttemptId || !run.runtime) return undefined;
  return browserReturnContext(reader, { workspaceId: run.workspaceId, threadId: run.threadId, runtime: run.runtime, attemptId: run.missionAttemptId }, run);
}

function assembleReviewInput(run: typeof testRuns.$inferSelect, captures: (typeof testCaptures.$inferSelect)[], items: (typeof workspaceItems.$inferSelect)[], browserSessionContext?: ReviewInput['browserSessionContext']): ReviewInput {
  if (!run.result || !run.finishedAt) throw createError({ statusCode: 409, statusMessage: 'En avslutad testkörning krävs.' });
  const { id: runId, workspaceId } = run;
  const itemIds = [...new Set([...run.result.evidenceItemIds, ...captures.flatMap(c => c.itemId ? [c.itemId] : [])])].sort();
  const evidence: ReviewEvidence[] = itemIds.map(id => {
    const item = items.find(i => i.id === id && !i.deletedAt);
    const capture = captures.find(c => c.itemId === id);
    const file = item && (item.content.kind === 'image' || item.content.kind === 'file') ? item.content : null;
    const provenance = normalizeEvidenceProvenance(item?.provenance);
    return { id, itemId: item?.id ?? null, version: item?.version ?? null, title: item?.title ?? 'Underlag saknas',
      evidencePolicyVersion: EVIDENCE_POLICY_VERSION, origin: provenance?.origin ?? 'unknown', provenance, sha256: provenance?.sha256,
      kind: file?.kind ?? 'missing', mime: file?.mime ?? '', size: file?.size ?? 0, blobPath: file ? item!.blobPath : null,
      captureId: capture?.id ?? null, runId: capture?.runId ?? null, url: capture?.url ?? null, action: capture?.action ?? null,
      error: !item ? 'Underlaget är borttaget eller otillgängligt.' : capture?.error ?? null, observedAt: provenance?.observedAt ?? null };
  });
  for (const capture of captures.filter(c => !c.itemId)) evidence.push({ id: capture.id, itemId: null, version: null, title: capture.title, kind: 'observation', mime: '', size: 0, blobPath: null, captureId: capture.id, runId: run.id, url: capture.url, action: capture.action, error: capture.error, observedAt: capture.createdAt.toISOString(), readStatus: 'read', evidencePolicyVersion: EVIDENCE_POLICY_VERSION, origin: 'tool', provenance: { version: 1, origin: 'tool', producer: 'capture-metadata', sourceType: 'test', sourceId: run.id, observedAt: capture.createdAt.toISOString() } });
  const value = { ...(browserSessionContext ? { browserSessionContext } : {}), schemaVersion: 2 as const, runId, workspaceId, planVersion: run.planVersion, startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt.toISOString(), target: run.target, environment: run.environment, requirements: runChecks(run.snapshot), basis: run.snapshot.basis, reportedResult: run.result, evidence };
  return { ...value, ruleFindings: reviewRules(value) };
}

// Called within the same transaction that finalizes a test: no lost jobs after a crash.
export async function enqueueReview(tx: Pick<typeof db, 'select' | 'insert'>, userId: string, workspaceId: string, runId: string, threadId: string) {
  const input = await buildReviewInput(workspaceId, runId, tx);
  const sourceHash = hashReview(input);
  const [run] = await tx.select({ missionAttemptId: testRuns.missionAttemptId }).from(testRuns).where(eq(testRuns.id, runId));
  await tx.insert(jobs).values({ id: randomUUID(), runId, workspaceId, userId, threadId, runtime: runtimeScope(), reviewerVersion: REVIEWER_VERSION, model: REVIEW_MODEL, sourceHash, inputHash: sourceHash, input, notification: run?.missionAttemptId ? 'recorded' : 'pending' }).onConflictDoNothing();
}

export async function requestReview(userId: string, workspaceId: string, runId: string) {
  await requireWorkspace(userId, workspaceId);
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`assessment:${runId}`}, 0))`);
    const [run] = await tx.select().from(testRuns).where(and(eq(testRuns.id, runId), eq(testRuns.workspaceId, workspaceId)));
    if (!run) throw createError({ statusCode: 404, statusMessage: 'Körningen hittades inte.' });
    await enqueueReview(tx, userId, workspaceId, runId, run.threadId);
    // Explicit user retry only; automatic recovery remains limited to three attempts.
    const sourceHash = hashReview(await buildReviewInput(workspaceId, runId, tx));
    await tx.update(jobs).set({ status: 'queued', attempts: 0, error: null, finishedAt: null, leaseToken: null, leaseUntil: null, nextAttemptAt: new Date(), notification: run.missionAttemptId ? 'recorded' : 'pending' }).where(and(eq(jobs.runId, runId), eq(jobs.runtime, runtimeScope()), eq(jobs.sourceHash, sourceHash), eq(jobs.reviewerVersion, REVIEWER_VERSION), eq(jobs.status, 'failed')));
  });
}

export async function listAssessments(userId: string, workspaceId: string, runId?: string): Promise<AssessmentView[]> {
  await requireWorkspace(userId, workspaceId);
  const rows = await db.select().from(jobs).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.runtime, runtimeScope()), runId ? eq(jobs.runId, runId) : undefined)).orderBy(desc(jobs.createdAt)).limit(100);
  const hashes = new Map<string, string>();
  if (rows.length) {
    const runIds = [...new Set(rows.map(row => row.runId))];
    const runs = await db.select().from(testRuns).where(and(eq(testRuns.workspaceId, workspaceId), inArray(testRuns.id, runIds)));
    const captures = await db.select().from(testCaptures).where(inArray(testCaptures.runId, runIds)).orderBy(testCaptures.createdAt, testCaptures.id);
    const itemIds = [...new Set([...runs.flatMap(run => run.result?.evidenceItemIds ?? []), ...captures.flatMap(c => c.itemId ? [c.itemId] : [])])];
    const items = itemIds.length ? await db.select().from(workspaceItems).where(and(eq(workspaceItems.workspaceId, workspaceId), inArray(workspaceItems.id, itemIds))) : [];
    for (const run of runs) {
      try { hashes.set(run.id, hashReview(assembleReviewInput(run, captures.filter(c => c.runId === run.id), items, await reviewBrowserContext(db, run)))); }
      catch { hashes.set(run.id, 'unavailable'); }
    }
  }
  return rows.map(row => ({ id: row.id, runId: row.runId, status: row.status, assessment: row.assessment, error: row.error, inputHash: row.inputHash, reviewerVersion: row.reviewerVersion, model: row.model, createdAt: row.createdAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null, stale: row.reviewerVersion !== REVIEWER_VERSION || row.input.schemaVersion !== 2 || row.sourceHash !== hashes.get(row.runId), notificationPending: row.notification === 'pending', evidence: row.input.evidence.map(({ id, itemId, title }) => ({ id, itemId, title })) }));
}

/** Controller lookup uses the exact run and current source fingerprint. A UI
 * page limit must never hide a completed review or select another run's result.
 * Call after workspace authorization (and under the content lock when acting).
 */
export async function readCurrentRunAssessment(workspaceId: string, runId: string, reader: Reader = db) {
  let sourceHash: string;
  try { sourceHash = hashReview(await buildReviewInput(workspaceId, runId, reader)); }
  catch (error) {
    if ((error as { statusCode?: number }).statusCode === 409) return undefined;
    throw error;
  }
  const [row] = await reader.select().from(jobs).where(and(
    eq(jobs.workspaceId, workspaceId), eq(jobs.runId, runId), eq(jobs.runtime, runtimeScope()),
    eq(jobs.reviewerVersion, REVIEWER_VERSION), eq(jobs.sourceHash, sourceHash),
  ));
  return row;
}
