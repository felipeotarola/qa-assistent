import type { EvidenceRead, MissionSnapshot, WorkResult } from './mission.ts';
import { criterionEvidenceScope } from './mission-regression.ts';
import { evidenceApplicability } from './evidence-rules.ts';

export type ReportRemediationKind = 'obtain_independent_observation' | 'restore_readable_evidence' | 'establish_target_identity' | 'rerun_current_case' | 'review_existing_evidence' | 'explain_unresolved';
export type ReportRemediation = {
  version: 1; criterionId: string; preservesOriginalCriterion: true;
  reasons: string[]; actions: { kind: ReportRemediationKind; requiresNewEvidence: boolean; requiresExecutionAuthorization: boolean; requiresNewMandate: boolean; scope: 'original_saved_evidence' | 'original_criterion' | 'new_mandate' }[];
  sourceRefs: { type: WorkResult['sourceType']; id: string }[];
  completionStatement: string; nextStep: string;
};

const targetIssues = new Set(['target_unknown', 'revision_unknown', 'environment_unknown', 'expected_target_unknown', 'target_identity_invalid', 'target_mismatch', 'source_window_unknown', 'observation_window_mismatch', 'time_unknown', 'time_inconsistent', 'time_mismatch']);
const observationIssues = new Set(['source_missing', 'run_missing', 'run_incomplete', 'result_missing', 'result_incomplete', 'result_scope_invalid', 'check_missing', 'check_incomplete', 'check_ambiguous', 'evidence_missing', 'evidence_unattested', 'provenance_unknown', 'source_mismatch', 'digest_missing', 'digest_mismatch', 'evidence_policy_outdated']);
const reviewIssues = new Set(['review_missing', 'review_unresolved', 'review_check_unresolved', 'review_unknown_check']);

function criterionSources(snapshot: MissionSnapshot, criterionId: string) {
  const criterion = snapshot.config.criteria.find(value => value.id === criterionId);
  const sources = snapshot.tasks.filter(task => task.criterionIds.includes(criterionId)).flatMap(task => task.sources);
  if (criterion?.delivery?.kind === 'source') {
    const refs = criterion.delivery.sourceRefs ?? [];
    const types = criterion.delivery.sourceTypes.filter(type => !refs.some(ref => ref.type === type));
    return sources.filter(source => refs.some(ref => ref.type === source.sourceType && ref.id === source.sourceId) || types.includes(source.sourceType));
  }
  if (criterion?.delivery?.kind === 'regression_comparison') {
    const delivery = criterion.delivery, current = snapshot.delivery?.cases.find(test => test.caseKey === delivery.caseKey)?.runId;
    return sources.filter(source => source.sourceType === 'test' && (source.sourceId === delivery.baseline?.runId || source.sourceId === current));
  }
  if (criterion?.delivery?.kind === 'test_cases') {
    const ids = criterion.delivery.caseKeys.map(key => snapshot.delivery?.cases.find(value => value.caseKey === key)?.runId);
    return sources.filter(source => source.sourceType === 'test' && ids.includes(source.sourceId));
  }
  return sources;
}

function applicability(snapshot: MissionSnapshot, source: WorkResult, item: WorkResult['evidence'][number], read?: EvidenceRead, requireRead = true, criterionId?: string) {
  const scope = criterionId ? criterionEvidenceScope(snapshot, criterionId, source) : { allowed: true, target: snapshot.config.target };
  if (!scope.allowed) return { eligible: false, issues: [{ code: 'regression_source_unbound', message: 'Källan är inte exakt bunden till denna jämförelse.' }] };
  return evidenceApplicability({ schemaVersion: source.schemaVersion, sourceType: source.sourceType, sourceId: source.sourceId, target: source.target, expectedTarget: scope.target, startedAt: source.startedAt, finishedAt: source.finishedAt },
    { ...item, ...(requireRead ? {} : { unavailable: false }), requiresDigest: item.kind === 'image', digest: read?.digest,
      readStatus: !requireRead ? undefined : !read ? 'unread' : read.unavailable ? 'unavailable' : read.limited ? 'limited' : 'read' }, { requireRead });
}

/** Independent dimensions: policy exclusions overlap physical reading status. */
export function reportEvidenceAvailability(snapshot: MissionSnapshot, reads: ReadonlyMap<string, EvidenceRead>) {
  const entries = new Map<string, { source: WorkResult; item: WorkResult['evidence'][number]; criterionIds: string[] }>();
  for (const criterion of snapshot.config.criteria) for (const source of criterionSources(snapshot, criterion.id)) for (const item of source.evidence) {
    const key = `${source.sourceType}:${source.sourceId}:${item.id}`, prior = entries.get(key);
    if (prior) prior.criterionIds.push(criterion.id); else entries.set(key, { source, item, criterionIds: [criterion.id] });
  }
  const counts = { registered: entries.size, fullyRead: 0, unread: 0, unavailable: 0, limited: 0, policyExcluded: 0 };
  for (const { source, item, criterionIds } of entries.values()) {
    const read = reads.get(item.id);
    if (read?.unavailable || item.unavailable) counts.unavailable++;
    else if (read?.limited) counts.limited++;
    else if (read && (read.text || read.image)) counts.fullyRead++;
    else counts.unread++;
    if (!criterionIds.some(id => applicability(snapshot, source, item, read, false, id).eligible)) counts.policyExcluded++;
  }
  return counts;
}

export function reportObservationOrigin(snapshot: MissionSnapshot, criterionId: string, evidenceIds: string[], reads: ReadonlyMap<string, EvidenceRead>) {
  const labels = new Set<string>();
  for (const id of evidenceIds) {
    const matches = snapshot.tasks.filter(task => task.criterionIds.includes(criterionId)).flatMap(task => task.sources.flatMap(source => source.evidence.filter(item => item.id === id).map(item => ({ source, item }))));
    if (!matches.length) labels.add('Okänt ursprung; källpåstående, inte verifiering');
    for (const { source, item } of matches) {
      if (applicability(snapshot, source, item, reads.get(id), true, criterionId).eligible) labels.add(criterionEvidenceScope(snapshot, criterionId, source).role === 'historical' ? 'Läst historiskt verktygsunderlag; gäller den tidigare körningens mål och tid' : 'Läst oberoende verktygsunderlag');
      else if (item.origin === 'agent') labels.add('Agentpåstående; inte oberoende verifiering');
      else if (item.origin === 'user') labels.add('Användaruppgift; inte oberoende verifiering');
      else if (item.origin === 'tool') labels.add('Verktygskälla utanför kriteriets bevisvillkor; inte verifiering');
      else labels.add('Okänt ursprung; källpåstående, inte verifiering');
    }
  }
  return [...labels].sort().join(' · ');
}

export function reportSummary(snapshot: MissionSnapshot, findings: { verdict: string }[], reads: ReadonlyMap<string, EvidenceRead>) {
  const supported = findings.filter(finding => finding.verdict === 'supported').length;
  const contradicted = findings.filter(finding => finding.verdict === 'contradicted').length;
  const needed = findings.filter(finding => finding.verdict === 'needs_evidence').length;
  const counts = reportEvidenceAvailability(snapshot, reads);
  const outcomes = { passed: 0, failed: 0, other: 0 };
  const selectedRuns = new Set(snapshot.config.criteria.flatMap(criterion => criterionSources(snapshot, criterion.id).filter(source => source.sourceType === 'test').map(source => source.sourceId)));
  const selectedCases = new Set(snapshot.config.criteria.flatMap(criterion => criterion.delivery?.kind === 'test_cases' ? criterion.delivery.caseKeys : []));
  const tests = [...new Map(snapshot.tests.filter(test => test.runId ? selectedRuns.has(test.runId) : selectedCases.has(test.key)).map(test => [test.runId ?? test.key, test])).values()];
  for (const test of tests) {
    if (test.originalOutcome === 'passed') outcomes.passed++;
    else if (test.originalOutcome === 'failed') outcomes.failed++;
    else outcomes.other++;
  }
  return [
    `${snapshot.reportPurpose === 'interim' ? 'Delrapporten' : 'Rapporten'} omfattar ${findings.length} ursprungliga kriterier: ${supported} underbyggda, ${contradicted} motsagda och ${needed} med kvarvarande bevisluckor.`,
    tests.length ? `Urvalets sparade testutfall: ${outcomes.passed} godkända, ${outcomes.failed} misslyckade och ${outcomes.other} övriga eller oklara.` : '',
    `Underlag: ${counts.fullyRead} av ${counts.registered} referenser lästes fullständigt${counts.unread ? `, ${counts.unread} lästes inte` : ''}${counts.limited ? `, ${counts.limited} lästes ofullständigt` : ''}${counts.unavailable ? `, ${counts.unavailable} var markerade som otillgängliga` : ''}.`,
    counts.policyExcluded ? `${counts.policyExcluded} uppfyller inte bevisvillkoren; det är skilt från lässtatus och betyder inte att filerna är oläsbara.` : '',
    snapshot.delivery?.complete ? '' : 'Ursprungsurvalets leverans är inte fullständig.',
  ].filter(Boolean).join(' ');
}

/** Metadata can identify an unmet prerequisite, never prove product behavior.
 * This is a recommendation only; it grants no execution or continuation. */
export function reportRemediation(snapshot: MissionSnapshot, criterionId: string, verdict: 'supported' | 'needs_evidence' | 'contradicted', reads: ReadonlyMap<string, EvidenceRead>): ReportRemediation {
  const criterion = snapshot.config.criteria.find(value => value.id === criterionId);
  const delivery = snapshot.delivery?.criteria.find(value => value.criterionId === criterionId);
  const exactRefs = criterion?.delivery?.kind === 'source' ? criterion.delivery.sourceRefs ?? [] : criterion?.delivery?.kind === 'regression_comparison' && criterion.delivery.baseline ? [{ type: 'test' as const, id: criterion.delivery.baseline.runId }] : [];
  const sources = snapshot.tasks.filter(task => task.criterionIds.includes(criterionId)).flatMap(task => task.sources);
  const reasons = new Set(delivery?.gaps.map(gap => gap.code) ?? ['expectation_unknown']);
  const refs = new Map<string, { type: WorkResult['sourceType']; id: string }>();
  const kinds = new Set<ReportRemediationKind>();
  const addKind = (kind: ReportRemediationKind) => kinds.add(kind);
  const inspect = (candidates: WorkResult[]) => {
    const evidence = candidates.flatMap(source => source.evidence.map(item => {
      const read = reads.get(item.id);
      return { source, item, read,
        acquired: applicability(snapshot, source, item, read, false, criterionId),
        current: applicability(snapshot, source, item, read, true, criterionId),
      };
    }));
    // An optional bad attachment cannot poison a source with valid read proof.
    if (evidence.some(value => value.current.eligible && (value.read?.text || value.read?.image))) return;
    for (const source of candidates) refs.set(`${source.sourceType}:${source.sourceId}`, { type: source.sourceType, id: source.sourceId });
    if (!evidence.length) { reasons.add('evidence_missing'); return; }
    for (const value of evidence) {
      if (value.item.unavailable || value.read?.unavailable) { reasons.add('read_unavailable'); addKind('restore_readable_evidence'); }
      else if (!value.read || value.read.limited || !value.read.text && !value.read.image) { reasons.add(value.read?.limited ? 'read_limited' : 'read_omitted'); addKind('review_existing_evidence'); }
    }
    const eligibleAcquisitions = evidence.filter(value => value.acquired.eligible);
    if (!eligibleAcquisitions.length) {
      for (const value of evidence) for (const issue of value.acquired.issues) reasons.add(issue.code);
      return;
    }
    for (const value of eligibleAcquisitions) {
      // No bytes means no content-hash comparison was performed. Do not turn
      // an omitted read into a claim that the stored bytes have changed.
      if (value.read && !value.read.unavailable && !value.read.limited && (value.read.text || value.read.image)) {
        for (const issue of value.current.issues) if (issue.code !== 'evidence_unread') reasons.add(issue.code);
      }
    }
  };
  if (verdict !== 'supported') {
    if (criterion?.delivery?.kind === 'source') {
      for (const ref of exactRefs) { refs.set(`${ref.type}:${ref.id}`, ref); inspect(sources.filter(source => source.sourceType === ref.type && source.sourceId === ref.id)); }
      for (const type of criterion.delivery.sourceTypes.filter(type => !exactRefs.some(ref => ref.type === type))) inspect(sources.filter(source => source.sourceType === type));
    } else if (criterion?.delivery?.kind === 'test_cases') {
      for (const key of criterion.delivery.caseKeys) {
        const runId = snapshot.delivery?.cases.find(value => value.caseKey === key)?.runId;
        inspect(sources.filter(source => source.sourceType === 'test' && source.sourceId === runId));
      }
    } else inspect(criterionSources(snapshot, criterionId));
    if ([...reasons].some(code => targetIssues.has(code))) addKind('establish_target_identity');
    if ([...reasons].some(code => observationIssues.has(code))) addKind('obtain_independent_observation');
    if (reasons.has('run_stale') || reasons.has('evidence_stale')) addKind('rerun_current_case');
    if ([...reasons].some(code => reviewIssues.has(code))) addKind('review_existing_evidence');
    if (reasons.has('evidence_unavailable')) addKind('restore_readable_evidence');
    if (verdict === 'needs_evidence' && !kinds.size) addKind('explain_unresolved');
  }
  const actions = [...kinds].map(kind => {
    const requiresNewEvidence = ['obtain_independent_observation', 'rerun_current_case'].includes(kind);
    return { kind, requiresNewEvidence, requiresExecutionAuthorization: requiresNewEvidence, requiresNewMandate: requiresNewEvidence && !!exactRefs.length,
      scope: requiresNewEvidence ? exactRefs.length ? 'new_mandate' as const : 'original_criterion' as const : 'original_saved_evidence' as const };
  });
  const completionStatement = verdict === 'supported'
    ? 'Det rapporterade resultatet är underbyggt för originalkriteriet. Det kan omfatta ett verifierat produktfel.'
    : verdict === 'contradicted'
      ? `Läst underlag motsäger den rapporterade slutsatsen. Detta avgör inte ensamt om produkten är felaktig.${delivery?.complete ? '' : ' Originalkriteriets leverans är fortfarande ofullständig.'}`
      : 'Originalkriteriet är inte fullt underbyggt. Ändrat urval eller märkning styrker inte originalkravet.';
  const texts: Record<ReportRemediationKind, string> = {
    obtain_independent_observation: 'Samla oberoende underlag för återstående originalkontroller i en ny avgränsad körning inom godkänd omfattning.',
    restore_readable_evidence: 'Återställ åtkomst och läs exakt samma sparade version med samma innehållshash. Ersättningsbytes är nytt underlag.',
    establish_target_identity: 'Sök betrodd, oföränderlig insamlingsmetadata som binder originalet till rätt miljö, version och tid. Saknas den behövs nya observationer; en efterhandsifylld etikett räcker inte.',
    rerun_current_case: 'Gör en ny avgränsad körning av den aktuella testdefinitionen inom godkänd omfattning.',
    review_existing_evidence: 'Gör en ny fullständig läsning och granskning av de exakt sparade underlagen. Övriga bevisluckor kvarstår.',
    explain_unresolved: 'Precisera vilken originalkontroll som saknar stöd innan mer arbete beställs.',
  };
  const nextStep = verdict === 'supported' ? '' : [
    ...actions.map(action => texts[action.kind]),
    exactRefs.length && actions.some(action => action.requiresNewEvidence) ? 'Nya källor hör till ett nytt uppdrag och uppfyller inte detta originalurval.' : '',
    verdict === 'contradicted' && !actions.length ? 'Stäm av den rapporterade slutsatsen mot de lästa observationerna. Metadata ger inget stöd för att automatiskt beställa omtest eller produktreparation.' : '',
    actions.some(action => action.requiresNewEvidence) ? 'Bevara avslutade körningar oförändrade. Nytt underlag behöver en egen granskning.' : '',
  ].filter(Boolean).join(' ');
  if (criterion?.delivery?.kind === 'regression_comparison' && verdict === 'needs_evidence') return { version: 1, criterionId, preservesOriginalCriterion: true, reasons: [...reasons].sort(), actions, sourceRefs: [...refs.values()], completionStatement: 'Jämförelsen mellan den frysta tidigare körningen och det nya resultatet är inte fullt underbyggd. Den nya körningens QA bedöms separat.', nextStep: 'Granska de exakt sparade körningarna och kvarvarande jämförelseluckor. Nytt underlag eller ändrade krav ersätter inte det historiska originalet.' };
  return { version: 1, criterionId, preservesOriginalCriterion: true, reasons: [...reasons].sort(), actions, sourceRefs: [...refs.values()], completionStatement, nextStep };
}
