import { isIndependentEvidence, normalizeEvidenceProvenance } from './evidence-provenance.ts';
import { hasTargetIdentity, sameTarget, testTargetSchema, type TestTarget } from './test-target.ts';

// Bump consumers when applicability rules change, without rewriting saved
// acquisition metadata or historical reports.
export const EVIDENCE_RULES_VERSION = '5';
export type EvidenceTarget = TestTarget;
export type EvidenceContext = {
  schemaVersion: number; sourceType: string; sourceId: string;
  target?: EvidenceTarget | null; expectedTarget?: EvidenceTarget | null;
  environment?: string; startedAt?: string | null; finishedAt?: string | null;
};
export type EvidenceCandidate = {
  evidencePolicyVersion?: number; origin?: string; provenance?: unknown;
  unavailable?: boolean; stale?: boolean; error?: string | null;
  observedAt?: string | null; registeredSourceId?: string | null;
  readStatus?: 'read' | 'unavailable' | 'limited' | 'unread';
  requiresDigest?: boolean; digest?: string | null;
};
export type EvidenceRuleIssue = { code: string; message: string };
const executionSources = new Set(['test', 'setup', 'repository']);
const instant = (value: string | null | undefined) => Date.parse(value ?? '');

export function evidenceContextIssues(context: EvidenceContext): EvidenceRuleIssue[] {
  const issues: EvidenceRuleIssue[] = [];
  if (context.schemaVersion !== 2) issues.push({ code: 'evidence_policy_outdated', message: 'Underlaget använder en äldre bevispolicy.' });
  if (context.sourceType === 'test') {
    if (!context.target?.revision.trim() && !context.target?.scope) issues.push({ code: 'revision_unknown', message: 'Testad revision eller ett giltigt observationsscope saknas.' });
    if (context.target && !testTargetSchema.safeParse(context.target).success) issues.push({ code: 'target_identity_invalid', message: 'Testkörningens målidentitet innehåller ogiltiga eller oförenliga uppgifter.' });
    if (!context.target?.environment.trim() || context.environment !== undefined && !context.environment.trim()) issues.push({ code: 'environment_unknown', message: 'Testmiljön saknas.' });
    if (context.expectedTarget && !hasTargetIdentity(context.expectedTarget)) issues.push({ code: 'expected_target_unknown', message: 'Uppdragets målidentitet är ofullständig eller ogiltig.' });
    if (hasTargetIdentity(context.target) && hasTargetIdentity(context.expectedTarget) && !sameTarget(context.target!, context.expectedTarget!)) issues.push({ code: 'target_mismatch', message: 'Underlaget gäller ett annat testobjekt, en annan miljö, version eller observation.' });
    const start = instant(context.startedAt), finish = instant(context.finishedAt);
    if (!Number.isFinite(start) || !Number.isFinite(finish) || start > finish) issues.push({ code: 'source_window_unknown', message: 'Körningens tidsintervall saknas eller är ogiltigt.' });
    if (context.target?.scope && start < instant(context.target.scope.capturedAt)) issues.push({ code: 'observation_window_mismatch', message: 'Körningen startade före uppdragets observationsscope.' });
  }
  if (['repository', 'setup'].includes(context.sourceType) && context.expectedTarget?.revision.trim()) {
    // Repository/setup labels and URLs describe their execution environment,
    // not necessarily the application's test URL. Only compare the revision.
    if (!context.target?.revision.trim()) issues.push({ code: 'revision_unknown', message: 'Källans revision saknas och kan inte kopplas till uppdragets version.' });
    else if (context.target.revision !== context.expectedTarget.revision) issues.push({ code: 'target_mismatch', message: 'Källan gäller en annan version än uppdraget.' });
  }
  return issues;
}

/** Shared mechanical applicability only. The reviewer must still establish
 * whether the observed content supports the particular claim. */
export function evidenceApplicability(context: EvidenceContext, evidence: EvidenceCandidate, options: { requireRead?: boolean } = {}) {
  const issues = evidenceContextIssues(context);
  const add = (code: string, message: string) => issues.push({ code, message });
  const provenance = normalizeEvidenceProvenance(evidence.provenance);
  if (!isIndependentEvidence(evidence)) add('evidence_unattested', 'Underlaget saknar oberoende, verifierat ursprung.');
  if (evidence.stale) add('evidence_stale', 'Underlaget har ändrats sedan det valdes.');
  if (evidence.error || evidence.unavailable || evidence.readStatus === 'unavailable' || evidence.readStatus === 'limited' || options.requireRead !== false && evidence.readStatus !== 'read') add('evidence_unread', 'Underlaget kunde inte granskas fullständigt.');

  if (provenance?.sourceType && executionSources.has(provenance.sourceType) && provenance.sourceType !== context.sourceType) add('source_mismatch', 'En materialreferens ersätter inte underlagets ursprungliga körningskoppling.');
  if (executionSources.has(context.sourceType) && (provenance?.sourceType !== context.sourceType || provenance.sourceId !== context.sourceId)) add('source_mismatch', 'Underlaget hör inte till den angivna körningen.');
  if (evidence.registeredSourceId !== undefined && evidence.registeredSourceId !== context.sourceId) add(evidence.registeredSourceId ? 'source_mismatch' : 'provenance_unknown', 'Underlagets registrerade körningskoppling saknas eller gäller en annan körning.');

  const observed = instant(evidence.observedAt), producerObserved = instant(provenance?.observedAt);
  if ((evidence.observedAt != null || provenance?.observedAt != null) && (!Number.isFinite(observed) || !Number.isFinite(producerObserved) || observed !== producerObserved)) add('time_inconsistent', 'Observationstiden stämmer inte med den betrodda insamlingen.');
  if (context.sourceType === 'test') {
    if (!Number.isFinite(observed)) add('time_unknown', 'Underlagets observationstid saknas.');
    else if (observed < instant(context.startedAt) || observed > instant(context.finishedAt)) add('time_mismatch', 'Underlaget ligger utanför körningens tidsintervall.');
  }
  if (evidence.requiresDigest || provenance?.sha256) {
    if (!provenance?.sha256) add('digest_missing', 'Filens betrodda innehållsidentitet saknas.');
    else if (options.requireRead !== false && evidence.digest !== provenance.sha256) add('digest_mismatch', 'Lästa filbytes matchar inte det sparade underlaget.');
  }
  return { eligible: issues.length === 0, issues };
}
