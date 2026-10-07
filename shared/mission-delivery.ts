import type { MissionConfig, MissionTaskView, WorkResult } from './mission.ts';
import { MAX_CRITERION_DELIVERIES } from './mission.ts';
import type { WorkspaceItem } from './workspace.ts';
import type { TestRun } from './test-run.ts';
import { runCoverage, runResultScope, runVerificationError } from './test-run.ts';
import { caseReady } from './test-plan.ts';
import { defaultQuality, qualitySummary, sameTarget, sameCase } from './quality.ts';
import { evidenceContextIssues } from './evidence-rules.ts';
import { REVIEWER_VERSION } from './result-assessment.ts';
import { matchesRegressionBaseline, regressionHistoryRefs, sameRegressionRequirement } from './mission-regression.ts';
import { hasTargetIdentity } from './test-target.ts';

export const DELIVERY_POLICY_VERSION = 4 as const;
export type DeliveryGap = {
  code: string; message: string; criterionId?: string; caseKey?: string;
  taskId?: string; sourceType?: WorkResult['sourceType']; sourceId?: string; requirementId?: string;
};
export type CaseDelivery = { caseKey: string; runId: string | null; complete: boolean; gaps: DeliveryGap[] };
export type DeliveryProjection = {
  schemaVersion: typeof DELIVERY_POLICY_VERSION; complete: boolean;
  criteria: { criterionId: string; complete: boolean; gaps: DeliveryGap[] }[];
  cases: CaseDelivery[]; gaps: DeliveryGap[];
};

/** Same run-level completeness rules for case selections and explicit saved runs. */
function runDeliveryGaps(run: TestRun, source: WorkResult | undefined, target: MissionConfig['target']) {
  const gaps: DeliveryGap[] = [];
  const add = (code: string, message: string, requirementId?: string) => gaps.push({ code, message, ...(requirementId ? { requirementId } : {}) });
  if (!source) add('run_unbound', 'Testkörningen är inte kopplad till någon av uppdragets deluppgifter.');
  if (!hasTargetIdentity(run.target) || !hasTargetIdentity(target)) add('target_unknown', 'Testkörningens eller uppdragets målidentitet är inte känd.');
  else if (!sameTarget(run.target!, target!)) add('target_mismatch', 'Testkörningen gäller inte uppdragets aktuella testobjekt.');
  if (!Number.isFinite(Date.parse(run.startedAt)) || !run.finishedAt || !Number.isFinite(Date.parse(run.finishedAt)) || Date.parse(run.finishedAt) < Date.parse(run.startedAt)) add('run_incomplete', 'Testkörningen saknar ett giltigt avslutat tidsintervall.');
  if (!caseReady(run.snapshot)) add('definition_incomplete', 'Testfallet saknar beskrivna steg eller förväntat resultat.');
  if (!run.result) add('result_missing', 'Testkörningen saknar ett sparat resultat.');
  else {
    const manual = run.reviews?.[0];
    if (manual && (!['passed', 'failed'].includes(manual.outcome) || manual.outcome !== run.result.outcome)) add('manual_review_unresolved', 'En manuell reservation eller ändrad bedömning behöver stämmas av mot originalresultatet.');
    if (!['passed', 'failed'].includes(run.result.outcome) || runResultScope(run.result).remaining.length || run.result.observations?.some(observation => observation.kind === 'requirement_gap')) add('result_incomplete', 'Testresultatet innehåller otestade, blockerade eller oklara delar.');
    if (run.result.schemaVersion === 2 && runVerificationError(run.snapshot, run.result)) add('result_scope_invalid', 'Resultatets återstående kontroller stämmer inte med originaltestets kontrollpunkter.');
    const coverage = runCoverage(run.snapshot, run.result);
    const recorded = run.result.checks ?? [];
    if (recorded.some(check => !coverage.checks.some(required => required.id === check.id))) add('check_unknown', 'Resultatet innehåller en kontrollpunkt som inte ingår i testfallet.');
    for (const check of coverage.checks) {
      const count = recorded.filter(saved => saved.id === check.id).length;
      if (count !== 1) add(count ? 'check_ambiguous' : 'check_missing', 'Kontrollpunkten saknar en entydig sparad observation.', check.id);
      else if (!['verified', 'mismatch'].includes(check.status)) add('check_incomplete', 'Kontrollpunkten har inte utförts färdigt.', check.id);
    }
    const review = source?.assessment;
    if (!review || review.stale || review.reviewerVersion !== REVIEWER_VERSION || !review.findings) add('review_missing', 'En aktuell granskning av samtliga kontrollpunkter saknas.');
    else {
      if (review.verdict !== 'supported') add('review_unresolved', 'Granskningen styrker inte hela det rapporterade resultatet.');
      // Current assessments already validate applicable proof per finding.
      // Warnings about unused attachments are not missing QA deliveries.
      if (review.findings.some(finding => !coverage.checks.some(check => check.id === finding.requirementId))) add('review_unknown_check', 'Granskningen hänvisar till en kontrollpunkt utanför testfallet.');
      for (const check of coverage.checks) {
        const findings = review.findings.filter(finding => finding.requirementId === check.id);
        if (findings.length !== 1 || findings[0]!.verdict !== 'supported' || !findings[0]!.evidenceIds.length) add('review_check_unresolved', 'Kontrollpunktens observation saknar en entydig underbyggd granskning.', check.id);
      }
    }
  }
  if (source && (source.schemaVersion !== 2 || source.status !== 'completed')) add('source_incomplete', 'Den bundna testkällan är inte ett aktuellt avslutat resultat.');
  return gaps;
}

/** Structural deliveries, not a dispatch decision or a product approval. */
export function missionDelivery(items: WorkspaceItem[], runs: TestRun[], config: MissionConfig, tasks: MissionTaskView[]): DeliveryProjection {
  const selected = new Set(config.caseKeys);
  const plans = items.filter(item => item.content.kind === 'test_plan').map(item => item.content.kind === 'test_plan'
    ? { ...item, content: { ...item.content, cases: item.content.cases.filter(test => selected.has(`${item.id}:${test.id}`)) } } : item);
  const settings = defaultQuality().config;
  if (config.target) settings.target = config.target;
  const historical = new Set(regressionHistoryRefs(config).map(ref => ref.id));
  const quality = qualitySummary(plans, runs.filter(run => selected.has(`${run.itemId}:${run.caseId}`) && !historical.has(run.id)), settings);
  const attached = tasks.flatMap(task => task.sources.map(source => ({ task, source })));
  const cases = [...selected].map((caseKey): CaseDelivery => {
    const row = quality.cases.find(test => test.key === caseKey);
    const run = row?.run;
    const bound = run && attached.find(entry => entry.source.sourceType === 'test' && entry.source.sourceId === run.id);
    const refs = { caseKey, ...(bound ? { taskId: bound.task.id, sourceType: 'test' as const, sourceId: bound.source.sourceId } : run ? { sourceType: 'test' as const, sourceId: run.id } : {}) };
    const gaps: DeliveryGap[] = [];
    const add = (code: string, message: string, requirementId?: string) => gaps.push({ code, message, ...refs, ...(requirementId ? { requirementId } : {}) });
    if (!config.criteria.some(criterion => criterion.delivery?.kind === 'test_cases' && criterion.delivery.caseKeys.includes(caseKey))) add('case_unmapped', 'Det valda testfallet saknar uttrycklig koppling till ett leveranskriterium.');
    if (!row) add('case_missing', 'Det valda testfallet saknas i aktuellt Material.');
    else if (!run) add(row.status === 'stale' ? 'run_stale' : 'run_missing', row.status === 'stale' ? 'Ingen sparad körning motsvarar aktuellt testfall och testobjekt.' : 'Det valda testfallet saknar en sparad körning.');
    if (!hasTargetIdentity(config.target)) add('target_unknown', 'Leveransen saknar en bestämd testmiljö och version eller observationsscope.');
    if (run) {
      gaps.push(...runDeliveryGaps(run, bound?.source, config.target).map(gap => ({ ...gap, ...refs })));
      if (items.find(item => item.id === run.itemId)?.version !== run.planVersion) add('run_stale', 'Testkörningen avser inte den aktuella testplansversionen. Originalet visas som historiskt underlag.');
    }
    return { caseKey, runId: run?.id ?? null, complete: !gaps.length, gaps };
  });
  const criteria = config.criteria.map(criterion => {
    const relevant = attached.filter(entry => entry.task.criterionIds.includes(criterion.id));
    const gaps: DeliveryGap[] = [];
    if (!criterion.delivery) gaps.push({ code: 'expectation_unknown', message: 'Kriteriet saknar en uttrycklig leveransförväntan.', criterionId: criterion.id });
    else if (criterion.delivery.kind === 'test_cases') {
      if (criterion.delivery.caseKeys.length > MAX_CRITERION_DELIVERIES) gaps.push({ code: 'criterion_too_large', message: `Dela kriteriet i mindre leveranser med högst ${MAX_CRITERION_DELIVERIES} testfall så varje körning kan styrkas i rapporten.`, criterionId: criterion.id });
      for (const caseKey of criterion.delivery.caseKeys) {
        const delivery = cases.find(test => test.caseKey === caseKey);
        if (!delivery) gaps.push({ code: 'case_not_selected', message: 'Kriteriets testfall ingår inte i uppdragets urval.', criterionId: criterion.id, caseKey });
        else {
          gaps.push(...delivery.gaps.map(gap => ({ ...gap, criterionId: criterion.id })));
          if (delivery.runId && !relevant.some(entry => entry.source.sourceType === 'test' && entry.source.sourceId === delivery.runId)) gaps.push({ code: 'criterion_source_missing', message: 'Testkörningen är inte kopplad till en deluppgift för detta kriterium.', criterionId: criterion.id, caseKey, sourceType: 'test', sourceId: delivery.runId });
        }
      }
    } else if (criterion.delivery.kind === 'regression_comparison') {
      const expected = criterion.delivery, baseline = expected.baseline;
      const add = (code: string, message: string) => gaps.push({ code, message, criterionId: criterion.id, caseKey: expected.caseKey });
      const current = cases.find(test => test.caseKey === expected.caseKey);
      if (!current?.complete) add('comparison_current_incomplete', 'Den nya körningens QA är inte fullständig; historiken ersätter inte dess bevis.');
      if (!baseline) add('baseline_missing', 'Ingen avslutad tidigare körning fanns i det frysta urvalet. Den nya körningen genomförs ändå.');
      else {
        const run = runs.find(run => run.id === baseline.runId), source = relevant.find(entry => entry.source.sourceType === 'test' && entry.source.sourceId === baseline.runId)?.source;
        const definition = items.find(item => item.id === expected.caseKey.split(':')[0])?.content;
        const test = definition?.kind === 'test_plan' ? definition.cases.find(test => test.id === expected.caseKey.split(':')[1]) : undefined;
        if (!run || !source) add('baseline_missing', 'Den exakt valda tidigare körningen saknas i rapportunderlaget.');
        else {
          if (!matchesRegressionBaseline(baseline, source) || run.planVersion !== baseline.planVersion
            || run.startedAt !== baseline.startedAt || run.finishedAt !== baseline.finishedAt
            || !run.target || !baseline.target || !sameTarget(run.target, baseline.target)
            || !sameCase(run.snapshot, baseline.snapshot) || !sameRegressionRequirement(run.snapshot, baseline.snapshot)) add('baseline_changed', 'Den frysta tidigare körningens identitet eller underlag har ändrats. Inget ersättningsresultat väljs.');
          gaps.push(...runDeliveryGaps(run, source, baseline.target).map(gap => ({ ...gap, criterionId: criterion.id, caseKey: expected.caseKey, sourceType: 'test' as const, sourceId: run.id })));
        }
        if (!test || !sameRegressionRequirement(test, baseline.snapshot)) add('comparison_definition_changed', 'Krav, steg eller förutsättningar skiljer sig mellan körningarna; utfallen kan inte jämföras som samma kontroll.');
        if (current?.runId === baseline.runId) add('comparison_current_missing', 'En ny separat körning krävs för jämförelsen.');
        if (current?.runId && !relevant.some(entry => entry.source.sourceType === 'test' && entry.source.sourceId === current.runId)) add('criterion_source_missing', 'Den nya körningen är inte kopplad till jämförelsekriteriet.');
      }
    } else {
      const refs = criterion.delivery.sourceRefs ?? [];
      const expectedSources = [...refs, ...criterion.delivery.sourceTypes.filter(type => !refs.some(ref => ref.type === type)).map(type => ({ type, id: null }))];
      for (const { type: sourceType, id: sourceId } of expectedSources) {
        const candidates = relevant.filter(entry => entry.source.sourceType === sourceType && (!sourceId || entry.source.sourceId === sourceId));
        const contextIssues = (source: WorkResult) => evidenceContextIssues({ schemaVersion: source.schemaVersion, sourceType, sourceId: source.sourceId, target: source.target, expectedTarget: config.target, startedAt: source.startedAt, finishedAt: source.finishedAt });
        const ready = candidates.some(({ source }) => !contextIssues(source).length && ['completed', 'failed'].includes(source.status) && source.evidence.some(evidence => !evidence.unavailable));
        if (!candidates.length) gaps.push({ code: 'source_missing', message: 'Kriteriet saknar en begärd källleverans.', criterionId: criterion.id, sourceType, ...(sourceId ? { sourceId } : {}) });
        if (!ready) for (const { source, task } of candidates) {
          const refs = { criterionId: criterion.id, sourceType, sourceId: source.sourceId, taskId: task.id };
          // Context validity is not physical availability. Preserve each actual
          // reason without calling a readable file absent or an ended run live.
          if (!['completed', 'failed'].includes(source.status)) gaps.push({ code: 'source_incomplete', message: 'Den begärda källan saknar ett avslutat resultat.', ...refs });
          if (!source.evidence.length) gaps.push({ code: 'evidence_missing', message: 'Källan saknar registrerat underlag.', ...refs });
          else if (source.evidence.every(evidence => evidence.unavailable)) gaps.push({ code: 'evidence_unavailable', message: 'Samtliga registrerade underlag för källan är markerade som otillgängliga.', ...refs });
          for (const issue of contextIssues(source)) gaps.push({ ...issue, ...refs });
        }
        if (sourceType === 'test') for (const { source, task } of candidates) {
          // Reading a saved run is not evidence that its QA is complete. Use
          // exactly that run, even if another run of the same case exists.
          const run = runs.find(run => run.id === source.sourceId);
          const refs = { criterionId: criterion.id, sourceType, sourceId: source.sourceId, taskId: task.id };
          if (!run) { gaps.push({ code: 'run_missing', message: 'Den valda testkörningen saknas i rapportunderlaget.', ...refs }); continue; }
          gaps.push(...runDeliveryGaps(run, source, config.target ?? source.target).map(gap => ({ ...gap, ...refs })));
          const item = items.find(item => item.id === run.itemId);
          const definition = item?.content.kind === 'test_plan' ? item.content.cases.find(test => test.id === run.caseId) : null;
          if (!definition || item!.version !== run.planVersion || !sameCase(definition, run.snapshot)) gaps.push({ code: 'run_stale', message: 'Den valda körningen avser inte den aktuella testplansversionen. Originalet visas som historiskt underlag.', ...refs });
        }
      }
    }
    return { criterionId: criterion.id, complete: !gaps.length, gaps };
  });
  const gaps = [...criteria.flatMap(criterion => criterion.gaps), ...cases.filter(test => !config.criteria.some(criterion => criterion.delivery?.kind === 'test_cases' && criterion.delivery.caseKeys.includes(test.caseKey))).flatMap(test => test.gaps)];
  return { schemaVersion: DELIVERY_POLICY_VERSION, complete: !gaps.length, criteria, cases, gaps };
}
