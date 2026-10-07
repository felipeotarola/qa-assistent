import type { EvidenceRef, MissionSnapshot, WorkResult } from './mission.ts';
import { independentCriterionEvidence } from './mission-report.ts';
import { REVIEWER_VERSION } from './result-assessment.ts';

export const REPORT_EVIDENCE_READ_LIMIT = 24;
export const REPORT_EVIDENCE_IMAGE_LIMIT = 6;

function identity(evidence: EvidenceRef) {
  // Titles/excerpts are presentation, never acquisition identity.
  const p = evidence.provenance;
  return JSON.stringify([evidence.itemId, evidence.version, evidence.hash, evidence.kind,
    evidence.origin, evidence.evidencePolicyVersion, evidence.observedAt, evidence.unavailable,
    p && [p.version, p.origin, p.producer, p.sourceType, p.sourceId, p.observedAt, p.sha256, p.url]]);
}
function checkpoints(source: WorkResult) {
  const review = source.assessment;
  return source.claims?.map(claim => {
    const references = review && !review.stale && review.reviewerVersion === REVIEWER_VERSION
      ? [...new Set(review.findings?.filter(f => f.requirementId === claim.id).flatMap(f => f.evidenceIds) ?? [])] : [];
    const evidenceIds: string[] = [], unresolvedReviewEvidenceRefs: string[] = [];
    for (const ref of references) {
      // Reviews cite saved item IDs; reports cite their item:<id> projection.
      // Resolve only through this exact source, never by stripping a prefix or
      // searching another run. Ambiguous aliases confer no selection priority.
      const ids = [...new Set(source.evidence.filter(e => e.id === ref || e.itemId === ref).map(e => e.id))];
      if (ids.length === 1) evidenceIds.push(ids[0]!);
      else unresolvedReviewEvidenceRefs.push(ref);
    }
    return { requirementId: claim.id, weight: claim.reportedStatus === 'mismatch' ? 4 : claim.id === 'expected' ? 2 : claim.id === 'preconditions' ? 0.5 : 1,
      evidenceIds: [...new Set(evidenceIds)], unresolvedReviewEvidenceRefs };
  }) ?? [];
}
function orderedEvidence(source: WorkResult, candidates: EvidenceRef[]) {
  const groups = checkpoints(source);
  const remaining = [...candidates], ordered: EvidenceRef[] = [];
  const uncovered = new Set(groups.map((_, index) => index));
  while (remaining.length) {
    const coverage = (evidence: EvidenceRef) => [...uncovered].reduce((total, index) => total + (groups[index]!.evidenceIds.includes(evidence.id) ? groups[index]!.weight : 0), 0);
    // First cover different original checkpoints; review citations are only
    // selection hints. Text traces precede equivalent images so action evidence
    // does not lose the whole budget to screenshots of the same state.
    remaining.sort((a, b) => coverage(b) - coverage(a)
      || Number(groups.some(group => group.evidenceIds.includes(b.id))) - Number(groups.some(group => group.evidenceIds.includes(a.id)))
      || Number(a.kind === 'image') - Number(b.kind === 'image'));
    const next = remaining.shift()!;
    ordered.push(next);
    for (const index of uncovered) if (groups[index]!.evidenceIds.includes(next.id)) uncovered.delete(index);
  }
  return ordered;
}

/** Deterministic metadata selection, NOT a read receipt or semantic endorsement.
 * Actual bytes, freshness and each conclusion are still checked by the reader,
 * writer and unchanged report validator. No original criterion is removed. */
export function selectMissionReportEvidence(snapshot: MissionSnapshot, budget = REPORT_EVIDENCE_READ_LIMIT) {
  const maxReads = Number.isFinite(budget) ? Math.max(0, Math.min(REPORT_EVIDENCE_READ_LIMIT, Math.floor(budget))) : 0;
  const identities = new Map<string, string>(), conflicting = new Set<string>();
  for (const evidence of snapshot.tasks.flatMap(task => task.sources.flatMap(source => source.evidence))) {
    const value = identity(evidence), previous = identities.get(evidence.id);
    if (previous !== undefined && previous !== value) conflicting.add(evidence.id);
    identities.set(evidence.id, value);
  }
  const criteria = snapshot.config.criteria.map(criterion => {
    const expected = criterion.delivery;
    const priority = (source: WorkResult) => {
      if (expected?.kind === 'test_cases') return expected.caseKeys.some(key => snapshot.delivery?.cases.some(test => test.caseKey === key && test.runId === source.sourceId)) && source.sourceType === 'test' ? 0 : 1;
      if (expected?.kind === 'regression_comparison') return source.sourceType === 'test' && (source.sourceId === expected.baseline?.runId || source.sourceId === snapshot.delivery?.cases.find(test => test.caseKey === expected.caseKey)?.runId) ? 0 : 1;
      if (expected?.kind === 'source') return (expected.sourceRefs?.length
        ? expected.sourceRefs.some(ref => ref.type === source.sourceType && ref.id === source.sourceId)
        : expected.sourceTypes.includes(source.sourceType)) ? 0 : 1;
      return 1;
    };
    const seen = new Set<string>();
    const sources = snapshot.tasks.filter(task => task.criterionIds.includes(criterion.id)).flatMap(task => task.sources).filter(source => {
      const key = JSON.stringify([source.sourceType, source.sourceId, source.sourceRevision, source.attemptId, source.evidence.map(identity)]);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).map(source => ({ source, priority: priority(source), queue: orderedEvidence(source, source.evidence.filter(evidence =>
      snapshot.schemaVersion === 2 && !conflicting.has(evidence.id) && independentCriterionEvidence(snapshot, criterion.id, source, evidence))),
    })).sort((a, b) => a.priority - b.priority);
    return { criterionId: criterion.id, sources };
  });
  // Explicitly selected notes are useful context even when they cannot prove
  // their claims. Keep them separate from independent proof candidates, use
  // the same bounded reader, and never take context from an unrelated source.
  const context = new Map<string, EvidenceRef>();
  if (snapshot.schemaVersion === 2) for (const criterion of snapshot.config.criteria) {
    const expected = criterion.delivery;
    if (expected?.kind !== 'source') continue;
    for (const task of snapshot.tasks.filter(task => task.criterionIds.includes(criterion.id))) for (const source of task.sources) {
      if (source.schemaVersion !== 2 || source.sourceType !== 'material'
        || !expected.sourceRefs?.some(ref => ref.type === 'material' && ref.id === source.sourceId)) continue;
      for (const evidence of source.evidence) if (evidence.itemId === source.sourceId && evidence.kind === 'text'
        && ['agent', 'user', 'unknown'].includes(evidence.origin) && !evidence.unavailable && !conflicting.has(evidence.id)) context.set(evidence.id, evidence);
    }
  }
  const selected = new Set<string>(); let images = 0;
  // Reserve a small share for the selected claims, leaving most reads for
  // independent action traces. A zero budget still performs no reads.
  const contextIds = [...context.keys()].slice(0, Math.min(4, maxReads));
  const proofBudget = maxReads - contextIds.length;
  // Expected delivery sources first. Round-robin criteria and sources. Give
  // every source a first read, then a first relevant image before any source's
  // second image, regardless of how many text traces preceded its screenshots.
  for (const tier of [0, 1]) {
    const groups = criteria.map(criterion => criterion.sources.filter(source => source.priority === tier));
    const select = (evidence: EvidenceRef | undefined) => {
      if (!evidence || selected.has(evidence.id) || selected.size >= proofBudget || evidence.kind === 'image' && images >= REPORT_EVIDENCE_IMAGE_LIMIT) return;
      selected.add(evidence.id); if (evidence.kind === 'image') images++;
    };
    const eachSource = (visit: (bucket: typeof groups[number][number]) => void) => {
      for (let index = 0; index < Math.max(0, ...groups.map(group => group.length)); index++) {
        for (const group of groups) { const bucket = group[index]; if (bucket) visit(bucket); }
      }
    };
    eachSource(bucket => select(bucket.queue[0]));
    eachSource(bucket => {
      if (!bucket.queue.some(e => e.kind === 'image' && selected.has(e.id))) select(orderedEvidence(bucket.source, bucket.queue.filter(e => e.kind === 'image'))[0]);
    });
    const rounds = Math.max(0, ...groups.flatMap(group => group.map(bucket => bucket.queue.length)));
    for (let round = 0; round < rounds && selected.size < proofBudget; round++) {
      eachSource(bucket => select(bucket.queue[round]));
    }
  }
  const eligible = new Set(criteria.flatMap(criterion => criterion.sources.flatMap(source => source.queue.map(e => e.id))));
  const proofIds = [...selected];
  for (const id of contextIds) selected.add(id);
  return {
    version: 2 as const, basis: 'metadata_selection_only' as const, maxReads, maxImages: REPORT_EVIDENCE_IMAGE_LIMIT,
    evidenceIds: [...selected], proofEvidenceIds: proofIds, contextOnlyEvidenceIds: contextIds,
    contextCandidateCount: context.size, omittedContextCount: context.size - contextIds.length,
    candidateCount: eligible.size, omittedCandidateCount: eligible.size - proofIds.length,
    excludedEvidenceCount: identities.size - eligible.size, conflictingEvidenceCount: conflicting.size,
    criteria: criteria.map(criterion => ({ criterionId: criterion.criterionId, sources: criterion.sources.map(({ source, queue }) => ({
      sourceType: source.sourceType, sourceId: source.sourceId, sourceRevision: source.sourceRevision,
      candidateCount: queue.length, selectedEvidenceIds: queue.filter(e => selected.has(e.id)).map(e => e.id),
      checkpoints: checkpoints(source).map(check => ({ requirementId: check.requirementId,
        reviewEvidenceIds: check.evidenceIds, selectedEvidenceIds: check.evidenceIds.filter(id => selected.has(id) && queue.some(e => e.id === id)),
        omittedReviewEvidenceIds: check.evidenceIds.filter(id => !selected.has(id) || !queue.some(e => e.id === id)),
        unresolvedReviewEvidenceRefs: check.unresolvedReviewEvidenceRefs,
      })),
    })) })),
  };
}
