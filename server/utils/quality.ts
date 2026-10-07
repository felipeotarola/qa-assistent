import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { requireWorkspace, listItems } from './workspaces';
import { listTestRuns } from './test-runs';
import { defaultQuality, qualityUpdateSchema, qualitySummary, sameTarget, caseKey } from '../../shared/quality';
import type { TestRun } from '../../shared/test-run';

export async function getQuality(userId: string, workspaceId: string) {
  await requireWorkspace(userId, workspaceId);
  const [row] = await db.select().from(schema.workspaceQuality).where(eq(schema.workspaceQuality.workspaceId, workspaceId));
  return row ? { revision: row.revision, config: row.config, updatedAt: row.updatedAt.toISOString() } : defaultQuality();
}
export async function saveQuality(userId: string, workspaceId: string, input: unknown) {
  const parsed = qualityUpdateSchema.safeParse(input);
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: parsed.error.issues.map(issue => issue.message).join('; ').slice(0, 500) });
  const value = parsed.data;
  if (value.config.target.scope) throw createError({ statusCode: 400, statusMessage: 'Observationsscope skapas av uppdraget. Ange en verklig releaseversion för gemensam testberedskap.' });
  await requireWorkspace(userId, workspaceId);
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`quality:${workspaceId}`}, 0))`);
    const [row] = await tx.select().from(schema.workspaceQuality).where(eq(schema.workspaceQuality.workspaceId, workspaceId));
    if ((row?.revision ?? 0) !== value.expectedRevision) throw createError({ statusCode: 409, statusMessage: 'Testberedskapen har ändrats. Läs om innan du sparar.' });
    const items = await tx.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.workspaceId, workspaceId), isNull(schema.workspaceItems.deletedAt)));
    const keys = new Set(items.flatMap(item => item.content.kind === 'test_plan' ? item.content.cases.map(c => caseKey(item.id, c.id)) : []));
    if ([...value.config.regression, ...value.config.checks.flatMap(c => c.caseKeys)].some(key => !keys.has(key))) throw createError({ statusCode: 400, statusMessage: 'Ett valt testfall finns inte längre i workspacet.' });
    const targetChanged = !sameTarget((row?.config ?? defaultQuality().config).target, value.config.target);
    // A check of another release/environment cannot prove readiness for this target.
    const config = { ...value.config, checks: targetChanged ? value.config.checks.map(check => ({ ...check, status: 'unknown' as const, detail: '' })) : value.config.checks };
    const [saved] = await tx.insert(schema.workspaceQuality).values({ workspaceId, revision: value.expectedRevision + 1, config }).onConflictDoUpdate({ target: schema.workspaceQuality.workspaceId, set: { revision: value.expectedRevision + 1, config, updatedAt: new Date() } }).returning();
    return { revision: saved!.revision, config: saved!.config, updatedAt: saved!.updatedAt.toISOString() };
  });
}
export async function readQualityReport(userId: string, workspaceId: string) {
  const [settings, items, rawRuns] = await Promise.all([getQuality(userId, workspaceId), listItems(userId, workspaceId), listTestRuns(userId, workspaceId)]);
  const runs = JSON.parse(JSON.stringify(rawRuns)) as TestRun[];
  const summary = qualitySummary(items, runs, settings.config);
  return { ...settings, ...summary, casesTruncated: summary.cases.length > 60, cases: summary.cases.slice(0, 60).map(({ run, previous, lastRecordedRun, ...value }) => ({ ...value, run: run ? { id: run.id, target: run.target, outcome: run.result?.outcome, actual: run.result?.actual.slice(0, 500), evidenceItemIds: run.result?.evidenceItemIds, planVersion: run.planVersion } : null, previous: previous ? { id: previous.id, target: previous.target, outcome: previous.result?.outcome } : null, lastRecordedRun: lastRecordedRun ? { id: lastRecordedRun.id, target: lastRecordedRun.target, outcome: lastRecordedRun.result?.outcome } : null })) };
}
