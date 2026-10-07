// Pure manifest compiler. It creates no account, workspace, evidence or run.
import assert from 'node:assert/strict';
import { EVIDENCE_PROTOCOL, EVIDENCE_PROTOCOLS, EVIDENCE_CATALOG, validateEvidenceManifest, evidenceSeed, validateEvidenceSeed, fingerprint, sha256 } from './evidence-acceptance.mjs';
import { GAP_FAULT_PROTOCOL, validateGapFaultManifest } from './evidence-gap-fault.mjs';

export function gapManifests({ sourceHash, runtime, variant, fixture, trials, driverSha256, helperSha256, receiptFile, acceptancePath, observationSeconds = 1500 }) {
  assert.ok(trials.every(t => t.selection == null && t.seedHash == null), 'A fresh GAP trial may not adopt existing results');
  const acceptance = validateEvidenceManifest({ protocol: EVIDENCE_PROTOCOL, catalogVersion: EVIDENCE_CATALOG, taskId: 'GAP-13', variant,
    sourceHash, runtime, model: 'glm-5.3-flash', reasoning: 'low', observationSeconds, preparation: 'preserved-actual',
    trials: trials.map(t => ({ workspaceId: t.workspaceId, accountFile: t.accountFile, selection: [], originArtifacts: [], url: `${fixture.origin}/` })),
    fault: { kind: 'external-physical-observation', driverSha256, fixtureSha256: fixture.sha256, receiptFile } }, { execute: true });
  const acceptanceBytes = Buffer.from(JSON.stringify(acceptance, null, 2));
  const driver = validateGapFaultManifest({ protocol: GAP_FAULT_PROTOCOL, sourceHash, runtime, variant, fixture, helperSha256,
    acceptanceManifest: acceptancePath, acceptanceManifestSha256: sha256(acceptanceBytes), perTrialSeconds: observationSeconds, maxSeconds: observationSeconds * trials.length,
    trials: trials.map(t => ({ workspaceId: t.workspaceId, userId: t.userId })) });
  return { acceptance, acceptanceBytes, driver };
}

/** The negative follow-up deliberately selects the original gapped run, not a
 * successful later rerun. It retains its original observation target and hashes.
 * Model/execution provenance must come from the preserved prior GAP artifact. */
export function gapReportOnlyManifest({ originBytes, originPath, sourceHash, runtime, accountFiles, observationSeconds = 1500 }) {
  const origin = JSON.parse(originBytes);
  assert.ok(EVIDENCE_PROTOCOLS.includes(origin.protocol), 'Unsupported originating evidence protocol'); assert.equal(origin.taskId, 'GAP-13'); assert.ok(['resolvable', 'persistent'].includes(origin.variant));
  assert.equal(origin.runtime, runtime); assert.ok(origin.attempts?.length);
  const trials = origin.attempts.map(attempt => {
    assert.ok(attempt.acceptedAt && attempt.threadId && attempt.snapshots?.length, 'A real accepted original trial is required');
    const state = attempt.snapshots.at(-1), mission = state.missions.find(m => m.thread_id === attempt.threadId);
    assert.ok(mission && mission.lifecycle === 'closed', 'The original GAP mission must finish before report-only');
    const tasks = state.tasks.filter(t => t.mission_id === mission.id && t.spec?.complement && t.supplement_round === 1);
    assert.ok(tasks.length, 'The original trial must contain an actual typed complement');
    const selected = [...new Set(tasks.map(t => t.spec.complement.runId))].map(id => {
      const run = state.runs.find(r => r.id === id), binding = tasks.find(t => t.spec.complement.runId === id).spec.complement;
      const review = state.reviews.find(r => r.id === binding.assessmentId);
      assert.ok(run && review?.status === 'completed' && review.assessment?.verdict === 'needs_evidence');
      assert.equal(review.run_id, run.id); assert.equal(run.mission_attempt_id, binding.sourceAttemptId);
      assert.equal(review.input_hash, binding.inputHash); assert.equal(review.source_hash, binding.sourceHash);
      assert.equal(review.reviewer_version, binding.reviewerVersion); assert.equal(binding.planRevision, mission.plan_revision);
      assert.ok(state.attempts.some(a => a.kind === 'review' && a.reviewCalls?.some(call => call.reviewId === review.id && call.providerCalls > 0)), 'Gap must come from an observed model review');
      return { type: 'test', id, label: `${run.snapshot.title} (ursprunglig körning ${run.started_at})` };
    });
    const seed = evidenceSeed(state, selected); validateEvidenceSeed('GAP-13', 'report-only', seed, runtime);
    const accountFile = accountFiles[attempt.workspaceId]; assert.equal(typeof accountFile, 'string', 'Explicit original workspace owner account required');
    return { workspaceId: attempt.workspaceId, accountFile, selection: selected, seedHash: fingerprint(seed), originArtifacts: [{ path: originPath, sha256: sha256(originBytes) }] };
  });
  return validateEvidenceManifest({ protocol: EVIDENCE_PROTOCOL, catalogVersion: EVIDENCE_CATALOG, taskId: 'GAP-13', variant: 'report-only', sourceHash, runtime,
    model: 'glm-5.3-flash', reasoning: 'low', observationSeconds, preparation: 'preserved-actual', trials }, { execute: true });
}
