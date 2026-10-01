import { z } from 'zod';
import type { RunResult, TestTarget } from './test-run';

export const REVIEWER_VERSION = '1';
export const REVIEW_MODEL = 'glm-5.3-flash';
export type ReviewEvidence = {
  id: string; itemId: string | null; version: number | null; title: string;
  kind: string; mime: string; size: number; blobPath: string | null;
  captureId: string | null; runId: string | null; url: string | null;
  action: string | null; error: string | null; observedAt: string | null;
  sha256?: string; readStatus?: 'read' | 'unavailable' | 'limited';
};
export type RuleFinding = { code: string; requirementId: string | null; message: string };
export type ReviewInput = {
  schemaVersion: 1; runId: string; workspaceId: string; planVersion: number;
  startedAt: string; finishedAt: string; target: TestTarget | null; environment: string;
  requirements: { id: string; requirement: string }[];
  reportedResult: RunResult; evidence: ReviewEvidence[];
  ruleFindings: RuleFinding[];
};
export const assessmentSchema = z.object({
  verdict: z.enum(['supported', 'needs_evidence', 'contradicted']),
  summary: z.string().trim().min(1).max(1500),
  findings: z.array(z.object({
    requirementId: z.string().max(80),
    verdict: z.enum(['supported', 'needs_evidence', 'contradicted']),
    explanation: z.string().trim().min(1).max(2000),
    evidenceIds: z.array(z.string().max(100)).max(40),
    suggestedNextStep: z.string().max(1000),
  })).min(1).max(202),
});
export type Assessment = z.infer<typeof assessmentSchema>;
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
  if (!input.target?.revision) add('revision_unknown', 'Testad revision saknas. Versionsmatchning kan inte bekräftas.');
  if (!input.environment.trim()) add('environment_unknown', 'Testmiljön saknas.');
  for (const requirement of input.requirements) {
    const checks = input.reportedResult.checks?.filter(c => c.id === requirement.id) ?? [];
    if (checks.length !== 1) add('coverage_missing', 'Kontrollpunkten saknar en entydig observation.', requirement.id);
    else if (input.reportedResult.outcome === 'passed' && checks[0]!.status !== 'verified') add('coverage_incomplete', 'Godkännandet omfattar en overifierad kontrollpunkt.', requirement.id);
  }
  if (!input.evidence.length) add('evidence_missing', 'Inget separat underlag finns. Agentens egen slutsats är inte ett oberoende bevis.');
  for (const evidence of input.evidence) {
    if (evidence.runId && evidence.runId !== input.runId) add('run_mismatch', `Underlag ${evidence.id} hör till en annan körning.`);
    if (!evidence.runId) add('provenance_unknown', `Körningskoppling saknas för ${evidence.id}.`);
    if (evidence.error || evidence.readStatus === 'unavailable' || evidence.readStatus === 'limited') add('evidence_unread', `Underlag ${evidence.id} kunde inte granskas fullständigt.`);
    if (evidence.observedAt && (Date.parse(evidence.observedAt) < Date.parse(input.startedAt) || Date.parse(evidence.observedAt) > Date.parse(input.finishedAt))) add('time_mismatch', `Underlag ${evidence.id} ligger utanför körningens tidsintervall.`);
  }
  return findings;
}

export function validateAssessment(input: ReviewInput, value: unknown): Assessment {
  const result = assessmentSchema.parse(value);
  const ids = result.findings.map(f => f.requirementId);
  if (new Set(ids).size !== ids.length || ids.length !== input.requirements.length || input.requirements.some(r => !ids.includes(r.id))) throw new Error('Assessment must cover exactly the original requirements');
  for (const finding of result.findings) {
    if (finding.evidenceIds.some(id => !input.evidence.some(e => e.id === id && e.readStatus === 'read'))) throw new Error('Assessment references unread or unknown evidence');
    if (finding.verdict === 'supported' && !finding.evidenceIds.length) throw new Error('Supported finding needs evidence');
  }
  const expected = result.findings.some(f => f.verdict === 'contradicted') ? 'contradicted' : result.findings.some(f => f.verdict === 'needs_evidence') ? 'needs_evidence' : 'supported';
  if (result.verdict !== expected) throw new Error('Assessment summary contradicts its findings');
  // Unknown provenance and unread data must never silently become a full endorsement.
  if (result.verdict === 'supported' && input.ruleFindings.length) throw new Error('Unresolved rule findings prevent supported verdict');
  return result;
}

// No model is needed to determine that nothing can be independently inspected.
export function assessmentWithoutEvidence(input: ReviewInput): Assessment | null {
  if (input.evidence.some(e => e.readStatus === 'read' && !e.error)) return null;
  return validateAssessment(input, {
    verdict: 'needs_evidence', summary: 'Det finns inget läsbart underlag som kan styrka det rapporterade resultatet.',
    findings: input.requirements.map(r => ({ requirementId: r.id, verdict: 'needs_evidence', explanation: 'Kontrollpunkten saknar läsbart, separat underlag.', evidenceIds: [], suggestedNextStep: 'Komplettera med underlag från denna körning och begär en ny granskning.' })),
  });
}
