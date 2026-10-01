import { z } from 'zod';
import type { WorkspaceItem } from './workspace';
import { caseReady, type TestCase } from './test-plan.ts';
import { effectiveRunOutcome, type TestRun, testTargetSchema, type TestTarget } from './test-run.ts';

export type { TestTarget } from './test-run';
export const qualityConfigSchema = z.object({
  target: testTargetSchema,
  checks: z.array(z.object({
    id: z.string().uuid(), label: z.string().trim().min(1).max(200),
    status: z.enum(['unknown', 'ready', 'blocked']),
    detail: z.string().trim().max(1500),
    caseKeys: z.array(z.string().regex(/^[a-f0-9-]{36}:[a-f0-9-]{36}$/i)).max(500),
  }).refine(check => check.status === 'unknown' || !!check.detail, 'Beskriv hur förutsättningen kontrollerades eller vad som blockerar')).max(30),
  regression: z.array(z.string().regex(/^[a-f0-9-]{36}:[a-f0-9-]{36}$/i)).max(500),
}).refine(value => new Set(value.checks.map(c => c.id)).size === value.checks.length, 'Kontroller måste ha unika ID:n');
export type QualityConfig = z.infer<typeof qualityConfigSchema>;
export type QualitySettings = { revision: number; config: QualityConfig; updatedAt: string | null };
export const qualityUpdateSchema = z.object({ expectedRevision: z.number().int().nonnegative(), config: qualityConfigSchema });
export function defaultQuality(): QualitySettings {
  return { revision: 0, updatedAt: null, config: { target: { environment: '', url: '', revision: '' }, checks: [], regression: [] } };
}
export const caseKey = (itemId: string, caseId: string) => `${itemId}:${caseId}`;
export function sameTarget(a: TestTarget, b: TestTarget) {
  return a.environment === b.environment && a.url === b.url && a.revision === b.revision;
}
export function sameCase(a: TestCase, b: TestCase) {
  return ['id', 'title', 'type', 'preconditions', 'steps', 'expected'].every(key => a[key as keyof TestCase] === b[key as keyof TestCase]);
}
export const qualityLabels = { passed: 'Godkänt', failed: 'Underkänt', inconclusive: 'Oklart', blocked: 'Blockerat', interrupted: 'Avbrutet', running: 'Pågår', untested: 'Inte testat', stale: 'Behöver testas om' };
export type QualityStatus = keyof typeof qualityLabels;
export function qualitySummary(items: WorkspaceItem[], runs: TestRun[], config: QualityConfig) {
  const targetSet = !!(config.target.environment || config.target.url || config.target.revision);
  const targetComplete = !!(config.target.environment && config.target.revision);
  const runsByCase = new Map<string, TestRun[]>();
  for (const run of runs) {
    const key = caseKey(run.itemId, run.caseId);
    const group = runsByCase.get(key) ?? [];
    group.push(run); runsByCase.set(key, group);
  }
  const cases = items.flatMap(item => item.content.kind !== 'test_plan' ? [] : item.content.cases.map(test => {
    const key = caseKey(item.id, test.id);
    const history = (runsByCase.get(key) ?? []).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
    const applicable = history.filter(run => sameCase(run.snapshot, test) && (!targetSet || (!!run.target && sameTarget(run.target, config.target))));
    const latest = applicable[0];
    const status: QualityStatus = latest ? effectiveRunOutcome(latest) : history.length ? 'stale' : 'untested';
    const checks = config.checks.filter(check => !check.caseKeys.length || check.caseKeys.includes(key));
    const readiness = !caseReady(test) || checks.some(check => check.status === 'blocked') ? 'blocked' : !targetComplete || !checks.length || checks.some(check => check.status === 'unknown') ? 'unknown' : 'ready';
    const previous = latest?.result && latest.target?.environment && latest.target.revision
      ? history.find(run => run.id !== latest.id && run.startedAt < latest.startedAt && run.result && sameCase(run.snapshot, latest.snapshot) && run.target?.environment === latest.target!.environment && run.target?.url === latest.target!.url && !!run.target?.revision)
      : undefined;
    const before = previous ? effectiveRunOutcome(previous) : undefined;
    const change = !previous ? null : before === 'passed' && status === 'failed' ? 'regression' : before === 'failed' && status === 'passed' ? 'fixed' : 'unchanged';
    return { key, itemId: item.id, planTitle: item.title, caseId: test.id, title: test.title, status, readiness, checks, regression: config.regression.includes(key), run: latest ?? null, previous: previous ?? null, historyCount: history.length, lastRecordedRun: history[0] ?? null, change };
  }));
  const counts = Object.fromEntries(Object.keys(qualityLabels).map(key => [key, cases.filter(c => c.status === key).length])) as Record<QualityStatus, number>;
  return { total: cases.length, targetComplete, targetSet, counts, cases, ready: cases.filter(c => c.readiness === 'ready').length, prerequisitesBlocked: cases.filter(c => c.readiness === 'blocked').length, prerequisitesUnknown: cases.filter(c => c.readiness === 'unknown').length };
}
