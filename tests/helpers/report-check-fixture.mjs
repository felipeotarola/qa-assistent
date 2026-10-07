import { reviewedReportChecks } from '../../shared/mission-report.ts';
import { missionReportCheckSubjects } from '../../shared/mission-report-context.ts';

// Current synthetic writer fixtures still use real reads and final validation.
// Do not infer a semantic relation or introduce citations for unread sources.
export function reportFixtureObservations(snapshot, criterionId, readIds, text, reads = new Map()) {
  const reviewed = reviewedReportChecks(snapshot, reads);
  const checks = missionReportCheckSubjects(snapshot, new Set(readIds));
  if (![...checks.values()].some(check => check.criterionIds.includes(criterionId))) return readIds.length ? [{ text, evidenceIds: readIds }] : [];
  return [...checks].filter(([ref, check]) => !reviewed.has(ref) && check.criterionIds[0] === criterionId && check.evidenceIds.length)
    .map(([checkRef, check]) => ({ subject: { checkRef, relation: 'unresolved' }, text, evidenceIds: check.evidenceIds }));
}
