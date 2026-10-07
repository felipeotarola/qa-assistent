import { regressionHistoryRefs } from './mission-regression.ts';
import { defaultQuality, qualityLabels, qualitySummary, sameTarget, sameCase } from './quality.ts';
import type { WorkspaceItem } from './workspace.ts';
import type { TestRun, TestTarget } from './test-run.ts';
import { effectiveRunOutcome } from './test-run.ts';
import type { MissionConfig, MissionSnapshot, MissionTaskView } from './mission.ts';
import { missionDelivery } from './mission-delivery.ts';
import { targetVersionLabel } from './test-target.ts';

function targetLabel(target: TestTarget | null) {
  return target ? [target.environment || 'Okänd miljö', target.url, targetVersionLabel(target)].filter(Boolean).join(' · ') : 'Okänd miljö och version';
}

/** Explicit report inputs retain every selected run, not a recomputed latest run. */
function savedRunMetrics(items: WorkspaceItem[], runs: TestRun[], config: MissionConfig, tasks: MissionTaskView[], excluded: Set<string>) {
  const ids = new Set(config.criteria.flatMap(criterion => criterion.delivery?.kind === 'source'
    ? (criterion.delivery.sourceRefs ?? []).filter(ref => ref.type === 'test').map(ref => ref.id) : []));
  const tests: MissionSnapshot['tests'] = [];
  for (const id of ids) {
    if (excluded.has(id)) continue;
    const run = runs.find(run => run.id === id);
    if (!run) { tests.push({ key: `source:${id}`, runId: null, title: 'Vald testkörning saknas', status: 'untested', review: 'unreviewed', target: 'Okänd miljö och version', originalOutcome: null, manualReview: null }); continue; }
    const item = items.find(item => item.id === run.itemId);
    const definition = item?.content.kind === 'test_plan' ? item.content.cases.find(test => test.id === run.caseId) : null;
    const stale = !definition || item!.version !== run.planVersion || !sameCase(definition, run.snapshot);
    const review = tasks.flatMap(task => task.sources).find(source => source.sourceType === 'test' && source.sourceId === id)?.assessment;
    const manual = run.reviews?.[0];
    tests.push({ key: `source:${id}`, runId: id, title: run.snapshot.title, status: stale ? 'stale' : effectiveRunOutcome(run),
      review: review?.stale ? 'stale' : review?.verdict ?? 'unreviewed', target: targetLabel(run.target ?? null), originalOutcome: run.result?.outcome ?? null,
      manualReview: manual ? `${manual.authorName ?? 'Manuell granskare'} · ${manual.createdAt} · ${manual.reason}` : null });
  }
  const groups: { target: TestTarget | null; tests: MissionSnapshot['tests'] }[] = [];
  for (const test of tests) {
    const target = runs.find(run => run.id === test.runId)?.target ?? null;
    let group = groups.find(group => group.target && target ? sameTarget(group.target, target) : group.target === target);
    if (!group) { group = { target, tests: [] }; groups.push(group); }
    group.tests.push(test);
  }
  const metrics: MissionSnapshot['metrics'] = groups.map((group, index) => ({
    id: `saved-run-outcomes-${index}`, label: `Utfall för uttryckligen valda körningar · ${targetLabel(group.target)}`,
    data: Object.entries(qualityLabels).map(([key, label]) => ({ label, value: group.tests.filter(test => test.status === key).length })),
  }));
  return { tests, metrics };
}

/** A rerun counts as an attempt, never as an additional case. Targets remain separate. */
export function missionMetrics(items: WorkspaceItem[], runs: TestRun[], config: MissionConfig, tasks: MissionTaskView[]) {
  const delivery = missionDelivery(items, runs, config, tasks);
  const deliveryGaps = [...new Set(delivery.gaps.map(gap => `${config.criteria.find(criterion => criterion.id === gap.criterionId)?.text ?? gap.caseKey ?? 'Leverans'}: ${gap.message}`))];
  const selected = new Set(config.caseKeys);
  const plans = items.filter(i => i.content.kind === 'test_plan').map(i => i.content.kind === 'test_plan' ? { ...i, content: { ...i.content, cases: i.content.cases.filter(c => selected.has(`${i.id}:${c.id}`)) } } : i);
  const historical = new Set(regressionHistoryRefs(config).map(ref => ref.id));
  const attempts = runs.filter(r => selected.has(`${r.itemId}:${r.caseId}`) && !historical.has(r.id));
  const targets: (TestTarget | null)[] = config.target ? [config.target] : [];
  for (const run of attempts) if (!targets.some(t => t && run.target ? sameTarget(t, run.target) : t === (run.target ?? null))) targets.push(run.target ?? null);
  if (!targets.length) targets.push(null);
  const tests: MissionSnapshot['tests'] = [], metrics: MissionSnapshot['metrics'] = [];
  if (!selected.size) return { ...savedRunMetrics(items, runs, config, tasks, new Set()), delivery, gaps: deliveryGaps };
  for (const [index, target] of targets.entries()) {
    const label = targetLabel(target);
    const settings = defaultQuality().config;
    if (target) settings.target = target;
    const compatible = attempts.filter(r => target && r.target ? sameTarget(target, r.target) : !target && !r.target);
    const quality = qualitySummary(plans, compatible, settings);
    for (const c of quality.cases) {
      const review = tasks.flatMap(t => t.sources).find(s => s.sourceType === 'test' && s.sourceId === c.run?.id)?.assessment;
      const stalePlan = c.run && items.find(item => item.id === c.run!.itemId)?.version !== c.run.planVersion;
      tests.push({ key: `${index}:${c.key}`, title: c.title, status: stalePlan ? 'stale' : c.status, runId: c.run?.id ?? null, review: review?.stale ? 'stale' : review?.verdict ?? 'unreviewed', target: label,
        originalOutcome: c.run?.result?.outcome ?? null, manualReview: c.run?.reviews?.[0] ? `${c.run.reviews[0].authorName ?? 'Manuell granskare'} · ${c.run.reviews[0].createdAt} · ${c.run.reviews[0].reason}` : null });
    }
    for (const missing of [...selected].filter(key => !quality.cases.some(c => c.key === key))) tests.push({ key: `${index}:${missing}`, title: 'Valt testfall saknas i Material', status: 'untested', runId: null, review: 'unreviewed', target: label, originalOutcome: null, manualReview: null });
    const inGroup = tests.filter(t => t.key.startsWith(`${index}:`));
    metrics.push({ id: `test-outcomes-${index}`, label: `Senaste kompatibla utfall · ${label}`, data: Object.entries(qualityLabels).map(([key, name]) => ({ label: name, value: inGroup.filter(t => t.status === key).length })) });
  }
  metrics.push({ id: 'test-attempts', label: 'Urval och körningar (alla angivna testobjekt)', data: [{ label: 'Unika valda testfall', value: selected.size }, { label: 'Registrerade försök', value: attempts.length }] });
  const latestRuns = new Set(tests.map(test => test.runId));
  const earlierOutcomes = attempts.filter(run => run.finishedAt && run.result && run.result.outcome !== 'passed' && !latestRuns.has(run.id))
    .map(run => {
      const review = tasks.flatMap(task => task.sources).find(source => source.sourceType === 'test' && source.sourceId === run.id)?.assessment;
      return `Tidigare körning: ${run.snapshot.title} · ${run.id} · rapporterat utfall ${run.result!.outcome} · granskning ${review?.stale ? 'stale' : review?.verdict ?? 'unreviewed'}. Originalresultatet finns kvar; ett senare försök upphäver inte den tidigare observationen.`;
    });
  // Keep historical observations visible without counting them as new B QA.
  const historicalTests: MissionSnapshot['tests'] = [...historical].map(id => {
    const run = runs.find(run => run.id === id), source = tasks.flatMap(task => task.sources).find(source => source.sourceType === 'test' && source.sourceId === id);
    const manual = run?.reviews?.[0];
    return { key: 'historical:' + id, runId: run?.id ?? null, title: run ? 'Historiskt jämförelseunderlag · ' + run.snapshot.title + ' · planversion ' + run.planVersion : 'Historiskt jämförelseunderlag saknas',
      status: run ? effectiveRunOutcome(run) : 'untested', review: source?.assessment?.stale ? 'stale' : source?.assessment?.verdict ?? 'unreviewed',
      target: targetLabel(run?.target ?? null) + (run?.finishedAt ? ' · ' + run.finishedAt : ''), originalOutcome: run?.result?.outcome ?? null,
      manualReview: manual ? `${manual.authorName ?? 'Manuell granskare'} · ${manual.createdAt} · ${manual.reason}` : null };
  });
  const saved = savedRunMetrics(items, runs, config, tasks, new Set([...tests.flatMap(test => test.runId ? [test.runId] : []), ...historical]));
  return { tests: [...tests, ...saved.tests, ...historicalTests], metrics: [...metrics, ...saved.metrics], delivery, gaps: [...deliveryGaps, ...earlierOutcomes, ...(targets.some(t => !t?.revision || !t.environment) ? ['Resultat med okänd miljö eller version är en separat grupp, inte ett releasegodkännande.'] : []), ...(tests.some(t => t.title === 'Valt testfall saknas i Material') ? ['Ett eller flera valda testfall saknas i aktuellt Material.'] : [])] };
}
