import { checkPartSchema, checkPartsSchema, partsProjection, partsEvidenceIssue, type ReadObservation } from './review-observations.ts';
import { z } from 'zod';
import type { RunResult, TestTarget } from './test-run';
import type { TestCase } from './test-plan';
import type { EvidenceProvenance } from './evidence-provenance.ts';
import { EVIDENCE_RULES_VERSION, evidenceApplicability, evidenceContextIssues, type EvidenceContext } from './evidence-rules.ts';

// Reviewer output can evolve without relabelling saved acquisition provenance.
// Changing shared evidence rules still requires an explicit reviewer revision.
// v7 explicitly asks whether evidence supports the executor's reported
// observation, not whether the product requirement passed. v6's canonical
// fingerprint stays unchanged; older completed reviews remain readable history.
// v9 names the actual missing context instead of assuming absent run identity.
// v12 judges the unchanged requirement/status/actual claim as a whole;
// truthful fragments do not substantiate a broader verified check.
// v10 preserves every original subcondition and distinguishes DOM href evidence
// from a performed click; old captures never gain link observations retroactively.
// v11 treats code-owned human-return context as history, never authentication evidence.
export const REVIEWER_VERSION = '19';
export const REVIEW_HASH_VERSION = 2;
export const REVIEW_EVIDENCE_RULES_VERSION = EVIDENCE_RULES_VERSION;
export const REVIEW_POLICY_ERROR = 'Granskningen använder en äldre granskarversion eller bevispolicy. En ny granskning har begärts från aktuellt underlag.';
// Fixed Klara model for both result review and mission report generation.
export const REVIEW_MODEL = 'glm-5.3';
export type ReviewEvidence = {
  id: string; itemId: string | null; version: number | null; title: string;
  kind: string; mime: string; size: number; blobPath: string | null;
  captureId: string | null; runId: string | null; url: string | null;
  action: string | null; error: string | null; observedAt: string | null;
  sha256?: string; readStatus?: 'read' | 'unavailable' | 'limited';
  evidencePolicyVersion?: number; origin?: EvidenceProvenance['origin']; provenance?: EvidenceProvenance | null;
};
export type RuleFinding = { code: string; requirementId: string | null; message: string };
export const browserSessionContextSchema = z.object({
  version: z.literal(1), kind: z.literal('human_returned_session'), priorAuthentication: z.literal('unknown'),
}).strict();
export type BrowserSessionContext = z.infer<typeof browserSessionContextSchema>;
export type ReviewInput = {
  schemaVersion: 1 | 2; runId: string; workspaceId: string; planVersion: number;
  startedAt: string; finishedAt: string; target: TestTarget | null; environment: string;
  requirements: { id: string; requirement: string }[];
  basis?: TestCase['basis'];
  browserSessionContext?: BrowserSessionContext;
  reportedResult: RunResult; evidence: ReviewEvidence[];
  ruleFindings: RuleFinding[];
  readObservations?: ReadObservation[];
};
export const reviewGapSchema = z.object({
  kind: z.enum(['missing_observation', 'unverified_step', 'unclear_requirement', 'environment_prerequisite', 'evidence_read_limit']),
  wantedEvidence: z.string().trim().min(1).max(1000),
  capability: z.enum(['browser', 'review', 'none']),
}).strict().superRefine((gap, ctx) => {
  const allowed = gap.kind === 'unclear_requirement' || gap.kind === 'environment_prerequisite' ? ['none']
    : gap.kind === 'evidence_read_limit' ? ['review', 'none']
      : gap.kind === 'unverified_step' ? ['browser', 'none'] : ['browser', 'review', 'none'];
  if (!allowed.includes(gap.capability)) ctx.addIssue({ code: 'custom', path: ['capability'], message: 'Capability cannot resolve this kind of evidence gap' });
});
export type ReviewGap = z.infer<typeof reviewGapSchema>;
const findingSchema = z.object({
  requirementId: z.string().min(1).max(80),
  verdict: z.enum(['supported', 'needs_evidence', 'contradicted']),
  explanation: z.string().trim().min(1).max(2000),
  evidenceIds: z.array(z.string().min(1).max(100)).max(40),
  suggestedNextStep: z.string().max(1000),
  // Absent on historical rows. Never infer executable work from old prose.
  gap: reviewGapSchema.nullable().optional(),
}).strict();
const assessmentShape = {
  verdict: z.enum(['supported', 'needs_evidence', 'contradicted']),
  summary: z.string().trim().min(1).max(1500),
  findings: z.array(findingSchema).min(1).max(202),
};
type GapAssessment = { verdict: string; findings: { requirementId: string; verdict: string; gap?: ReviewGap | null }[] };
function checkGaps(value: GapAssessment, ctx: z.RefinementCtx, requireGaps: boolean) {
  const expected = value.findings.some(f => f.verdict === 'contradicted') ? 'contradicted' : value.findings.some(f => f.verdict === 'needs_evidence') ? 'needs_evidence' : 'supported';
  if (value.verdict !== expected) ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'Assessment summary contradicts its findings' });
  if (new Set(value.findings.map(f => f.requirementId)).size !== value.findings.length) ctx.addIssue({ code: 'custom', path: ['findings'], message: 'Duplicate requirement finding' });
  value.findings.forEach((finding, index) => {
    const mayHaveGap = value.verdict === 'needs_evidence' && finding.verdict === 'needs_evidence';
    if (finding.gap && !mayHaveGap) ctx.addIssue({ code: 'custom', path: ['findings', index, 'gap'], message: 'Only an unresolved needs-evidence assessment may request additional evidence' });
    if (requireGaps && mayHaveGap && !finding.gap) ctx.addIssue({ code: 'custom', path: ['findings', index, 'gap'], message: 'Describe the unresolved evidence gap' });
  });
}
export const assessmentSchema = z.object(assessmentShape).strict().superRefine((value, ctx) => checkGaps(value, ctx, false));
// New model output is explicit; the historical read schema above does not
// default missing gaps or upgrade old findings into continuation requests.
export const currentAssessmentSchema = z.object({ ...assessmentShape,
  findings: z.array(findingSchema.extend({ gap: reviewGapSchema.nullable() })).min(1).max(202),
}).strict().superRefine((value, ctx) => checkGaps(value, ctx, true));
export type Assessment = z.infer<typeof assessmentSchema>;

const reportedCheckFindingSchema = checkPartsSchema.extend({
  requirementId: findingSchema.shape.requirementId,
  suggestedNextStep: findingSchema.shape.suggestedNextStep,
  gap: reviewGapSchema.nullable(),
});
function mapReportedChecks(value: { summary: string; findings: z.infer<typeof reportedCheckFindingSchema>[] }) {
  const findings = value.findings.map(row => {
    const projected = partsProjection(row);
    return { requirementId: row.requirementId, suggestedNextStep: row.suggestedNextStep, gap: row.gap,
      explanation: projected.text, evidenceIds: projected.evidenceIds,
      verdict: projected.relation === 'supports' ? 'supported' as const : projected.relation === 'contradicts' ? 'contradicted' as const : 'needs_evidence' as const };
  });
  const verdict = findings.some(f => f.verdict === 'contradicted') ? 'contradicted' as const
    : findings.some(f => f.verdict === 'needs_evidence') ? 'needs_evidence' as const : 'supported' as const;
  return { verdict, summary: value.summary, findings };
}
// Only the current model wire changes. Historical stored assessments stay readable.
export const reportedCheckAssessmentSchema = z.object({
  summary: assessmentShape.summary,
  findings: z.array(reportedCheckFindingSchema).min(1).max(202),
}).strict().superRefine((value, ctx) => {
  checkGaps(mapReportedChecks(value), ctx, true);
  value.findings.forEach((row, index) => {
    if (row.parts.reduce((sum, part) => sum + part.evidenceIds.length, 0) > 40) ctx.addIssue({ code: 'custom', path: ['findings', index], message: 'Check citation capacity exceeded' });
  });
});
export function assessmentFromReportedChecks(value: unknown, requirements: readonly { id: string }[], input?: ReviewInput): Assessment {
  const parsed = reportedCheckAssessmentSchema.parse(value);
  if (input) {
    const allowed = new Set(input.evidence.filter(e => e.readStatus === 'read').map(e => e.id));
    const independent = new Set(input.evidence.filter(e => independentReviewEvidence(input, e)).map(e => e.id));
    for (const row of parsed.findings) {
      const issue = partsEvidenceIssue(row, allowed, independent, input.readObservations ?? []);
      if (issue) throw new Error(issue);
    }
  }
  const result = currentAssessmentSchema.parse(mapReportedChecks(parsed));
  const ids = result.findings.map(finding => finding.requirementId);
  if (ids.length !== requirements.length || requirements.some(requirement => !ids.includes(requirement.id))) throw new Error('Assessment must cover exactly the original requirements');
  return result;
}
// Current generation assigns one required object property to each original
// check. Model output cannot choose, repeat or silently omit check identities.
// Keep the array wire and stored schemas above as the existing validator base.
const keyedCheckFindingSchema = reportedCheckFindingSchema.omit({ requirementId: true });
export function reportedCheckAssessmentSchemaFor(requirements: readonly { id: string }[], input?: ReviewInput) {
  const ids = z.array(findingSchema.shape.requirementId).min(1).max(202).parse(requirements.map(requirement => requirement.id));
  if (new Set(ids).size !== ids.length || ids.some(id => id.trim() !== id || !id.trim() || id === '__proto__')) {
    throw new Error('Assessment must cover exactly the original requirements');
  }
  const independent = new Set(input?.evidence.filter(e => independentReviewEvidence(input, e)).map(e => e.id));
  const actions = (input?.readObservations ?? []).filter(row => row.runId === input?.runId && independent.has(row.evidenceId)
    && ['observed', 'action_failed'].includes(row.outcome) && ['click', 'fill', 'press', 'select', 'scroll', 'back', 'forward'].includes(row.action));
  const bases: [z.infer<typeof checkPartSchema>['basis'], ...z.infer<typeof checkPartSchema>['basis'][]] = ['state', 'other'];
  if (actions.length) bases.push('action_attempt');
  if (actions.some(row => row.outcome === 'observed')) bases.push('performed_action');
  if (actions.some(row => row.outcome === 'observed' && row.fromUrl !== null && row.toUrl !== null && row.fromUrl !== row.toUrl)) bases.push('changed_destination');
  // This limits selectable forms, not claim truth or citation ownership. The
  // unchanged final validator still checks every part's own cited observations.
  // Missing forms remain expressible as unresolved; absence proves no negation.
  const part = z.union([
    checkPartSchema.extend({ relation: z.literal('supports'), basis: z.enum(bases).describe(checkPartSchema.shape.basis.description!) }),
    checkPartSchema.extend({ relation: z.enum(['contradicts', 'unresolved']) }),
  ]);
  const finding = keyedCheckFindingSchema.extend({ parts: z.array(part).min(1).max(8) });
  return z.object({
    summary: assessmentShape.summary,
    findings: z.object(Object.fromEntries(ids.map(id => [id, finding]))).strict(),
  }).strict();
}
export function assessmentFromKeyedChecks(value: unknown, requirements: readonly { id: string }[], input?: ReviewInput): Assessment {
  const parsed = reportedCheckAssessmentSchemaFor(requirements, input).parse(value);
  return assessmentFromReportedChecks({ summary: parsed.summary,
    findings: requirements.map(requirement => ({ ...parsed.findings[requirement.id], requirementId: requirement.id })),
  }, requirements, input);
}
export function reviewGaps(value: { reviewerVersion: string; assessment: unknown }): ({ requirementId: string } & ReviewGap)[] {
  if (value.reviewerVersion !== REVIEWER_VERSION) return [];
  const parsed = currentAssessmentSchema.safeParse(value.assessment);
  if (!parsed.success || parsed.data.verdict !== 'needs_evidence') return [];
  // These are evidence requests, not authorized tasks. The server must bind
  // exact run/assessment/input/check/plan identities and enforce its mandate.
  return parsed.data.findings.flatMap(finding => finding.gap ? [{ requirementId: finding.requirementId, ...finding.gap }] : []);
}
export const assessmentLabels = { supported: 'Underbyggt', needs_evidence: 'Behöver kompletteras', contradicted: 'Motsägs av underlaget' };
export type AssessmentView = {
  id: string; runId: string; status: 'queued' | 'running' | 'completed' | 'failed';
  assessment: Assessment | null; error: string | null; inputHash: string;
  reviewerVersion: string; model: string; createdAt: string; finishedAt: string | null;
  stale: boolean;
  notificationPending: boolean;
  evidence: { id: string; itemId: string | null; title: string }[];
};

export function reviewRules(input: Omit<ReviewInput, 'ruleFindings'>): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const add = (code: string, message: string, requirementId: string | null = null) => findings.push({ code, message, requirementId });
  const contextIssues = evidenceContextIssues(reviewEvidenceContext(input));
  const contextCodes = new Set(contextIssues.map(issue => issue.code));
  for (const issue of contextIssues) add(issue.code, issue.message);
  for (const requirement of input.requirements) {
    const checks = input.reportedResult.checks?.filter(c => c.id === requirement.id) ?? [];
    if (checks.length !== 1) add('coverage_missing', 'Kontrollpunkten saknar en entydig observation.', requirement.id);
    else if (!['verified', 'mismatch'].includes(checks[0]!.status) || input.reportedResult.outcome === 'passed' && checks[0]!.status !== 'verified') add('coverage_incomplete', 'Slutsatsen omfattar en overifierad kontrollpunkt.', requirement.id);
  }
  if (!input.evidence.length) add('evidence_missing', 'Inget separat underlag finns. Agentens egen slutsats är inte ett oberoende bevis.');
  for (const evidence of input.evidence) {
    for (const issue of evidenceApplicability(reviewEvidenceContext(input), reviewEvidenceCandidate(evidence), { requireRead: evidence.readStatus !== undefined }).issues) if (!contextCodes.has(issue.code)) add(issue.code, `${evidence.id}: ${issue.message}`);
  }
  return findings;
}

function reviewEvidenceContext(input: Omit<ReviewInput, 'ruleFindings'>): EvidenceContext {
  return { schemaVersion: input.schemaVersion, sourceType: 'test', sourceId: input.runId, target: input.target, environment: input.environment, startedAt: input.startedAt, finishedAt: input.finishedAt };
}
function reviewEvidenceCandidate(evidence: ReviewEvidence) {
  return { ...evidence, registeredSourceId: evidence.runId, requiresDigest: !!evidence.blobPath || evidence.kind === 'image' || evidence.kind === 'file', digest: evidence.sha256 };
}
export function independentReviewEvidence(input: ReviewInput, evidence: ReviewEvidence) {
  return evidenceApplicability(reviewEvidenceContext(input), reviewEvidenceCandidate(evidence)).eligible;
}

export function validateAssessment(input: ReviewInput, value: unknown): Assessment {
  const result = assessmentSchema.parse(value);
  const ids = result.findings.map(f => f.requirementId);
  if (new Set(ids).size !== ids.length || ids.length !== input.requirements.length || input.requirements.some(r => !ids.includes(r.id))) throw new Error('Assessment must cover exactly the original requirements');
  for (const finding of result.findings) {
    if (finding.evidenceIds.some(id => !input.evidence.some(e => e.id === id && e.readStatus === 'read'))) throw new Error('Assessment references unread or unknown evidence');
    if (finding.verdict !== 'needs_evidence' && !finding.evidenceIds.length) throw new Error('Conclusive finding needs evidence');
    if (finding.verdict !== 'needs_evidence' && !finding.evidenceIds.some(id => input.evidence.some(e => e.id === id && independentReviewEvidence(input, e)))) throw new Error('Conclusive finding needs independent evidence from this run');
    if (finding.verdict === 'supported' && reviewRules(input).some(rule => rule.requirementId === finding.requirementId)) throw new Error('Unresolved requirement prevents supported finding');
    if (finding.gap?.capability === 'browser') {
      if (input.reportedResult.observations.some(observation => observation.kind === 'requirement_gap')) throw new Error('An unclear requirement cannot authorize a browser supplement');
      if (evidenceContextIssues(reviewEvidenceContext(input)).length) throw new Error('Unresolved evidence context cannot authorize a browser supplement');
    }
  }
  const expected = result.findings.some(f => f.verdict === 'contradicted') ? 'contradicted' : result.findings.some(f => f.verdict === 'needs_evidence') ? 'needs_evidence' : 'supported';
  if (result.verdict !== expected) throw new Error('Assessment summary contradicts its findings');
  // Every conclusive finding already needs an applicable, independent citation.
  // Unused failed captures and optional unread files remain warnings; they must
  // not invalidate a later successful observation of the required checkpoints.
  return result;
}

// No model is needed to determine that nothing can be independently inspected.
export function assessmentWithoutEvidence(input: ReviewInput): Assessment | null {
  if (input.evidence.some(e => independentReviewEvidence(input, e))) return null;
  const contextIssues = evidenceContextIssues(reviewEvidenceContext(input));
  const contextNeeds: Record<string, string> = {
    evidence_policy_outdated: 'En ny granskning med aktuell bevispolicy för den sparade körningen.',
    revision_unknown: 'Verifierad testad revision eller ett giltigt observationsscope.',
    environment_unknown: 'Verifierad testmiljö för den sparade observationen.',
    target_mismatch: 'Underlag som gäller det begärda testobjektet och dess kända miljö och version.',
    source_window_unknown: 'Ett giltigt, verifierat start- och sluttidsintervall för den sparade körningen.',
    observation_window_mismatch: 'En observation insamlad efter uppdragets observationsscope.',
    target_identity_invalid: 'En giltig målidentitet utan oförenliga eller ogiltiga måluppgifter.',
    expected_target_unknown: 'En fullständig, giltig målidentitet för det ursprungliga uppdraget.',
  };
  const gap = (requirementId: string): ReviewGap => {
    if (input.reportedResult.observations.some(observation => observation.kind === 'requirement_gap')) return { kind: 'unclear_requirement', capability: 'none', wantedEvidence: 'Ett förtydligat ursprungligt krav innan utfallet kan bedömas.' };
    if (contextIssues.length || input.reportedResult.outcome === 'blocked') return { kind: 'environment_prerequisite', capability: 'none', wantedEvidence: contextIssues.length
      ? [...new Set(contextIssues.map(issue => contextNeeds[issue.code] ?? issue.message))].join(' ')
      : 'Verifierad upplöst blockerande förutsättning för den ursprungliga kontrollpunkten.' };
    if (input.evidence.some(evidence => evidence.readStatus === 'limited')) return { kind: 'evidence_read_limit', capability: 'review', wantedEvidence: 'Läsbart, begränsat granskningsurval av det redan sparade underlaget för kontrollpunkten.' };
    const check = input.reportedResult.checks?.find(check => check.id === requirementId);
    if (!check || !['verified', 'mismatch'].includes(check.status)) return { kind: 'unverified_step', capability: check?.status === 'blocked' ? 'none' : 'browser', wantedEvidence: 'En observerad genomförd kontrollpunkt från det oförändrade testfallet, med separat underlag.' };
    return { kind: 'missing_observation', capability: 'browser', wantedEvidence: 'Oberoende observerat underlag som visar utfallet för den ursprungliga kontrollpunkten.' };
  };
  return validateAssessment(input, {
    verdict: 'needs_evidence', summary: 'Det rapporterade resultatet saknar tillämpligt, oberoende underlag för granskning. Registrerat underlag kan vara oläst, otillgängligt eller inte uppfylla beviskraven.',
    findings: input.requirements.map(r => ({ requirementId: r.id, verdict: 'needs_evidence', explanation: 'Kontrollpunkten kan inte styrkas med tillämpligt, oberoende underlag. Detta innebär inte att registrerade underlag saknas.', evidenceIds: [], suggestedNextStep: 'Komplettera den angivna bevisluckan för det ursprungliga testet och begär en ny granskning.', gap: gap(r.id) })),
  });
}
