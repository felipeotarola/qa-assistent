import { checkPartsSchema, partsProjection, partsEvidenceIssue, readObservation, boundedObservationIndex, type ReadObservation } from './review-observations.ts';
import { z } from 'zod';
import type { MissionSnapshot, EvidenceRead } from './mission.ts';
import { criterionSupportError, readIndependentCriterionEvidence, hasIndependentReportCheck, reviewedReportChecks } from './mission-report.ts';
import { REPORT_CHECK_LIMIT, REPORT_CHECK_TEXT_LIMIT, REPORT_FACT_TEXT_LIMIT, REPORT_FACT_NOTE_LIMIT, missionReportCheckSubjects } from './mission-report-context.ts';

/** Mechanical constraints only; the writer still judges the actual evidence. */
export function missionReportOutput(snapshot: MissionSnapshot, reads: ReadonlyMap<string, EvidenceRead>) {
  const readIds = new Set([...reads.values()].filter(read => !read.unavailable && !read.limited && (read.text || read.image)).map(read => read.id));
  const checks = missionReportCheckSubjects(snapshot, readIds);
  const assessed = new Map([...checks].filter(([, check]) => check.evidenceIds.length));
  if (assessed.size > REPORT_CHECK_LIMIT) throw new Error('Report check capacity exceeded');
  const reviewed = reviewedReportChecks(snapshot, reads);
  for (const ref of reviewed.keys()) assessed.delete(ref);
  const observations: ReadObservation[] = [];
  for (const criterion of snapshot.config.criteria) {
    for (const { source, evidence } of readIndependentCriterionEvidence(snapshot, criterion.id, readIds, reads)) {
      if (source.sourceType !== 'test') continue;
      if (![...assessed.values()].some(check => check.evidenceIds.includes(evidence.id))) continue;
      const observation = readObservation(evidence, reads.get(evidence.id), source.sourceId);
      if (observation) observations.push(observation);
    }
  }
  const readObservations = boundedObservationIndex(observations);
  const criteria = snapshot.config.criteria.map(criterion => {
    const independent = readIndependentCriterionEvidence(snapshot, criterion.id, readIds, reads);
    const supportIssue = criterionSupportError(snapshot, criterion.id, independent)
      ?? ([...reviewed.values()].some(row => row.criterionIds.includes(criterion.id) && row.relation !== 'supports') ? 'Current saved review is unresolved or contradicted.' : null);
    const allowedVerdicts: ('supported' | 'needs_evidence' | 'contradicted')[] = !independent.length || criterion.delivery?.kind === 'regression_comparison' && !!supportIssue ? ['needs_evidence']
      : supportIssue ? ['needs_evidence', 'contradicted'] : ['supported', 'needs_evidence', 'contradicted'];
    const evidenceIds = [...new Set(snapshot.tasks.filter(task => task.criterionIds.includes(criterion.id))
      .flatMap(task => task.sources.flatMap(source => source.evidence.filter(evidence => readIds.has(evidence.id)).map(evidence => evidence.id))))];
    const checkRefs = [...assessed].filter(([, check]) => check.criterionIds.includes(criterion.id)).map(([ref]) => ref);
    return { criterionId: criterion.id, allowedVerdicts, evidenceIds, checkRefs, hasChecks: [...checks.values()].some(check => check.criterionIds.includes(criterion.id)),
      constraint: !independent.length ? 'No applicable independent evidence was fully read for this criterion.' : supportIssue,
    };
  });
  if (!criteria.length || new Set(criteria.map(criterion => criterion.criterionId)).size !== criteria.length) throw new Error('Report must cover every original criterion');
  const variants = criteria.map(criterion => {
    const fields = {
      text: z.string().min(1).max(criterion.hasChecks ? 300 : 2000).describe('En citerad faktisk observation. Ingen kontrollpunktsbedömning, lässtatusdiagnos eller åtgärd.'),
      evidenceIds: z.array(criterion.evidenceIds.length ? z.enum(criterion.evidenceIds as [string, ...string[]]) : z.string()).min(1).max(Math.min(30, Math.max(1, criterion.evidenceIds.length))),
    };
    const observation = z.object(fields).strict();
    const base = z.object({ criterionId: z.literal(criterion.criterionId),
      verdict: z.enum(criterion.allowedVerdicts as [typeof criterion.allowedVerdicts[number], ...typeof criterion.allowedVerdicts[number][]]),
    }).strict();
    return criterion.hasChecks ? base.extend({ factualNotes: z.array(observation).max(criterion.evidenceIds.length ? REPORT_FACT_NOTE_LIMIT : 0) })
      : base.extend({ observations: z.array(observation).max(criterion.evidenceIds.length ? 8 : 0) });
  });
  const finding = variants.length === 1 ? variants[0]!
    : z.discriminatedUnion('criterionId', variants as [typeof variants[number], ...typeof variants[number][]]);
  const assessment = checkPartsSchema.extend({
    text: z.string().min(1).max(REPORT_CHECK_TEXT_LIMIT).describe('Faithful concise summary of all parts and original properties, including uncertainties or contradictions. No new claims and no original requirement copy. This is the stored report text.'),
    checkRef: z.enum(assessed.size ? [...assessed.keys()] as [string, ...string[]] : ['unavailable']),
  });
  const base = z.object({ findings: z.array(finding).length(criteria.length) }).strict();
  const structure: z.ZodType<{ findings: z.infer<typeof finding>[]; checkAssessments?: z.infer<typeof assessment>[] }> = checks.size
    ? base.extend({ checkAssessments: z.array(assessment).length(assessed.size).describe(`Every check has a stored text summary of at most ${REPORT_CHECK_TEXT_LIMIT} characters. Parts retain the supporting subassessments; their text is not concatenated into the stored summary. Stored summaries and other report factual text together use at most ${REPORT_FACT_TEXT_LIMIT} characters.`) }) : base;
  const schema = structure.superRefine((draft, ctx) => {
    if (new Set(draft.findings.map(finding => finding.criterionId)).size !== criteria.length) ctx.addIssue({ code: 'custom', path: ['findings'], message: 'Report must cover every original criterion' });
    const rows = draft.checkAssessments ?? [];
    if (new Set(rows.map(row => row.checkRef)).size !== assessed.size) ctx.addIssue({ code: 'custom', path: ['checkAssessments'], message: 'Report must assess every fully read original check exactly once' });
    rows.forEach((row, index) => {
      const check = assessed.get(row.checkRef), projected = partsProjection(row);
      if (!projected.evidenceIds.length || row.parts.reduce((sum, part) => sum + part.evidenceIds.length, 0) > 30) ctx.addIssue({ code: 'custom', path: ['checkAssessments', index], message: 'Check parts require bounded source citations' });
      if (check) {
        const independent = new Set(check.evidenceIds.filter(evidenceId => check.criterionIds.every(id => hasIndependentReportCheck(snapshot, id, row.checkRef, [evidenceId], reads))));
        const issue = partsEvidenceIssue(row, new Set(check.evidenceIds), independent, readObservations);
        if (issue) ctx.addIssue({ code: 'custom', path: ['checkAssessments', index], message: issue });
      }
      if (!check || partsProjection(row).evidenceIds.some(id => !check.evidenceIds.includes(id))) {
        ctx.addIssue({ code: 'custom', path: ['checkAssessments', index], message: 'Check assessment must cite its exact fully read source' });
      } else if (partsProjection(row).relation !== 'unresolved' && check.criterionIds.some(id => !hasIndependentReportCheck(snapshot, id, row.checkRef, partsProjection(row).evidenceIds, reads))) {
        ctx.addIssue({ code: 'custom', path: ['checkAssessments', index], message: 'Conclusive check relation requires applicable independent evidence from this source for every bound criterion' });
      }
    });
    const notes = draft.findings.flatMap(finding => 'factualNotes' in finding ? finding.factualNotes : []);
    if (notes.length > REPORT_FACT_NOTE_LIMIT) ctx.addIssue({ code: 'custom', path: ['findings'], message: 'Report factual note capacity exceeded' });
    const characters = [...rows, ...notes, ...draft.findings.flatMap(finding => 'observations' in finding ? finding.observations : [])].reduce((sum, value) => sum + value.text.length, 0);
    if (characters > REPORT_FACT_TEXT_LIMIT) ctx.addIssue({ code: 'custom', message: 'Report factual text capacity exceeded' });
  });
  // One assessment per immutable check, even if several criteria share it.
  // Other criteria receive code-owned cross-references during assembly.
  const toDraft = (value: unknown) => {
    const parsed = schema.parse(value);
    return {
      summary: 'Rapportens status sammanställs av systemet.', limitations: [],
      findings: parsed.findings.map(finding => {
        const bound = (parsed.checkAssessments ?? []).filter(row => assessed.get(row.checkRef)!.criterionIds.includes(finding.criterionId));
        const owned = bound.filter(row => assessed.get(row.checkRef)!.criterionIds[0] === finding.criterionId);
        const observations = [
          ...owned.map(row => { const projected = partsProjection(row); return { text: row.text, evidenceIds: projected.evidenceIds, subject: { checkRef: row.checkRef, relation: projected.relation } }; }),
          ...('factualNotes' in finding ? finding.factualNotes : finding.observations),
        ];
        return { criterionId: finding.criterionId, verdict: finding.verdict, observations,
          evidenceIds: [...new Set([...observations.flatMap(row => row.evidenceIds), ...bound.flatMap(row => partsProjection(row).evidenceIds), ...[...reviewed.values()].filter(row => row.criterionIds.includes(finding.criterionId)).flatMap(row => row.evidenceIds)])],
          conclusion: 'Kriteriets status sammanställs av systemet.', nextStep: '',
        };
      }),
    };
  };
  return { schema, criteria, toDraft, readObservations, requiredCheckRefs: [...assessed.keys()],
    savedChecks: [...reviewed].map(([checkRef, row]) => ({ checkRef, reportedStatus: row.savedReview.reportedStatus, verdict: row.savedReview.finding.verdict, evidenceIds: row.evidenceIds })),
  };
}
