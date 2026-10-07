import type { MissionSnapshot, WorkResult } from './mission.ts';
import { criterionEvidenceScope } from './mission-regression.ts';

export const REPORT_CHECK_LIMIT = 32;
export const REPORT_CHECK_TEXT_LIMIT = 240;
export const REPORT_FACT_TEXT_LIMIT = 4000;
export const REPORT_FACT_NOTE_LIMIT = 2;

function reportSource(source: WorkResult) {
  return {
    schemaVersion: source.schemaVersion, sourceType: source.sourceType, sourceId: source.sourceId, sourceRevision: source.sourceRevision, attemptId: source.attemptId,
    target: source.target, startedAt: source.startedAt, finishedAt: source.finishedAt,
    reportedClaims: source.claims ? { basis: 'executor_claims_not_observation_bytes', items: source.claims } : undefined,
    checkRefs: source.claims ? Object.fromEntries(source.claims.map(claim => [claim.id, missionReportCheckRef(source, claim.id)])) : undefined,
    evidence: source.evidence.map(({ excerpt: _excerpt, ...item }) => item),
  };
}

function assessmentMetadata(source: WorkResult) {
  const review = source.assessment;
  if (!review) return undefined;
  return {
    role: 'saved_assessment_metadata_only_not_evidence_or_reuse_authority' as const,
    reuseAuthority: 'savedChecks_only' as const,
    status: review.status ?? null, stale: review.stale, reviewerVersion: review.reviewerVersion ?? null,
    checks: (review.findings ?? []).map(finding => ({ checkId: finding.requirementId, verdict: finding.verdict })),
  };
}

function checkCriterion(snapshot: MissionSnapshot, criterionId: string, source: WorkResult) {
  const criterion = snapshot.config.criteria.find(item => item.id === criterionId);
  if (!criterion || !criterionEvidenceScope(snapshot, criterionId, source).allowed) return false;
  const expected = criterion.delivery;
  return expected?.kind !== 'source' || (expected.sourceRefs?.length
    ? expected.sourceRefs.some(ref => ref.type === source.sourceType && ref.id === source.sourceId)
    : expected.sourceTypes.includes(source.sourceType));
}

export function missionReportCheckRef(source: Pick<WorkResult, 'sourceType' | 'sourceId' | 'sourceRevision' | 'attemptId'>, checkId: string) {
  return JSON.stringify([source.sourceType, source.sourceId, source.sourceRevision ?? null, source.attemptId ?? null, checkId]);
}

/** Compact only the model projection. The immutable snapshot and validators
 * retain every task binding, source version and original evidence reference. */
export function missionReportWriterContext(snapshot: MissionSnapshot, readIds: ReadonlySet<string>) {
  const project = (source: WorkResult) => ({ ...reportSource(source), evidence: reportSource(source).evidence.filter(item => readIds.has(item.id)) });
  const sources: (ReturnType<typeof project> & { criterionIds: string[]; assessmentMetadata?: ReturnType<typeof assessmentMetadata> })[] = [];
  const identities = new Map<string, number>();
  for (const task of snapshot.tasks) for (const source of task.sources) {
    const value = project(source);
    if (!value.evidence.length) continue;
    // Include all evidence identities before pruning. Distinct versions or
    // conflicting unread references must not collapse into one source.
    const identity = JSON.stringify({ ...value, evidence: source.evidence.map(({ excerpt: _excerpt, ...item }) => item) });
    const prior = identities.get(identity);
    if (prior !== undefined) sources[prior]!.criterionIds = [...new Set([...sources[prior]!.criterionIds, ...task.criterionIds])];
    else {
      identities.set(identity, sources.length);
      const metadata = assessmentMetadata(source);
      sources.push({ ...value, criterionIds: [...new Set(task.criterionIds)], ...(metadata ? { assessmentMetadata: metadata } : {}) });
    }
  }
  return {
    schemaVersion: snapshot.schemaVersion, missionId: snapshot.missionId, workspaceId: snapshot.workspaceId,
    revision: snapshot.revision, inputFingerprint: snapshot.inputFingerprint,
    evidenceSelection: { basis: 'metadata_selection_only', readEvidenceIds: [...readIds] },
    title: snapshot.config.title, goal: snapshot.config.goal, scope: snapshot.config.scope, target: snapshot.config.target,
    criteria: snapshot.config.criteria,
    // Verdict addresses this unchanged criterion, not the truth of an arbitrary
    // quoted source claim. These are interpretation rules, never new evidence.
    judgementContext: {
      version: 1 as const,
      verdictSubject: 'original_criterion' as const,
      sourceClaimsRole: 'quoted_claims_not_replacement_requirements' as const,
      unperformedAction: 'unknown_product_outcome_not_contradiction' as const,
      correctlyReportedFailure: 'may_support_a_complete_report' as const,
    },
    regressionComparisons: snapshot.config.criteria.flatMap(criterion => {
      const delivery = criterion.delivery;
      return delivery?.kind === 'regression_comparison' ? [{ criterionId: criterion.id, caseKey: delivery.caseKey, historicalRunId: delivery.baseline?.runId ?? null, historicalTarget: delivery.baseline?.target ?? null, historicalPlanVersion: delivery.baseline?.planVersion ?? null, historicalFinishedAt: delivery.baseline?.finishedAt ?? null, currentRunId: snapshot.delivery?.cases.find(test => test.caseKey === delivery.caseKey)?.runId ?? null, rule: 'Compare only these separately observed targets and times. Earlier evidence never verifies the current target. A different outcome is not proof of the cause of the change.' }] : [];
    }),
    sources,
  };
}

/** Exact metadata bindings, never a semantic judgement or an evidence upgrade. */
export function missionReportCheckSubjects(snapshot: MissionSnapshot, readIds: ReadonlySet<string>) {
  const checks = new Map<string, { requirement: string; reportedActual: string; reportedStatus: string; criterionIds: string[]; evidenceIds: string[]; allEvidenceIds: string[]; sourceIdentity: string }>();
  for (const task of snapshot.tasks) for (const source of task.sources) {
    const criterionIds = snapshot.config.criteria.map(criterion => criterion.id).filter(id => task.criterionIds.includes(id) && checkCriterion(snapshot, id, source));
    if (!criterionIds.length) continue;
    const sourceIdentity = JSON.stringify(reportSource(source));
    for (const check of source.claims ?? []) {
      const ref = missionReportCheckRef(source, check.id);
      if (!ref) throw new Error('Missing report check identity');
      const value = { requirement: check.requirement, reportedActual: check.reportedActual, reportedStatus: check.reportedStatus, criterionIds,
        evidenceIds: source.evidence.filter(item => readIds.has(item.id)).map(item => item.id), allEvidenceIds: source.evidence.map(item => item.id), sourceIdentity };
      const prior = checks.get(ref);
      // Different status, target, provenance or claims under one allegedly frozen
      // identity cannot silently gain a union of evidence or criterion scope.
      if (prior && (prior.sourceIdentity !== sourceIdentity || prior.requirement !== value.requirement || prior.reportedActual !== value.reportedActual || prior.reportedStatus !== value.reportedStatus)) throw new Error('Conflicting report check identity');
      checks.set(ref, prior ? { ...prior, criterionIds: [...new Set([...prior.criterionIds, ...criterionIds])] } : value);
    }
  }
  for (const check of checks.values()) check.criterionIds = snapshot.config.criteria.map(criterion => criterion.id).filter(id => check.criterionIds.includes(id));
  return checks;
}
