import { z } from 'zod';
import type { ReportDocument } from './mission-report';
export function sharedReportDocument(source: ReportDocument, included: string[]): ReportDocument {
  // Scrub internal URLs even when they occur in a generated paragraph or metric label.
  const scrub = (value: unknown): unknown => typeof value === 'string' ? value.replace(/https?:\/\/[^\s<>"']+/g, url => isPublicHost(url) ? url : '[intern testadress]') : Array.isArray(value) ? value.map(scrub) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)])) : value;
  // Explicit projection: future internal contract fields must not silently
  // become part of an already public report.
  return scrub({
    schemaVersion: source.schemaVersion, title: source.title, capturedAt: source.capturedAt,
    revision: source.revision, goal: source.goal, scope: source.scope, target: source.target,
    partial: source.partial, summary: source.summary, limitations: source.limitations,
    criteria: source.criteria.map(({ id, text }) => ({ id, text })),
    findings: source.findings.map(({ criterionId, verdict, conclusion, evidenceIds, nextStep, completionStatement, observations }) => ({ criterionId, verdict, conclusion, evidenceIds, nextStep, ...(completionStatement ? { completionStatement } : {}), ...(observations ? { observations: observations.map(({ text, evidenceIds, originLabel, subject, savedReview }) => ({ text, evidenceIds, originLabel,
      ...(savedReview ? { savedReview: { version: savedReview.version, reportedStatus: savedReview.reportedStatus, reportedActual: savedReview.reportedActual,
        reviewerVersion: savedReview.reviewerVersion, finding: { verdict: savedReview.finding.verdict, explanation: savedReview.finding.explanation,
          suggestedNextStep: savedReview.finding.suggestedNextStep, gap: savedReview.finding.gap ? { kind: savedReview.finding.gap.kind, capability: savedReview.finding.gap.capability, wantedEvidence: savedReview.finding.gap.wantedEvidence } : null } } } : {}), ...(subject ? { subject: { requirement: subject.requirement, relation: subject.relation } } : {}) })) } : {}) })),
    metrics: source.metrics.map(({ id, label, data }) => ({ id, label, data: data.map(({ label, value }) => ({ label, value })) })),
    tasks: source.tasks.map(({ id, title, actor, parentId, dependsOn, status, reportedOutcome, startedAt, finishedAt }) => ({ id, title, actor, parentId, dependsOn, status, reportedOutcome, startedAt, finishedAt })),
    tests: source.tests.map(({ key, title, status, review, target, originalOutcome, manualReview }) => ({ key, title, status, runId: null, review, target, originalOutcome, manualReview })),
    evidence: source.evidence.map(({ id, title, version, kind, url, observedAt, read }) => ({ id, title, itemId: null, version, kind: included.includes(id) ? kind : 'unshared', url: safeReportUrl(url), observedAt, read })),
  }) as ReportDocument;
}
export const shareActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), mode: z.enum(['public', 'pin']), pin: z.string().regex(/^\d{6}$/).optional(), evidenceIds: z.array(z.string().max(120)).max(50), expiresAt: z.string().datetime().nullable() }),
  z.object({ action: z.literal('revoke') }),
  z.object({ action: z.literal('change_pin'), pin: z.string().regex(/^\d{6}$/) }),
]);
export const unlockShareSchema = z.object({ pin: z.string().regex(/^\d{6}$/) });
export function safeReportUrl(value: string | null) {
  if (!value) return null;
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && isPublicHost(value) && !u.username && !u.password && !u.search && !u.hash ? u.href : null; } catch { return null; }
}
function isPublicHost(value: string) {
  try { const u = new URL(value), host = u.hostname.toLowerCase(); return !u.username && !u.password && host.includes('.') && !/(?:^localhost$|\.localhost$|\.local$|\.internal$|^127\.|^0\.|^10\.|^192\.168\.|^169\.254\.|^172\.(?:1[6-9]|2\d|3[01])\.|^\[)/.test(host); } catch { return false; }
}
