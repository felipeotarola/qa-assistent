import { defaultQuality, qualityLabels, qualitySummary, sameTarget } from './quality.ts';
import type { WorkspaceItem } from './workspace.ts';
import type { TestRun, TestTarget } from './test-run.ts';
import type { MissionConfig, MissionSnapshot, MissionTaskView } from './mission.ts';

/** A rerun counts as an attempt, never as an additional case. Targets remain separate. */
export function missionMetrics(items: WorkspaceItem[], runs: TestRun[], config: MissionConfig, tasks: MissionTaskView[]) {
  const selected = new Set(config.caseKeys);
  const plans = items.filter(i => i.content.kind === 'test_plan').map(i => i.content.kind === 'test_plan' ? { ...i, content: { ...i.content, cases: i.content.cases.filter(c => selected.has(`${i.id}:${c.id}`)) } } : i);
  const attempts = runs.filter(r => selected.has(`${r.itemId}:${r.caseId}`));
  const targets: (TestTarget | null)[] = config.target ? [config.target] : [];
  for (const run of attempts) if (!targets.some(t => t && run.target ? sameTarget(t, run.target) : t === (run.target ?? null))) targets.push(run.target ?? null);
  if (!targets.length) targets.push(null);
  const tests: MissionSnapshot['tests'] = [], metrics: MissionSnapshot['metrics'] = [];
  if (!selected.size) return { tests, metrics, gaps: ['Inget testurval är angivet; inget totalt antal planerade tester beräknas.'] };
  for (const [index, target] of targets.entries()) {
    const label = target ? [target.environment || 'Okänd miljö', target.url, target.revision || 'Okänd version'].filter(Boolean).join(' · ') : 'Okänd miljö och version';
    const settings = defaultQuality().config;
    if (target) settings.target = target;
    const compatible = attempts.filter(r => target && r.target ? sameTarget(target, r.target) : !target && !r.target);
    const quality = qualitySummary(plans, compatible, settings);
    for (const c of quality.cases) {
      const review = tasks.flatMap(t => t.sources).find(s => s.sourceType === 'test' && s.sourceId === c.run?.id)?.assessment;
      tests.push({ key: `${index}:${c.key}`, title: c.title, status: c.status, runId: c.run?.id ?? null, review: review?.stale ? 'stale' : review?.verdict ?? 'unreviewed', target: label,
        originalOutcome: c.run?.result?.outcome ?? null, manualReview: c.run?.reviews?.[0] ? `${c.run.reviews[0].authorName ?? 'Manuell granskare'} · ${c.run.reviews[0].createdAt} · ${c.run.reviews[0].reason}` : null });
    }
    for (const missing of [...selected].filter(key => !quality.cases.some(c => c.key === key))) tests.push({ key: `${index}:${missing}`, title: 'Valt testfall saknas i Material', status: 'untested', runId: null, review: 'unreviewed', target: label, originalOutcome: null, manualReview: null });
    const inGroup = tests.filter(t => t.key.startsWith(`${index}:`));
    metrics.push({ id: `test-outcomes-${index}`, label: `Senaste kompatibla utfall · ${label}`, data: Object.entries(qualityLabels).map(([key, name]) => ({ label: name, value: inGroup.filter(t => t.status === key).length })) });
  }
  metrics.push({ id: 'test-attempts', label: 'Urval och körningar (alla angivna testobjekt)', data: [{ label: 'Unika valda testfall', value: selected.size }, { label: 'Registrerade försök', value: attempts.length }] });
  return { tests, metrics, gaps: [...(targets.some(t => !t?.revision || !t.environment) ? ['Resultat med okänd miljö eller version är en separat grupp, inte ett releasegodkännande.'] : []), ...(tests.some(t => t.title === 'Valt testfall saknas i Material') ? ['Ett eller flera valda testfall saknas i aktuellt Material.'] : [])] };
}
