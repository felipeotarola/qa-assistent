import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { irisModelUsage, IRIS_MODEL_LEDGER_PREFIX } from '../../shared/browser-job.ts';
import { providerUsageSchema } from '../../shared/provider-usage.ts';

export const PRESERVED_IRIS_PROTOCOL = 'syna-evidence-acceptance-v4';
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const objectHash = value => digest(JSON.stringify(canonical(JSON.parse(JSON.stringify(value)))));
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = value => { const time = Date.parse(value); assert.ok(Number.isFinite(time), 'Original timestamp required'); return time; };

/** Used only on SQL rows read in the observer transaction. Never returns private
 * call identifiers or accepts a model-authored receipt as ledger authority. */
export function projectPreservedIris(rows) {
  assert.ok(rows.length <= 100, 'Historical browser-attempt bound exceeded');
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length, 'Duplicate original attempt');
  return rows.map(({ tool_call_ids, ...row }) => {
    assert.ok(Array.isArray(tool_call_ids) && tool_call_ids.every(id => typeof id === 'string'));
    const markers = tool_call_ids.filter(id => id.startsWith(IRIS_MODEL_LEDGER_PREFIX));
    return { ...row, ledgerSha256: digest(JSON.stringify(markers)), modelUsage: irisModelUsage(markers) };
  });
}

function validateUsage(row) {
  const usage = row.modelUsage;
  assert.ok(hex(row.ledgerSha256) && usage && !usage.invalid && usage.providerCalls > 0 && usage.knownCalls > 0
    && usage.knownCalls + usage.unknownCalls === usage.providerCalls, 'Original physical Iris ledger is absent or invalid');
  assert.ok(row.usage && Object.hasOwn(row.usage, 'tokens'), 'Original settled usage receipt required');
  assert.equal(row.usage.tokens, usage.tokens, 'Settled usage disagrees with original Iris ledger');
  // An explicitly supplied malformed/different provider meter never falls back
  // to the Iris ledger. A missing aggregate field is the historical format.
  if (Object.hasOwn(row.usage, 'provider')) {
    const provider = providerUsageSchema.parse(row.usage.provider);
    assert.equal(provider.providerCalls, usage.providerCalls);
    assert.equal(provider.unknownCalls, usage.unknownCalls);
    assert.equal(provider.totalTokens, usage.tokens);
  }
}

/** Exact original identity, not legacy adoption. Null physical resource IDs are
 * accepted only through immutable server dispatch→job→session ownership. */
export function auditPreservedIris(state, seed, { workspaceId, runtime, userId, reviewerVersion }) {
  const rows = state.preservedIris;
  assert.ok(Array.isArray(rows), 'Historical SQL ledger projection required');
  const bindings = seed.runs.map(run => {
    assert.equal(run.runtime, runtime);
    const matches = rows.filter(row => row.id === run.mission_attempt_id);
    assert.equal(matches.length, 1, 'Exact original browser attempt required');
    const row = matches[0];
    assert.equal(row.kind, 'browser_tests'); assert.ok(['completed', 'failed', 'cancelled', 'exhausted'].includes(row.status));
    assert.equal(row.workspace_id, workspaceId); assert.equal(row.user_id, userId); assert.equal(row.runtime, runtime);
    assert.equal(row.lifecycle, 'closed');
    assert.equal(row.job_workspace_id, workspaceId); assert.equal(row.job_user_id, userId); assert.equal(row.job_runtime, runtime);
    assert.ok(row.dispatch_id && row.job_id === row.dispatch_id && row.job_thread_id === row.thread_id && row.session_id);
    assert.ok(row.executor_resource_id === null || row.executor_resource_id === row.job_id, 'Historical physical ID conflicts with original dispatch');
    assert.ok(['completed', 'failed', 'cancelled'].includes(row.job_status));
    assert.ok(date(run.started_at) >= date(row.created_at) && date(run.finished_at) >= date(run.started_at)
      && date(run.finished_at) <= date(row.finished_at), 'Original run outside settled browser attempt');
    validateUsage(row);
    return { runId: run.id, attemptId: row.id, missionId: row.mission_id, dispatchId: row.dispatch_id, browserJobId: row.job_id,
      sessionId: row.session_id, originalReceiptSha256: objectHash(row), ledgerSha256: row.ledgerSha256, modelUsage: row.modelUsage };
  });
  const gaps = state.reviews.filter(review => seed.runs.some(run => run.id === review.run_id) && review.status === 'completed'
    && review.reviewer_version !== reviewerVersion && review.assessment?.verdict === 'needs_evidence');
  const verifiedGaps = gaps.filter(review => {
    const original = seed.runs.find(run => run.id === review.run_id), binding = bindings.find(row => row.runId === review.run_id);
    if (!hex(review.input_hash) || !hex(review.source_hash) || !review.model || review.input?.workspaceId !== workspaceId
      || review.input?.runId !== original.id || review.input?.planVersion !== original.plan_version) return false;
    const reviewAttempts = state.attempts.filter(attempt => attempt.mission_id === binding.missionId && attempt.kind === 'review'
      && attempt.status === 'completed' && attempt.reviewCalls?.some(call => call.reviewId === review.id && call.providerCalls > 0));
    if (reviewAttempts.length !== 1) return false;
    const provider = providerUsageSchema.safeParse(reviewAttempts[0].usage?.provider);
    if (!provider.success || provider.data.providerCalls <= 0) return false;
    return review.input.evidence?.some(evidence => evidence.readStatus === 'read' && seed.captures.some(capture => capture.run_id === original.id
      && capture.item_id === evidence.itemId && capture.version === evidence.version && capture.provenance?.sha256 === evidence.sha256
      && capture.provenance?.origin === 'tool' && !capture.deleted_at));
  });
  assert.ok(verifiedGaps.length > 0, 'Historical incomplete review lacks its own original physical review-call and read evidence receipts');
  return { version: 1, bindings, reviewIds: verifiedGaps.map(review => review.id),
    historicalReviews: verifiedGaps.map(review => ({ id: review.id, runId: review.run_id, reviewerVersion: review.reviewer_version, model: review.model,
      originalReviewSha256: objectHash(review), inputHash: review.input_hash, sourceHash: review.source_hash, capturedInputSha256: objectHash(review.input), assessmentSha256: objectHash(review.assessment),
      physicalReviewAttempts: state.attempts.filter(attempt => attempt.mission_id === bindings.find(row => row.runId === review.run_id).missionId && attempt.kind === 'review' && attempt.status === 'completed'
        && attempt.reviewCalls?.some(call => call.reviewId === review.id && call.providerCalls > 0)).map(attempt => ({ id: attempt.id, originalAttemptSha256: objectHash(attempt), usageSha256: objectHash(attempt.usage), callsSha256: objectHash(attempt.reviewCalls) })) })),
    attempts: [...new Map(bindings.map(row => [row.attemptId, { attemptId: row.attemptId, ledgerSha256: row.ledgerSha256, modelUsage: row.modelUsage }])).values()],
    limitation: 'Original execution provenance only; no new assessment, no result adoption and no repeated per-run counting of shared attempt usage.' };
}

export function auditPreservedTraceBytes(bytes, capture, seed, proof) {
  assert.equal(digest(bytes), capture.provenance.sha256, 'Original trace bytes changed');
  const run = seed.runs.find(run => run.id === capture.run_id), binding = proof.bindings.find(row => row.runId === capture.run_id);
  assert.ok(run && binding && capture.provenance.origin === 'tool' && capture.provenance.producer === 'browser-action'
    && capture.provenance.sourceType === 'test' && capture.provenance.sourceId === run.id && !capture.error && !capture.deleted_at);
  assert.equal(capture.content.kind, 'file'); assert.equal(capture.content.mime, 'application/json');
  const trace = JSON.parse(bytes);
  assert.equal(trace.version, 1); assert.equal(trace.browserJobId, binding.browserJobId);
  assert.equal(trace.execution?.attemptId, binding.attemptId); assert.equal(trace.execution?.dispatchId, binding.dispatchId);
  assert.ok(date(trace.startedAt) >= date(run.started_at) && date(trace.finishedAt) >= date(trace.startedAt)
    && date(trace.finishedAt) <= date(run.finished_at), 'Original trace outside selected run');
  return { runId: run.id, itemId: capture.item_id, sha256: digest(bytes), bytes: bytes.length, attemptId: binding.attemptId };
}

export function requirePreservedTraceCoverage(seed, traces) {
  for (const run of seed.runs) assert.ok(traces.some(trace => trace.runId === run.id), 'Selected original lacks a byte-read action trace bound to its physical attempt');
}
