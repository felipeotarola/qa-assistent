import { z } from 'zod';
import { testCaseSchema, type TestCase } from './test-plan.ts';
import { testTargetSchema, sameTarget } from './test-target.ts';
import type { MissionConfig, MissionSnapshot, WorkResult } from './mission.ts';

/** Server-frozen historical selection. It is never an executor mandate and
 * never makes the earlier observations evidence of the current test target. */
export const regressionDeliverySchema = z.object({
  kind: z.literal('regression_comparison'),
  caseKey: z.string().regex(/^[a-f0-9-]{36}:[a-f0-9-]{36}$/i),
  capturedAt: z.iso.datetime(),
  baseline: z.object({
    runId: z.string().uuid(), planVersion: z.number().int().positive(),
    snapshot: testCaseSchema, target: testTargetSchema.nullable(),
    startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
    sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().nullable(),
}).strict().refine(value => !value.baseline || value.baseline.snapshot.id === value.caseKey.split(':')[1]
  && Date.parse(value.baseline.startedAt) <= Date.parse(value.baseline.finishedAt)
  && Date.parse(value.baseline.finishedAt) <= Date.parse(value.capturedAt), 'Invalid historical run binding');
export type RegressionDelivery = z.infer<typeof regressionDeliverySchema>;

const canonical = (value: unknown): string => JSON.stringify(value, (_key, node) => node && typeof node === 'object' && !Array.isArray(node)
  ? Object.fromEntries(Object.entries(node).sort(([a], [b]) => a.localeCompare(b))) : node);

/** Entry navigation and plan version locate the two executions. They do not
 * change a requirement. Everything else, including explicit/exploratory basis,
 * remains exact; no fuzzy matching or silent rewriting of the selected test. */
export function sameRegressionRequirement(a: TestCase, b: TestCase) {
  const definition = ({ entryUrl: _entryUrl, ...rest }: TestCase) => rest;
  return canonical(definition(a)) === canonical(definition(b));
}

export function regressionHistoryRefs(config: MissionConfig) {
  return [...new Set(config.criteria.flatMap(criterion => criterion.delivery?.kind === 'regression_comparison' && criterion.delivery.baseline
    ? [criterion.delivery.baseline.runId] : []))].map(id => ({ type: 'test' as const, id }));
}

export function matchesRegressionBaseline(baseline: NonNullable<RegressionDelivery['baseline']>, source: WorkResult) {
  return source.sourceType === 'test' && source.sourceId === baseline.runId && source.sourceRevision === baseline.sourceRevision
    && source.startedAt === baseline.startedAt && source.finishedAt === baseline.finishedAt
    && !!source.target && !!baseline.target && sameTarget(source.target, baseline.target);
}

/** A historical target exception exists ONLY inside its original comparison
 * criterion and for the exact immutable run/source identity. Unrelated sources
 * cannot borrow it. All provenance/read/digest checks still run afterwards. */
export function criterionEvidenceScope(snapshot: Pick<MissionSnapshot, 'config' | 'delivery'>, criterionId: string, source: WorkResult) {
  const delivery = snapshot.config.criteria.find(criterion => criterion.id === criterionId)?.delivery;
  // Current QA concerns its exact selected run, including a useful negative
  // observation in an incomplete run. No earlier run or another source may
  // replace it just because the target identity matches. Explicit source
  // criteria remain separate and may describe their own saved history.
  if (delivery?.kind === 'test_cases') {
    const allowed = source.sourceType === 'test' && delivery.caseKeys.some(key => snapshot.delivery?.cases.some(test => test.caseKey === key && test.runId === source.sourceId));
    return { allowed, target: snapshot.config.target, role: allowed ? 'current' as const : 'unbound' as const };
  }
  if (delivery?.kind !== 'regression_comparison') return { allowed: true, target: snapshot.config.target, role: 'current' as const };
  const baseline = delivery.baseline;
  if (source.sourceType !== 'test') return { allowed: false, target: snapshot.config.target, role: 'unbound' as const };
  if (baseline && source.sourceId === baseline.runId) {
    const valid = matchesRegressionBaseline(baseline, source);
    return { allowed: valid, target: baseline.target, role: 'historical' as const };
  }
  const current = snapshot.delivery?.cases.find(test => test.caseKey === delivery.caseKey)?.runId;
  return { allowed: !!current && current === source.sourceId && current !== baseline?.runId, target: snapshot.config.target, role: 'current' as const };
}
