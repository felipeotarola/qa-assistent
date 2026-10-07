import { z } from 'zod';
import { REVIEW_MODEL, REVIEWER_VERSION, currentAssessmentSchema } from './result-assessment.ts';
import { REPORT_CHECK_LIMIT, REPORT_CHECK_TEXT_LIMIT, REPORT_FACT_TEXT_LIMIT, REPORT_FACT_NOTE_LIMIT, missionReportCheckSubjects, missionReportCheckRef } from './mission-report-context.ts';
import { criterionEvidenceScope } from './mission-regression.ts';
import type { EvidenceRead, EvidenceRef, MissionSnapshot, WorkResult } from './mission.ts';
import { MAX_CRITERION_DELIVERIES } from './mission.ts';
import { EVIDENCE_RULES_VERSION, evidenceApplicability } from './evidence-rules.ts';
import { targetVersionLabel } from './test-target.ts';
import { DELIVERY_POLICY_VERSION } from './mission-delivery.ts';
import { reportRemediation, reportSummary, reportObservationOrigin } from './mission-report-remediation.ts';
import { missionTaskStates } from './mission-control.ts';

// Reader 2 can inspect explicitly selected notes as claims without promoting
// their provenance. Older queued snapshots must not reuse the prior selection.
export const REPORT_MAX_OUTPUT_TOKENS = 16000;
export const MISSION_REPORT_VERSION = `${EVIDENCE_RULES_VERSION}:delivery-${DELIVERY_POLICY_VERSION}:reader-2:remediation-1:judgement-8:regression-1:task-history-2:reviewed-checks-2:model-${REVIEW_MODEL}:output-${REPORT_MAX_OUTPUT_TOKENS}`;
export const REPORT_POLICY_ERROR = 'Rapportens underlag använder en äldre bevispolicy. En ny rapport kräver ett aktuellt underlag.';

/** Generation/cache admission only. Completed historical documents stay readable. */
export function hasCurrentReportPolicy(version: string, snapshot: { schemaVersion?: number; delivery?: { schemaVersion?: number } } | null | undefined) {
  return version === MISSION_REPORT_VERSION && snapshot?.schemaVersion === 2 && snapshot.delivery?.schemaVersion === DELIVERY_POLICY_VERSION;
}

export function independentCriterionEvidence(snapshot: MissionSnapshot, criterionId: string, source: WorkResult, evidence: EvidenceRef, read?: EvidenceRead, requireRead = false) {
  const scope = criterionEvidenceScope(snapshot, criterionId, source);
  return scope.allowed && missionEvidenceApplicability(source, evidence, scope.target, read, requireRead).eligible;
}

export function independentMissionEvidence(source: WorkResult, evidence: EvidenceRef, target?: MissionSnapshot['config']['target']) {
  return missionEvidenceApplicability(source, evidence, target, undefined, false).eligible;
}
function missionEvidenceApplicability(source: WorkResult, evidence: EvidenceRef, target: MissionSnapshot['config']['target'] | undefined, read?: EvidenceRead, requireRead = true) {
  return evidenceApplicability({ schemaVersion: source.schemaVersion, sourceType: source.sourceType, sourceId: source.sourceId, target: source.target, expectedTarget: target, startedAt: source.startedAt, finishedAt: source.finishedAt }, {
    ...evidence, requiresDigest: evidence.kind === 'image', digest: read?.digest,
    readStatus: !read ? 'unread' : read.unavailable ? 'unavailable' : read.limited ? 'limited' : 'read',
  }, { requireRead });
}

const reportSubjectRelation = z.enum(['supports', 'contradicts', 'unresolved']);
const reportCheckSubjectSchema = z.object({ checkRef: z.string().min(1).max(4096), relation: reportSubjectRelation }).strict();
type ReportCheckSubject = { requirement: string; relation: z.infer<typeof reportSubjectRelation> };
const reportSubjectLabels = {
  supports: 'Stöds av det citerade underlaget.',
  contradicts: 'Motsägs av det citerade underlaget.',
  unresolved: 'Är inte fastställt av det citerade underlaget.',
} as const;

// A saved review is copied metadata, never part of the writer's output schema.
// Bounds are the existing run-check and current assessment bounds.
const savedReviewSchema = z.object({
  version: z.literal(1), reportedStatus: z.enum(['verified', 'mismatch', 'unverified', 'blocked']),
  reportedActual: z.string().min(1).max(5000), reviewerVersion: z.string().min(1).max(80),
  finding: currentAssessmentSchema.shape.findings.element.omit({ requirementId: true, evidenceIds: true }),
  binding: z.object({ reviewId: z.string().uuid(), runId: z.string().uuid(), checkId: z.string().min(1).max(80),
    sourceRevision: z.string().regex(/^[a-f0-9]{64}$/), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    finishedAt: z.string().datetime(), originalEvidenceIds: z.array(z.string().min(1).max(100)).max(40),
  }).strict().optional(),
}).strict();
export type SavedReportReview = z.infer<typeof savedReviewSchema>;

/** Exact current finding and all its consumed proof, not a new judgement. */
export function reviewedReportChecks(snapshot: MissionSnapshot, reads: ReadonlyMap<string, EvidenceRead>) {
  const readIds = new Set([...reads.values()].filter(r => !r.unavailable && !r.limited && (r.text || r.image)).map(r => r.id));
  const checks = missionReportCheckSubjects(snapshot, readIds);
  const rows = new Map<string, { savedReview: SavedReportReview; evidenceIds: string[]; criterionIds: string[]; source: WorkResult; relation: z.infer<typeof reportSubjectRelation> }>();
  if ([...checks.values()].filter(check => check.evidenceIds.length).length > REPORT_CHECK_LIMIT) return rows;
  const bindings = new Map<string, string>();
  for (const task of snapshot.tasks) for (const source of task.sources) for (const claim of source.claims ?? []) {
    const ref = missionReportCheckRef(source, claim.id);
    if (!checks.has(ref)) continue;
    const binding = JSON.stringify(source.assessment ?? null), prior = bindings.get(ref);
    if (prior !== undefined && prior !== binding) throw new Error('Conflicting saved review binding');
    bindings.set(ref, binding);
  }
  for (const task of snapshot.tasks) for (const source of task.sources) {
    const review = source.assessment;
    if (source.sourceType !== 'test' || source.schemaVersion !== 2 || source.status !== 'completed' || !source.finishedAt
      || !review || review.status !== 'completed' || !review.finishedAt || review.stale !== false || review.reviewerVersion !== REVIEWER_VERSION) continue;
    const parsed = currentAssessmentSchema.safeParse({ summary: review.summary, verdict: review.verdict, findings: review.findings });
    if (!parsed.success || !source.claims?.length || parsed.data.findings.length !== source.claims.length
      || new Set(source.claims.map(c => c.id)).size !== source.claims.length
      || source.claims.some(c => !parsed.data.findings.some(f => f.requirementId === c.id))) continue;
    for (const claim of source.claims) {
      const ref = missionReportCheckRef(source, claim.id), check = checks.get(ref);
      if (!check || !check.evidenceIds.length) continue;
      const finding = parsed.data.findings.find(f => f.requirementId === claim.id)!;
      if (!finding.evidenceIds.length || new Set(finding.evidenceIds).size !== finding.evidenceIds.length) continue;
      const evidence = finding.evidenceIds.map(id => source.evidence.filter(e => e.id === id || e.itemId === id));
      // Every cited original must resolve once in this source and satisfy each bound criterion.
      if (evidence.some(matches => matches.length !== 1)) continue;
      const refs = evidence.map(matches => matches[0]!);
      if (new Set(refs.map(e => e.id)).size !== refs.length || refs.some(e => !readIds.has(e.id)
        || check.criterionIds.some(id => !independentCriterionEvidence(snapshot, id, source, e, reads.get(e.id), true)))) continue;
      // A supported unfinished executor check cannot become a green copied row.
      if (finding.verdict === 'supported' && !['verified', 'mismatch'].includes(claim.reportedStatus)) continue;
      const saved = savedReviewSchema.safeParse({ version: 1, reportedStatus: claim.reportedStatus, reportedActual: claim.reportedActual,
        reviewerVersion: review.reviewerVersion,
        finding: { verdict: finding.verdict, explanation: finding.explanation, suggestedNextStep: finding.suggestedNextStep, gap: finding.gap },
        binding: { reviewId: review.id, runId: source.sourceId, checkId: claim.id, sourceRevision: source.sourceRevision,
          sourceHash: review.sourceHash, inputHash: review.inputHash, finishedAt: review.finishedAt, originalEvidenceIds: finding.evidenceIds },
      });
      if (!saved.success) continue;
      const value = { savedReview: saved.data, evidenceIds: refs.map(e => e.id), criterionIds: check.criterionIds, source,
        relation: finding.verdict === 'supported' ? 'supports' as const : finding.verdict === 'contradicted' ? 'contradicts' as const : 'unresolved' as const };
      const prior = rows.get(ref);
      if (prior && JSON.stringify(prior.savedReview) !== JSON.stringify(value.savedReview)) throw new Error('Conflicting saved review binding');
      rows.set(ref, value);
    }
  }
  return rows;
}

/** One plain-text projection for the report view, Material and exported text. */
export function reportObservationText(observation: { text: string; subject?: ReportCheckSubject; savedReview?: SavedReportReview }) {
  if (observation.savedReview && observation.subject) {
    const saved = observation.savedReview;
    const verdict = saved.finding.verdict === 'supported' ? 'Utförarens rapportering stöds; detta är inte automatiskt ett godkänt produktutfall.'
      : saved.finding.verdict === 'contradicted' ? 'Utförarens rapportering motsägs av underlaget.' : 'Utförarens rapportering behöver mer underlag.';
    return [`Originalkrav: ${observation.subject.requirement}`, `Utförarens registrerade status: ${saved.reportedStatus}`,
      `Utförarens observation: ${saved.reportedActual}`, `Sparad granskning (version ${saved.reviewerVersion}): ${verdict}`, saved.finding.explanation,
      ...(saved.finding.gap ? [`Sparad bevislucka: ${saved.finding.gap.wantedEvidence}`] : []),
      ...(saved.finding.suggestedNextStep ? [`Granskningens sparade förslag (inte nytt mandat): ${saved.finding.suggestedNextStep}`] : []),
    ].join('\n');
  }
  return observation.subject
    ? `Originalkrav: ${observation.subject.requirement}\nKlaras bedömning av utförarens rapportering: ${reportSubjectLabels[observation.subject.relation]}\nLäst observation: ${observation.text}`
    : observation.text;
}

export const reportDraftSchema = z.object({
  summary: z.string().trim().min(1).max(3000).describe('En sammanfattning i fullständiga meningar av faktiskt granskat resultat, viktigaste fyndet och kvarvarande begränsningar. Inte bara en titel eller rubrik. Återge inte påstådda fel som verifierade utan läst underlag.'),
  findings: z.array(z.object({ criterionId: z.string().max(80), verdict: z.enum(['supported', 'needs_evidence', 'contradicted']), conclusion: z.string().min(1).max(3000), evidenceIds: z.array(z.string().max(120)).max(MAX_CRITERION_DELIVERIES), nextStep: z.string().max(2000), observations: z.array(z.object({ subject: reportCheckSubjectSchema.optional(), text: z.string().min(1).max(2000), evidenceIds: z.array(z.string().max(120)).min(1).max(MAX_CRITERION_DELIVERIES) }).strict()).max(REPORT_CHECK_LIMIT + REPORT_FACT_NOTE_LIMIT).optional() })).min(1).max(50),
  limitations: z.array(z.string().max(2000)).max(50),
});
export type ReportDraft = z.infer<typeof reportDraftSchema>;
export type ReportDocument = { schemaVersion: 1; title: string; capturedAt: string; revision: number; goal: string; scope: string; criteria: MissionSnapshot['config']['criteria']; target: string; partial: boolean; summary: string; findings: (Omit<ReportDraft['findings'][number], 'observations'> & { completionStatement?: string; observations?: { text: string; evidenceIds: string[]; originLabel: string; subject?: ReportCheckSubject; savedReview?: SavedReportReview }[] })[]; limitations: string[]; tests: MissionSnapshot['tests']; metrics: MissionSnapshot['metrics']; tasks: { id: string; title: string; actor: string; parentId: string | null; dependsOn: string[]; status: string; reportedOutcome: string; startedAt: string | null; finishedAt: string | null }[]; evidence: { id: string; title: string; itemId: string | null; version: number | null; kind: string; url: string | null; observedAt: string | null; read: boolean }[] };

/** One applicability rule for model admission and the final report validator. */
export function readIndependentCriterionEvidence(snapshot: MissionSnapshot, criterionId: string, readIds: ReadonlySet<string>, reads: ReadonlyMap<string, EvidenceRead>) {
  return snapshot.schemaVersion === 2 ? snapshot.tasks.filter(task => task.criterionIds.includes(criterionId)).flatMap(task => task.sources.flatMap(source => source.evidence
    .filter(evidence => readIds.has(evidence.id) && independentCriterionEvidence(snapshot, criterionId, source, evidence, reads.get(evidence.id) ?? { id: evidence.id }, true))
    .map(evidence => ({ source, evidence })))) : [];
}

/** A typed conclusive relation cannot promote an agent claim or another source. */
export function hasIndependentReportCheck(snapshot: MissionSnapshot, criterionId: string, checkRef: string, evidenceIds: string[], reads: ReadonlyMap<string, EvidenceRead>) {
  return readIndependentCriterionEvidence(snapshot, criterionId, new Set(evidenceIds), reads)
    .some(({ source }) => source.claims?.some(check => missionReportCheckRef(source, check.id) === checkRef));
}

export function criterionSupportError(snapshot: MissionSnapshot, criterionId: string, independent: ReturnType<typeof readIndependentCriterionEvidence>) {
  const expected = snapshot.config.criteria.find(criterion => criterion.id === criterionId)?.delivery;
  if (!expected || !snapshot.delivery?.criteria.find(criterion => criterion.criterionId === criterionId)?.complete) return 'Supported finding requires complete criterion delivery';
  if (expected.kind === 'regression_comparison') {
    const current = snapshot.delivery?.cases.find(test => test.caseKey === expected.caseKey)?.runId;
    if (!expected.baseline || !current || current === expected.baseline.runId || [expected.baseline.runId, current].some(id => !independent.some(({ source }) => source.sourceType === 'test' && source.sourceId === id))) return 'Supported finding requires read independent evidence for both regression runs';
  }
  if (expected.kind === 'source' && expected.sourceTypes.some(type => !independent.some(({ source }) => source.sourceType === type))) return 'Supported finding requires read independent evidence for every requested source type';
  if (expected.kind === 'source' && expected.sourceRefs?.some(ref => !independent.some(({ source }) => source.sourceType === ref.type && source.sourceId === ref.id))) return 'Supported finding requires read independent evidence for every requested source';
  if (expected.kind === 'test_cases' && expected.caseKeys.some(key => {
    const delivered = snapshot.delivery?.cases.find(test => test.caseKey === key);
    return !delivered?.complete || !delivered.runId || !independent.some(({ source }) => source.sourceType === 'test' && source.sourceId === delivered.runId);
  })) return 'Supported finding requires read independent evidence for every selected run';
  return null;
}

export function validateReport(snapshot: MissionSnapshot, value: unknown, readIds: Set<string>, reads: ReadonlyMap<string, EvidenceRead> = new Map()) {
  const draft = reportDraftSchema.parse(value);
  const fullReads = new Set([...reads.values()].filter(read => readIds.has(read.id) && !read.unavailable && !read.limited && (read.text || read.image)).map(read => read.id));
  const checks = missionReportCheckSubjects(snapshot, fullReads);
  const assessable = new Map([...checks].filter(([, check]) => check.evidenceIds.length));
  const overflow = assessable.size > REPORT_CHECK_LIMIT;
  const reviewed = reviewedReportChecks(snapshot, reads);
  const seen = new Set<string>(reviewed.keys());
  let characters = 0, notes = 0;
  const expected = snapshot.config.criteria.map(c => c.id);
  if (draft.findings.length !== expected.length || new Set(draft.findings.map(f => f.criterionId)).size !== expected.length || draft.findings.some(f => !expected.includes(f.criterionId))) throw new Error('Report must cover every original criterion');
  for (const finding of draft.findings) {
    const hasChecks = [...checks.values()].some(check => check.criterionIds.includes(finding.criterionId));
    if (!hasChecks && (finding.observations?.length ?? 0) > 8) throw new Error('Report observation capacity exceeded');
    if (overflow && (finding.verdict !== 'needs_evidence' || finding.evidenceIds.length || finding.observations?.length)) throw new Error('Report check capacity requires an unassessed partial report');
    for (const observation of finding.observations ?? []) {
      characters += observation.text.length;
      if (!observation.subject) {
        if (hasChecks) { notes++; if (observation.text.length > 300) throw new Error('Report factual note capacity exceeded'); }
        continue;
      }
      const check = assessable.get(observation.subject.checkRef);
      if (!check || check.criterionIds[0] !== finding.criterionId || observation.evidenceIds.some(id => !check.evidenceIds.includes(id))) throw new Error('Report subject must cite its exact fully read source and owning criterion');
      if (reviewed.has(observation.subject.checkRef)) throw new Error('Saved review check is code-owned');
      if (seen.has(observation.subject.checkRef)) throw new Error('Duplicate report check assessment');
      seen.add(observation.subject.checkRef);
      if (observation.text.length > REPORT_CHECK_TEXT_LIMIT) throw new Error('Report check text capacity exceeded');
      if (observation.subject.relation !== 'unresolved' && check.criterionIds.some(id => !hasIndependentReportCheck(snapshot, id, observation.subject!.checkRef, observation.evidenceIds, reads))) throw new Error('Conclusive report subject requires independent evidence from its exact source');
      for (const id of check.criterionIds) {
        const related = draft.findings.find(finding => finding.criterionId === id);
        if (observation.evidenceIds.some(evidenceId => !related?.evidenceIds.includes(evidenceId))) throw new Error('Shared check citation missing from bound criterion');
      }
    }
    for (const row of reviewed.values()) if (row.criterionIds.includes(finding.criterionId)) {
      if (row.evidenceIds.some(id => !finding.evidenceIds.includes(id))) throw new Error('Saved review citation missing from criterion');
      if (finding.verdict === 'supported' && row.relation !== 'supports') throw new Error('Unresolved saved review prevents supported finding');
    }
    if (finding.observations?.some(observation => observation.evidenceIds.some(id => !finding.evidenceIds.includes(id)))) throw new Error('Observation citation belongs outside the finding');
    if (finding.evidenceIds.some(id => !readIds.has(id))) throw new Error('Unread report citation');
    const applicable = new Set(snapshot.tasks.filter(t => t.criterionIds.includes(finding.criterionId)).flatMap(t => t.sources.flatMap(s => s.evidence.map(e => e.id))));
    if (finding.evidenceIds.some(id => !applicable.has(id))) throw new Error('Evidence belongs to another criterion');
    if (finding.verdict !== 'needs_evidence' && !finding.evidenceIds.length) throw new Error('Conclusive finding requires read evidence');
    const independent = readIndependentCriterionEvidence(snapshot, finding.criterionId, new Set(finding.evidenceIds), reads);
    if (finding.verdict !== 'needs_evidence' && !independent.length) throw new Error('Conclusive finding requires independent evidence');
    if (finding.verdict === 'supported' || finding.verdict === 'contradicted' && snapshot.config.criteria.find(criterion => criterion.id === finding.criterionId)?.delivery?.kind === 'regression_comparison') {
      const issue = criterionSupportError(snapshot, finding.criterionId, independent);
      if (issue) throw new Error(issue);
    }
  }
  if (!overflow && (seen.size !== assessable.size || [...assessable.keys()].some(ref => !seen.has(ref)))) throw new Error('Report must assess every fully read original check exactly once');
  if (notes > REPORT_FACT_NOTE_LIMIT || characters > REPORT_FACT_TEXT_LIMIT) throw new Error('Report factual text capacity exceeded');
  return draft;
}
export function reportCheckCapacityMessage(total: number, assessable: number) {
  return `Rapporten innehåller ${total} ursprungliga kontrollpunkter, varav ${assessable} har fullt läst underlag. Gränsen är ${REPORT_CHECK_LIMIT} bedömbara kontrollpunkter per rapport. Ingen modellbedömning gjordes; originalurvalet har inte minskats.`;
}

/** A model cannot opt into this path: validation recomputes the capacity. */
export function unassessedReportDraft(snapshot: MissionSnapshot): ReportDraft {
  return { summary: 'Ingen modellbedömning gjordes.', limitations: [],
    findings: snapshot.config.criteria.map(criterion => ({ criterionId: criterion.id, verdict: 'needs_evidence', conclusion: 'Ingen modellbedömning gjordes.', nextStep: '', evidenceIds: [], observations: [] })),
  };
}
function reportTaskStatus(task: MissionSnapshot['tasks'][number]): string {
  // A completed source execution does not mean its later review succeeded.
  // Autonomous snapshots retain the task's own frozen orchestration state.
  if (task.state != null) return missionTaskStates.some(state => state === task.state) ? task.state : 'unknown';
  const sources = task.sources;
  if (!sources.length) return 'planned';
  if (sources.some(source => source.status === 'running')) return 'running';
  if (sources.some(source => source.status === 'failed')) return 'failed';
  if (sources.every(source => source.status === 'completed')) return 'completed';
  if (sources.every(source => ['completed', 'cancelled'].includes(source.status))) return 'cancelled';
  return 'unknown';
}

export function assembleReport(snapshot: MissionSnapshot, draft: ReportDraft, readIds: Set<string>, reads: ReadonlyMap<string, EvidenceRead> = new Map(), redactSubject: (text: string) => string = text => text): ReportDocument {
  const fullReads = new Set([...reads.values()].filter(read => readIds.has(read.id) && !read.unavailable && !read.limited && (read.text || read.image)).map(read => read.id));
  const checks = missionReportCheckSubjects(snapshot, fullReads);
  // Stored historical documents remain readable; new assembly cannot bypass coverage.
  if (checks.size || draft.findings.some(finding => finding.observations?.some(observation => observation.subject))) validateReport(snapshot, draft, readIds, reads);
  const assessableCount = [...checks.values()].filter(check => check.evidenceIds.length).length;
  const overflow = assessableCount > REPORT_CHECK_LIMIT;
  const capacity = overflow ? reportCheckCapacityMessage(checks.size, assessableCount) : null;
  const reviewed = reviewedReportChecks(snapshot, reads);
  const evidence = [...new Map(snapshot.tasks.flatMap(t => t.sources.flatMap(s => s.evidence)).map(e => [e.id, e])).values()];
  // Repository-only work has no browser target. Display saved source identity
  // without inventing one shared target for different repositories or commits.
  const executionSources = snapshot.tasks.flatMap(task => task.sources.filter(source => !['material', 'research'].includes(source.sourceType)));
  const repositoryTargets = executionSources.every(source => source.sourceType === 'repository' && source.target)
    ? [...new Set(executionSources.map(source => ['Repository', source.target!.url, targetVersionLabel(source.target!)].filter(Boolean).join(' · ')))] : [];
  return { schemaVersion: 1, title: snapshot.reportPurpose === 'interim' ? `Delrapport · ${snapshot.config.title}` : snapshot.config.title, capturedAt: snapshot.capturedAt, revision: snapshot.revision, goal: snapshot.config.goal, scope: snapshot.config.scope, criteria: snapshot.config.criteria.map(({ id, text }) => ({ id, text })),
    target: snapshot.config.target ? [snapshot.config.target.environment, snapshot.config.target.url, targetVersionLabel(snapshot.config.target)].filter(Boolean).join(' · ')
      : repositoryTargets.length === 1 ? repositoryTargets[0]! : repositoryTargets.length > 1 ? `Flera repositorymål eller versioner (${repositoryTargets.length})` : 'Testobjekt ej angivet',
    partial: snapshot.reportPurpose === 'interim' || !snapshot.delivery?.complete || draft.findings.some(finding => finding.verdict === 'needs_evidence'),
    ...draft, summary: reportSummary(snapshot, draft.findings, reads), findings: draft.findings.map(finding => {
      const remediation = reportRemediation(snapshot, finding.criterionId, finding.verdict, reads);
      const observations: NonNullable<ReportDocument['findings'][number]['observations']> = (finding.observations ?? []).map(({ subject, ...observation }) => ({ ...observation, text: redactSubject(observation.text), ...(subject ? { subject: { requirement: redactSubject(checks.get(subject.checkRef)!.requirement), relation: subject.relation } } : {}), originLabel: reportObservationOrigin(snapshot, finding.criterionId, observation.evidenceIds, reads) }));
      for (const [ref, check] of checks) {
        if (!check.criterionIds.includes(finding.criterionId)) continue;
        const first = check.criterionIds[0]!;
        const saved = reviewed.get(ref);
        if (saved) {
          if (first !== finding.criterionId) {
            const title = snapshot.config.criteria.find(c => c.id === first)!.text;
            observations.push({ originLabel: 'Delad sparad granskning', text: redactSubject(`Originalkrav: ${check.requirement}\nDen sparade granskningen och dess citerade underlag redovisas under kriteriet ”${title}”.`), evidenceIds: saved.evidenceIds });
          } else {
            const metadata = saved.savedReview;
            observations.push({ text: 'Sparad granskning av exakt denna kontrollpunkt.', evidenceIds: saved.evidenceIds, originLabel: 'Sparad granskning',
              subject: { requirement: redactSubject(check.requirement), relation: saved.relation },
              savedReview: { ...metadata, reportedActual: redactSubject(metadata.reportedActual), finding: { ...metadata.finding,
                explanation: redactSubject(metadata.finding.explanation), suggestedNextStep: redactSubject(metadata.finding.suggestedNextStep),
                gap: metadata.finding.gap ? { ...metadata.finding.gap, wantedEvidence: redactSubject(metadata.finding.gap.wantedEvidence) } : null } },
            });
          }
          continue;
        }
        const assessment = draft.findings.find(value => value.criterionId === first)?.observations?.find(value => value.subject?.checkRef === ref);
        if (assessment && first !== finding.criterionId) {
          const title = snapshot.config.criteria.find(value => value.id === first)!.text;
          observations.push({ originLabel: 'Delad kontrollpunktsbedömning', text: redactSubject(`Originalkrav: ${check.requirement}\nSamma bedömning och citerade underlag redovisas under kriteriet ”${title}”.`), evidenceIds: assessment.evidenceIds });
        } else if (!assessment) {
          const unread = check.allEvidenceIds.filter(id => !reads.has(id)).length;
          const unavailable = check.allEvidenceIds.filter(id => reads.get(id)?.unavailable).length;
          const limited = check.allEvidenceIds.filter(id => reads.get(id)?.limited && !reads.get(id)?.unavailable).length;
          const status = overflow ? 'Kontrollpunkten bedömdes inte eftersom rapportens kapacitetsgräns överskreds.'
            : `Kontrollpunkten har inte bedömts. Fullständigt lästa underlag: ${check.evidenceIds.length}; ej lästa: ${unread}; otillgängliga vid läsning: ${unavailable}; begränsade utdrag: ${limited}.`;
          observations.push({ originLabel: 'Systemstatus · ingen modellbedömning', text: `Originalkrav: ${redactSubject(check.requirement)}\n${status}`, evidenceIds: [] });
        }
      }
      return { ...finding, observations, conclusion: capacity ?? remediation.completionStatement, completionStatement: capacity ?? remediation.completionStatement, nextStep: capacity ? 'Originalkraven är bevarade. En större bedömningskapacitet behövs för att bedöma hela urvalet.' : remediation.nextStep };
    }), limitations: [...new Set([...snapshot.gaps, ...draft.limitations, ...(capacity ? [capacity] : [])])], tests: snapshot.tests, metrics: snapshot.metrics,
    tasks: snapshot.tasks.map(t => ({ id: t.id, title: t.title, actor: t.actor, parentId: t.parentId, dependsOn: t.dependsOn, status: reportTaskStatus(t), reportedOutcome: t.sources.some(s => s.reportedOutcome === 'blocked') ? 'blocked' : t.sources.length && t.sources.every(s => s.reportedOutcome === 'achieved') ? 'achieved' : t.sources.some(s => ['partial', 'achieved'].includes(s.reportedOutcome)) ? 'partial' : 'unknown', startedAt: t.sources.map(s => s.startedAt).filter((v): v is string => !!v).sort()[0] ?? null, finishedAt: t.sources.some(s => !s.finishedAt) ? null : t.sources.map(s => s.finishedAt).filter((v): v is string => !!v).sort().at(-1) ?? null })),
    evidence: evidence.map(e => ({ id: e.id, title: e.title, itemId: e.itemId, version: e.version, kind: e.kind, url: e.url, observedAt: e.observedAt, read: readIds.has(e.id) })) };
}

export function reportText(document: ReportDocument) {
  return [`${document.title}\nKlara · revision ${document.revision} · ${document.capturedAt}\n${document.partial ? 'Delrapport' : 'Slutrapport'}`, document.target, `Mål\n${document.goal}\n${document.scope}`, document.summary,
    ...document.metrics.map(m => `${m.label}\n${m.data.map(p => `${p.label}: ${p.value}`).join('\n')}`),
    ...document.findings.map(f => `${document.criteria?.find(c => c.id === f.criterionId)?.text ?? f.criterionId}\n${f.observations?.length ? `Klaras observationer\n${f.observations.map(o => `${o.originLabel}: ${reportObservationText(o)}\nUnderlag: ${o.evidenceIds.join(', ')}`).join('\n')}\n` : ''}${f.verdict}: ${f.completionStatement ?? f.conclusion}\nNästa steg: ${f.nextStep}\nUnderlag: ${f.evidenceIds.join(', ')}`),
    ...document.tests.map(t => `${t.title} · ${t.target}: ${t.status} · granskning ${t.review}${t.manualReview ? `\nManuell bedömning: ${t.manualReview}` : ''}`),
    ...document.tasks.map(t => `${t.title}: ${t.status} · ${t.startedAt ?? 'Okänd start'} → ${t.finishedAt ?? 'Saknar sluttid'}`),
    `Begränsningar\n${document.limitations.join('\n')}`, `Underlag\n${document.evidence.map(e => `${e.title} · ${e.observedAt ?? 'Okänd tid'} · ${e.read ? 'Läst' : 'Inte läst'}${e.url ? `\n${e.url}` : ''}`).join('\n')}`].join('\n\n');
}
