import { and, desc, eq, sql } from 'drizzle-orm';
import { schema } from '@nuxthub/db';
import { runtimeScope } from '../../shared/runtime-scope';
import { regressionDeliverySchema } from '../../shared/mission-regression';
import type { MissionConfig } from '../../shared/mission';
import type { WorkspaceDatabase } from './workspaces';
import { readMissionSource } from './mission-sources';

/** Caller holds the workspace-content lock. Selection happens exactly once,
 * before B starts. Neither a replay nor resume can adopt a newer baseline.
 * Pick the latest finished run, not an older result that looks more favorable. */
export async function freezeMissionRegression(connection: WorkspaceDatabase, workspaceId: string, caseKeys: string[]) {
  const [clock] = await connection.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
  const capturedAt = new Date(clock!.now).toISOString();
  const criteria: MissionConfig['criteria'] = [], sources = [];
  for (const [index, caseKey] of caseKeys.entries()) {
    const [itemId, caseId] = caseKey.split(':');
    const [run] = await connection.select().from(schema.testRuns).where(and(
      eq(schema.testRuns.workspaceId, workspaceId), eq(schema.testRuns.runtime, runtimeScope()),
      eq(schema.testRuns.itemId, itemId!), eq(schema.testRuns.caseId, caseId!),
      sql`${schema.testRuns.finishedAt} is not null and ${schema.testRuns.finishedAt} <= ${capturedAt}::timestamptz`,
    )).orderBy(desc(schema.testRuns.finishedAt), desc(schema.testRuns.startedAt), desc(schema.testRuns.id)).limit(1);
    const source = run ? await readMissionSource(connection, workspaceId, 'test', run.id) : null;
    const delivery = regressionDeliverySchema.parse({ kind: 'regression_comparison', caseKey, capturedAt,
      baseline: run && source ? { runId: run.id, planVersion: run.planVersion, snapshot: run.snapshot, target: run.target,
        startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt!.toISOString(), sourceRevision: source.sourceRevision } : null });
    criteria.push({ id: `comparison-${index + 1}`, text: 'Jämför det valda testfallets nya observationer med den exakt sparade tidigare körningen. Redovisa skillnader och oförändrade utfall med respektive mål, tid och planversion. Historiskt underlag verifierar inte det nya testobjektet. Saknat eller oförenligt underlag ska vara en uttrycklig jämförelselucka.', delivery });
    if (source) sources.push(source);
  }
  return { criteria, sources };
}
