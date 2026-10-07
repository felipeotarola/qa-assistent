import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { providerUsageSchema } from '../../shared/provider-usage.ts';

export const EVIDENCE_PROTOCOL = 'syna-evidence-acceptance-v3';
export const EVIDENCE_PROTOCOLS = Object.freeze(['syna-evidence-acceptance-v1', 'syna-evidence-acceptance-v2', 'syna-evidence-acceptance-v3', 'syna-evidence-acceptance-v4']);
export const EVIDENCE_CATALOG = '2026-10-05';
export const evidenceTasks = ['REP-05', 'REP-06', 'REP-07', 'SEC-08', 'GAP-13'];
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
export const fingerprint = value => sha256(JSON.stringify(sorted(JSON.parse(JSON.stringify(value)))));
const unique = values => new Set(values).size === values.length;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,150}$/.test(value);
const strict = (value, keys, label) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label}: object required`);
  assert.ok(Object.keys(value).every(key => keys.includes(key)), `${label}: unknown field`);
};

/** This manifest contains references to already saved evidence, never tool
 * provenance or model answers to insert. Synthetic golden preparation is a
 * separate declared input category, not prior physical/model execution.
 * Audit mode may help collect hashes;
 * execute mode refuses unlocked/absent input fingerprints. */
export function validateEvidenceManifest(value, { execute = false } = {}) {
  strict(value, ['protocol', 'catalogVersion', 'taskId', 'variant', 'sourceHash', 'runtime', 'model', 'reasoning', 'observationSeconds', 'trials', 'fault', 'preparation', 'reviewerVersion'], 'manifest');
  assert.ok(EVIDENCE_PROTOCOLS.includes(value.protocol), 'Unsupported evidence protocol'); assert.equal(value.catalogVersion, EVIDENCE_CATALOG);
  assert.ok(evidenceTasks.includes(value.taskId)); assert.match(value.runtime, /^autonomy-test:[a-z0-9-]+$/);
  assert.ok(digest(value.sourceHash), 'An exact authored build hash is required');
  assert.equal(value.model, 'glm-5.3-flash'); assert.equal(value.reasoning, 'low');
  assert.ok(Number.isInteger(value.observationSeconds) && value.observationSeconds >= 60 && value.observationSeconds <= 1500);
  const variants = value.taskId === 'SEC-08' ? ['owner-contract'] : value.taskId === 'GAP-13' ? ['resolvable', 'persistent', 'report-only'] : value.taskId === 'REP-05' ? ['normal', 'historical-review-gap'] : ['normal'];
  if (value.protocol === 'syna-evidence-acceptance-v4') assert.ok(value.taskId === 'REP-05' && value.variant === 'historical-review-gap' && value.preparation === 'preserved-actual', 'v4 is restricted to preserved actual REP-05 historical review gaps');
  assert.ok(variants.includes(value.variant), 'Variant is not implemented by this harness; never relabel a restart/alteration as normal');
  assert.ok(['preserved-actual', 'synthetic-golden'].includes(value.preparation ?? 'preserved-actual'));
  if (value.preparation === 'synthetic-golden') {
    assert.ok(value.taskId.startsWith('REP') && value.variant === 'normal', 'Synthetic preparation is only the declared REP catalog base');
    assert.match(value.reviewerVersion ?? '', /^\d+$/, 'Lock the preparation reviewer version');
  }
  assert.ok(Array.isArray(value.trials) && value.trials.length >= 1 && value.trials.length <= 5);
  assert.ok(unique(value.trials.map(t => t.workspaceId)), 'Each repetition needs a separate declared input workspace');
  for (const trial of value.trials) {
    strict(trial, ['workspaceId', 'accountFile', 'otherAccountFile', 'selection', 'seedHash', 'url', 'targetRevision', 'security', 'originArtifacts', ...(value.protocol === 'syna-evidence-acceptance-v4' ? ['originalExecutionHash'] : [])], 'trial');
    assert.ok(identifier(trial.workspaceId)); assert.equal(typeof trial.accountFile, 'string');
    assert.ok(Array.isArray(trial.selection) && unique(trial.selection.map(ref => `${ref.type}:${ref.id}`)));
    for (const ref of trial.selection) {
      strict(ref, ['type', 'id', 'label'], 'selection');
      assert.ok(['test', 'material'].includes(ref.type)); assert.ok(identifier(ref.id));
      assert.ok(typeof ref.label === 'string' && ref.label.trim() && ref.label.length <= 300 && !/[\r\n]/.test(ref.label));
      assert.ok(!ref.label.includes(ref.id), 'Natural selection label must not be an internal identifier');
    }
    if (value.taskId.startsWith('REP') || value.variant === 'report-only') {
      assert.ok(trial.selection.length, 'Saved report selection required');
      if (execute) assert.ok(digest(trial.seedHash), 'Execute requires a prelocked seed hash');
    }
    if (trial.seedHash != null) assert.ok(digest(trial.seedHash));
    if (value.protocol === 'syna-evidence-acceptance-v4') {
      if (execute) assert.ok(digest(trial.originalExecutionHash), 'Execute requires the prelocked original execution and historical review hash');
      if (trial.originalExecutionHash != null) assert.ok(digest(trial.originalExecutionHash));
    }
    assert.ok(Array.isArray(trial.originArtifacts), 'Declare originating acceptance artefacts explicitly');
    if (value.preparation === 'synthetic-golden' && execute) assert.equal(trial.originArtifacts.length, 1, 'Exactly one locked golden preparation receipt is required');
    for (const source of trial.originArtifacts) {
      strict(source, ['path', 'sha256'], 'origin artifact'); assert.equal(typeof source.path, 'string'); assert.ok(digest(source.sha256));
    }
    if (value.taskId === 'REP-06') assert.equal(trial.targetRevision, 'B');
    if (value.taskId === 'SEC-08') {
      assert.equal(typeof trial.otherAccountFile, 'string');
      strict(trial.security, ['reportId', 'marker'], 'security');
      assert.ok(identifier(trial.security.reportId)); assert.match(trial.security.marker, /^evidence-owner-marker-[a-f0-9]{16,64}$/);
    }
    if (value.taskId === 'GAP-13' && value.variant !== 'report-only') {
      assert.equal(trial.selection.length, 0, 'Natural GAP first run must not reuse old observation targets/runs');
      const url = new URL(trial.url); assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash);
    }
  }
  if (value.fault != null) {
    strict(value.fault, ['kind', 'driverSha256', 'fixtureSha256', 'receiptFile'], 'fault');
    assert.equal(value.fault.kind, 'external-physical-observation');
    assert.ok(digest(value.fault.driverSha256) && digest(value.fault.fixtureSha256)); assert.equal(typeof value.fault.receiptFile, 'string');
  }
  return value;
}

// A preserved manifest always keeps its original prompt bytes. The separate
// fault protocol shares only the matching prompt contract, never its oracle.
export function evidencePromptProtocol(protocol) {
  const base = {
    'syna-evidence-acceptance-v1': 'syna-evidence-acceptance-v1',
    'syna-evidence-acceptance-v2': 'syna-evidence-acceptance-v2',
    'syna-evidence-acceptance-v3': 'syna-evidence-acceptance-v2',
    'syna-evidence-acceptance-v4': 'syna-evidence-acceptance-v2',
    'syna-report-fault-acceptance-v1': 'syna-evidence-acceptance-v1',
    'syna-report-fault-acceptance-v2': 'syna-evidence-acceptance-v2',
  }[protocol];
  assert.ok(base, 'Unsupported evidence prompt protocol');
  return base;
}

export function evidencePrompt(manifest, trial) {
  const explicitReport = evidencePromptProtocol(manifest.protocol) === 'syna-evidence-acceptance-v2';
  const labels = trial.selection.map(ref => `”${ref.label}”`).join(', ');
  if (explicitReport) {
    if (manifest.taskId === 'REP-05') return `Sammanfatta de valda sparade resultaten ${labels} och spara en rapport. Kör inga nya tester.`;
    if (manifest.taskId === 'REP-06') return `Bedöm om de valda sparade resultaten ${labels} räcker för version B och spara en rapport. Kör inget nytt; skriv tydligt vad som saknas.`;
    if (manifest.taskId === 'REP-07') return `Gå igenom de valda sparade resultaten och anteckningen ${labels} och spara en rapport om vad vi faktiskt vet om inloggningsflödet. Testa inget nytt.`;
    if (manifest.taskId === 'GAP-13' && manifest.variant === 'report-only') return `Sammanfatta de valda sparade resultaten ${labels} och spara en rapport. Skriv tydligt vad som saknas och kör inga nya tester.`;
  }
  // v1 text is intentionally unchanged, including its ambiguous saved-report
  // intent in REP-06/07 and GAP report-only. Never re-certify old trial results.
  if (manifest.taskId === 'REP-05') return `Sammanfatta de valda sparade resultaten ${labels} i en rapport. Kör inga nya tester.`;
  if (manifest.taskId === 'REP-06') return `Bedöm om de valda sparade resultaten ${labels} räcker för version B. Kör inget nytt; skriv tydligt vad som saknas.`;
  if (manifest.taskId === 'REP-07') return `Gå igenom de valda sparade resultaten och anteckningen ${labels} och skriv vad vi faktiskt vet om inloggningsflödet. Testa inget nytt.`;
  if (manifest.taskId === 'GAP-13' && manifest.variant === 'report-only') return `Sammanfatta de valda sparade resultaten ${labels}. Skriv tydligt vad som saknas och kör inga nya tester.`;
  if (manifest.taskId === 'GAP-13') return `Testa att sökningen på ${trial.url} både kan visa träffar och ett begripligt tomt resultat, och sammanfatta vad som fungerar.`;
  return null; // SEC owner-contract deliberately has no model or natural-intake claim.
}

/** Only immutable original data and currently selected source versions. Reviews
 * can legitimately be renewed, so they are recorded but not part of seedHash. */
export function evidenceSeed(state, selection) {
  const runs = selection.filter(ref => ref.type === 'test').map(ref => {
    const run = state.runs.find(row => row.id === ref.id); assert.ok(run, 'Selected original run is missing');
    return { id: run.id, item_id: run.item_id, case_id: run.case_id, plan_version: run.plan_version, snapshot: run.snapshot,
      target: run.target, runtime: run.runtime, result: run.result, started_at: run.started_at, finished_at: run.finished_at, mission_attempt_id: run.mission_attempt_id };
  });
  const captures = state.captures.filter(c => runs.some(run => run.id === c.run_id)).map(c => ({ id: c.id, run_id: c.run_id, item_id: c.item_id, url: c.url, error: c.error,
    version: c.version, content: c.content, provenance: c.provenance, deleted_at: c.deleted_at })).sort((a, b) => a.id.localeCompare(b.id));
  const material = selection.filter(ref => ref.type === 'material').map(ref => {
    const item = state.items.find(row => row.id === ref.id); assert.ok(item, 'Selected original material is missing');
    return { id: item.id, title: item.title, version: item.version, content: item.content, provenance: item.provenance, deleted_at: item.deleted_at };
  });
  return { runs, captures, material };
}

export function validateEvidenceSeed(taskId, variant, seed, runtime, preparation = 'preserved-actual') {
  assert.ok(['preserved-actual', 'synthetic-golden'].includes(preparation));
  for (const run of seed.runs) {
    assert.equal(run.runtime, runtime); assert.ok(run.finished_at && run.result, 'Finished original required');
    if (preparation === 'preserved-actual') assert.ok(run.mission_attempt_id, 'A real saved autonomous browser run is required, not an injected result row');
    else assert.ok(!run.mission_attempt_id && run.result.actual?.includes('SYNTHETIC GOLDEN FIXTURE'), 'Golden fixtures may not masquerade as autonomous executions');
    assert.equal(run.snapshot.type, 'browser');
    assert.ok(seed.captures.some(c => c.run_id === run.id && c.item_id && !c.deleted_at && c.provenance?.origin === 'tool' && c.provenance.sourceId === run.id
      && c.provenance.sourceType === 'test' && ['browser-action', 'test-capture'].includes(c.provenance.producer) && digest(c.provenance.sha256)), 'Run needs its original independently captured evidence');
  }
  if (taskId === 'REP-05') {
    assert.equal(seed.runs.length, 3); const outcomes = seed.runs.map(run => run.result.outcome);
    assert.ok(outcomes.includes('passed') && outcomes.includes('failed'), 'REP-05 requires passed and failed originals');
    if (variant === 'normal') assert.ok(outcomes.some(outcome => ['inconclusive', 'blocked', 'interrupted'].includes(outcome)), 'REP-05 requires actual passed, failed and incomplete originals');
  }
  if (taskId === 'REP-06') {
    const revisions = seed.runs.map(run => run.target?.revision || null);
    assert.ok(revisions.includes('A') && revisions.includes('B') && revisions.includes(null), 'Version A/B/unknown must be real saved scopes; do not rewrite observation targets');
  }
  if (taskId === 'REP-07') {
    assert.ok(seed.runs.length >= 2, 'Use separate navigation/direct-open original results');
    assert.ok(seed.material.some(item => item.provenance?.origin === 'agent' && item.provenance.producer === 'agent-authored'), 'Requires an explicitly agent-authored claim, not independent tool evidence');
  }
  if (variant === 'report-only') assert.ok(seed.runs.length > 0);
}

const newRows = (before, after) => after.filter(row => !before.some(old => old.id === row.id));
const refs = snapshot => [...new Map(snapshot.tasks.flatMap(task => task.sources).map(source => [`${source.sourceType}:${source.sourceId}`, source])).values()];

/** The trusted protocol fixes this one summary obligation before execution.
 * It neither certifies semantic prose nor changes a saved model verdict. */
export function evidenceConclusionProfile(manifest) {
  return manifest.protocol === 'syna-evidence-acceptance-v3' && manifest.taskId === 'REP-07' && manifest.variant === 'normal'
    ? 'summary_with_disclosed_uncertainty' : 'incomplete_original_scope';
}

function auditSelectedSummaryReads(trial, before, report) {
  const sources = refs(report.input), receipts = report.read_receipts ?? [];
  const inspected = [];
  for (const selected of trial.selection) {
    const source = sources.find(source => source.sourceType === selected.type && source.sourceId === selected.id);
    assert.ok(source, 'Selected source missing from summary');
    const originals = selected.type === 'material' ? before.items.filter(item => item.id === selected.id)
      : before.captures.filter(capture => capture.run_id === selected.id && capture.item_id && !capture.error).map(capture => ({ ...capture, id: capture.item_id }));
    const fullyRead = originals.filter(item => {
      if (item.deleted_at || !item.content || !item.provenance) return false;
      const evidence = source.evidence?.filter(evidence => evidence.itemId === item.id) ?? [];
      if (evidence.length !== 1) return false;
      const ref = evidence[0], matching = receipts.filter(receipt => receipt.id === ref.id);
      const expectedHash = fingerprint({ content: item.content, provenance: item.provenance, evidencePolicyVersion: 2 });
      if (ref.id !== 'item:' + item.id || ref.version !== item.version || ref.hash !== expectedHash || ref.unavailable
        || ref.evidencePolicyVersion !== 2 || ref.origin !== item.provenance.origin || fingerprint(ref.provenance) !== fingerprint(item.provenance)) return false;
      if (selected.type === 'test' && (ref.origin !== 'tool' || ref.provenance.sourceType !== 'test' || ref.provenance.sourceId !== selected.id
        || !['test-capture', 'browser-action'].includes(ref.provenance.producer))) return false;
      const expectedDigest = ['file', 'image'].includes(item.content.kind) ? item.provenance.sha256 : expectedHash;
      if (matching.length !== 1 || !digest(expectedDigest)) return false;
      const read = matching[0];
      if (read.unavailable || read.limited || read.hash !== expectedHash || read.version !== item.version || read.digest !== expectedDigest) return false;
      if (!report.document.evidence?.some(value => value.id === ref.id && value.itemId === item.id && value.version === item.version && value.read === true)) return false;
      if (ref.origin === 'agent') {
        assert.equal(ref.provenance.producer, 'agent-authored', 'Agent claim origin changed');
        assert.ok(report.document.findings.some(finding => finding.observations?.some(observation => observation.evidenceIds.includes(ref.id)
          && observation.originLabel?.split(' · ').includes('Agentpåstående; inte oberoende verifiering'))), 'Read agent claim must remain visibly attributed as claim-only');
      }
      inspected.push({ type: selected.type, sourceId: selected.id, evidenceId: ref.id, version: ref.version, hash: ref.hash, digest: expectedDigest, origin: ref.origin });
      return true;
    });
    assert.ok(fullyRead.length, 'Every selected summary source requires a full exact original read with preserved provenance');
  }
  return inspected;
}

export function auditEvidenceCompletion(manifest, trial, before, after, threadId) {
  const missions = newRows(before.missions, after.missions).filter(m => m.thread_id === threadId);
  assert.equal(missions.length, 1, 'One natural request must have exactly one mission');
  const mission = missions[0]; assert.equal(mission.lifecycle, 'closed');
  const reports = after.reports.filter(r => r.mission_id === mission.id && r.status === 'completed');
  assert.equal(reports.length, 1, 'Exactly one committed report expected');
  const report = reports[0]; assert.ok(report.item_id && report.document && report.input, 'Saved report plus original snapshot required');
  assert.ok(after.items.some(item => item.id === report.item_id && !item.deleted_at));
  const tasks = after.tasks.filter(t => t.mission_id === mission.id), attempts = after.attempts.filter(a => a.mission_id === mission.id);
  assert.equal(after.claims.filter(c => c.mission_id === mission.id).length, 0, 'Resource claim remains after closure');
  const reportOnly = manifest.taskId.startsWith('REP') || manifest.variant === 'report-only';
  if (reportOnly) {
    assert.equal(mission.intent, 'report_only');
    assert.ok(tasks.every(task => ['review', 'report'].includes(task.spec?.kind)), 'Report-only request started execution work');
    assert.ok(attempts.every(a => ['review', 'report'].includes(a.kind)));
    for (const key of ['runs', 'jobs', 'repositories', 'setups']) assert.equal(newRows(before[key], after[key]).length, 0, `Report-only created ${key}`);
    assert.equal(fingerprint(evidenceSeed(after, trial.selection)), fingerprint(evidenceSeed(before, trial.selection)), 'Original saved input changed');
    const selected = trial.selection.map(ref => `${ref.type}:${ref.id}`).sort();
    const actual = refs(report.input).map(ref => `${ref.sourceType}:${ref.sourceId}`).sort();
    assert.deepEqual(actual, selected, 'Report did not preserve the exact preselected originals');
    const conclusionProfile = evidenceConclusionProfile(manifest);
    const summaryReads = conclusionProfile === 'summary_with_disclosed_uncertainty' ? auditSelectedSummaryReads(trial, before, report) : null;
    const historicalSourceReads = manifest.protocol === 'syna-evidence-acceptance-v4' ? auditSelectedSummaryReads(trial, before, report) : null;
    if (historicalSourceReads) {
      for (const original of before.preservedIris) assert.equal(fingerprint(after.preservedIris?.find(row => row.id === original.id) ?? null), fingerprint(original), 'Original physical execution receipt changed');
      for (const original of before.reviews.filter(row => row.status === 'completed')) assert.equal(fingerprint(after.reviews.find(row => row.id === original.id) ?? null), fingerprint(original), 'Original completed review changed');
      for (const original of before.attempts.filter(row => row.kind === 'review' && row.status === 'completed')) assert.equal(fingerprint(after.attempts.find(row => row.id === original.id) ?? null), fingerprint(original), 'Original physical review attempt changed');
    }
    if (!summaryReads) {
      assert.equal(report.document.partial, true, 'Incomplete/old/unsupported input must stay a partial report');
      assert.ok(report.document.findings.some(f => f.verdict === 'needs_evidence'), 'Missing evidence was silently endorsed');
    }
    if (manifest.taskId === 'REP-06') assert.equal(report.input.config.target, null, 'Mixed versions fabricated a common target');
    for (const original of before.runs.filter(r => trial.selection.some(s => s.type === 'test' && s.id === r.id) && r.result?.outcome === 'failed')) {
      const saved = refs(report.input).find(ref => ref.sourceType === 'test' && ref.sourceId === original.id);
      assert.equal(saved?.reportedOutcome, 'partial', 'Original negative result disappeared from report source');
    }
    return { missionId: mission.id, reportId: report.id, checks: ['exact saved selection', 'no execution', 'original history preserved', summaryReads ? 'full original source reads and claim provenance' : 'explicit evidence gap'], semanticProse: 'pending',
      ...(historicalSourceReads ? { historicalSourceReads, originalExecutionReceipts: 'preserved-not-recertified' } : {}),
      ...(summaryReads ? { conclusionProfile, summaryReads, semanticRequirement: 'Independent byte/prose review must distinguish failed navigation, direct page opening and unverified login. Completion alone proves none of them.' } : {}),
    };
  }
  if (manifest.variant === 'persistent') {
    assert.equal(report.document.partial, true); assert.ok(report.document.findings.some(f => f.verdict === 'needs_evidence'));
  }
  return { missionId: mission.id, reportId: report.id, ...auditGapLineage(mission, tasks, attempts, after.runs, after.reviews, manifest.variant), semanticProse: 'pending' };
}

export function auditGapLineage(mission, tasks, attempts, runs, reviews, variant) {
  const supplements = tasks.filter(task => task.spec?.complement);
  assert.ok(supplements.length, 'No typed bounded complement actually happened');
  assert.ok(unique(supplements.map(task => `${task.spec.complement.caseKey}:${task.supplement_round}`)), 'Duplicate complement round');
  const checked = [];
  for (const task of supplements) {
    const binding = task.spec.complement;
    assert.equal(task.spec.kind, 'browser_tests'); assert.ok([1, 2].includes(task.supplement_round));
    assert.deepEqual(task.spec.caseKeys, [binding.caseKey]); assert.equal(binding.planRevision, mission.plan_revision);
    const original = runs.find(run => run.id === binding.runId), review = reviews.find(row => row.id === binding.assessmentId);
    assert.ok(original && review && original.mission_attempt_id === binding.sourceAttemptId);
    assert.equal(review.run_id, original.id); assert.equal(review.status, 'completed');
    assert.equal(review.assessment?.verdict, 'needs_evidence');
    assert.equal(review.input_hash, binding.inputHash); assert.equal(review.source_hash, binding.sourceHash); assert.equal(review.reviewer_version, binding.reviewerVersion);
    const gaps = review.assessment.findings.filter(f => f.verdict === 'needs_evidence' && f.gap?.capability === 'browser');
    assert.ok(gaps.length && gaps.every(f => ['missing_observation', 'unverified_step'].includes(f.gap.kind)
      && review.input?.requirements.some(requirement => requirement.id === f.requirementId)), 'Gap does not address an original requirement');
    assert.deepEqual(binding.gapIds, gaps.map(f => fingerprint({ planRevision: mission.plan_revision, caseKey: binding.caseKey, checkId: f.requirementId, kind: f.gap.kind })).sort(), 'Gap identities changed');
    const reviewAttempt = attempts.find(a => a.kind === 'review' && a.reviewCalls?.some(call => call.reviewId === review.id && call.providerCalls > 0));
    assert.ok(reviewAttempt, 'Typed gap must come from an observed physical model review, not deterministic no-evidence factory');
    const nextAttempts = attempts.filter(a => a.task_id === task.id && a.kind === 'browser_tests');
    assert.ok(nextAttempts.length && nextAttempts.every(a => a.id !== binding.sourceAttemptId));
    const nextRuns = runs.filter(run => nextAttempts.some(a => a.id === run.mission_attempt_id));
    assert.ok(nextRuns.length && nextRuns.every(run => `${run.item_id}:${run.case_id}` === binding.caseKey && fingerprint(run.snapshot) === fingerprint(original.snapshot)
      && fingerprint(run.target) === fingerprint(original.target)), 'Complement changed case, requirement or observation scope');
    const completed = reviews.filter(row => nextRuns.some(run => run.id === row.run_id) && row.status === 'completed');
    assert.ok(completed.length, 'Complement never received a new saved review');
    checked.push({ originalRunId: original.id, assessmentId: review.id, taskId: task.id, round: task.supplement_round, nextRunIds: nextRuns.map(run => run.id), nextReviewIds: completed.map(r => r.id) });
  }
  if (variant === 'resolvable') assert.ok(checked.some(check => check.nextReviewIds.some(id => reviews.some(review => review.id === id && review.assessment?.verdict === 'supported'))), 'No supplemented result became evidence-supported');
  if (variant === 'persistent') assert.ok(checked.some(check => check.round === 2), 'Persistent gap did not reach its bounded second round');
  return { checks: ['physical model gap', 'immutable original case/target', 'separate execution/review', 'bounded deduplicated rounds'], lineage: checked };
}

export function evidenceMetrics(before, after, threadId) {
  const missionIds = new Set(newRows(before.missions, after.missions).filter(m => m.thread_id === threadId).map(m => m.id));
  const attempts = after.attempts.filter(a => missionIds.has(a.mission_id));
  // Physical meter is the authority. Queue usage is the same calls and is never
  // added again. Missing or partial measurements remain unknown, not zero.
  const measured = attempts.filter(a => a.usage?.provider), unknown = attempts.filter(a => !a.usage?.provider && !['discovery', 'preview_discovery'].includes(a.kind));
  const valid = measured.filter(a => providerUsageSchema.safeParse(a.usage.provider).success);
  const invalid = measured.length !== valid.length;
  const tokenKnown = valid.flatMap(a => [a.usage.provider.inputTokens, a.usage.provider.outputTokens]).filter(v => Number.isSafeInteger(v) && v >= 0);
  const sum = values => { const result = values.reduce((a, b) => a + b, 0); return Number.isSafeInteger(result) ? result : null; };
  const knownSubtotal = sum(tokenKnown);
  const conflicts = valid.filter(a => a.usage.tokens != null && a.usage.provider.totalTokens != null && a.usage.tokens !== a.usage.provider.totalTokens);
  const partial = invalid || unknown.length > 0 || conflicts.length > 0 || valid.some(a => a.usage.provider.unknownCalls > 0 || !Number.isSafeInteger(a.usage.provider.totalTokens));
  return { logicalAttempts: attempts.length, retries: attempts.filter(a => a.attempt_no > 1).length,
    tokens: { total: partial ? null : knownSubtotal, knownSubtotal, unknownAttempts: unknown.length + valid.filter(a => a.usage.provider.unknownCalls > 0 || a.usage.provider.totalTokens == null).length + (invalid ? 1 : 0), conflictingAttempts: conflicts.length },
    providerCalls: unknown.length || invalid ? null : sum(valid.map(a => a.usage.provider.providerCalls)),
    unknownUsageCalls: invalid ? null : sum(valid.map(a => a.usage.provider.unknownCalls)),
    unknownProviderWorkflows: unknown.length,
    toolCalls: attempts.reduce((total, a) => total + a.tool_calls, 0), reservedTokens: attempts.reduce((total, a) => total + a.reserved_tokens, 0),
    cost: null, costReason: 'No frozen authoritative price list; V intake is outside the mission ledger.', quality: 'Report prose and fixture-semantic coverage require separate review.' };
}

export function auditEvidenceHistory(snapshots) {
  const finished = new Map();
  for (const state of snapshots) for (const run of state.runs) {
    if (!run.finished_at) continue;
    const original = evidenceSeed({ runs: [run], captures: [], items: [] }, [{ type: 'test', id: run.id }]).runs[0];
    const hash = fingerprint(original); if (finished.has(run.id)) assert.equal(hash, finished.get(run.id), 'A finished original run changed during continuation');
    else finished.set(run.id, hash);
  }
}

export function observedReviewCalls(ids) {
  return (ids ?? []).flatMap(value => {
    const prefix = 'server:queue-model:usage:';
    if (!value.startsWith(prefix)) return [];
    try {
      const row = JSON.parse(value.slice(prefix.length));
      const match = /^review:([^:]+):\d+$/.exec(row.key);
      return match && providerUsageSchema.safeParse(row.provider).success ? [{ reviewId: match[1], providerCalls: row.provider.providerCalls }] : [];
    } catch { return []; }
  });
}
