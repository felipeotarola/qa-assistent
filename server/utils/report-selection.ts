import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '@nuxthub/db';
import { runtimeScope } from '../../shared/runtime-scope';
import { reportSelectionDiagnosticSchema, testRunReportSource } from '../../shared/report-selection';
import type { MissionAdmission, MissionIntakeAdmission } from '../../shared/mission-control';
import type { WorkspaceDatabase } from './workspaces';

/** Called only for a new authenticated report admission under workspace-content
 * lock. Never chooses a run, parses a goal, expands a plan or mutates a row.
 * Resume consumes the previously frozen canonical admission instead. */
export async function resolveReportSelection(connection: WorkspaceDatabase, workspaceId: string, refs: MissionIntakeAdmission['sourceRefs']): Promise<MissionAdmission['sourceRefs']> {
  const itemRefs = refs.filter(ref => ['material', 'research', 'plan_definition'].includes(ref.type));
  const items = itemRefs.length ? await connection.select().from(schema.workspaceItems).where(and(
    eq(schema.workspaceItems.workspaceId, workspaceId), inArray(schema.workspaceItems.id, itemRefs.map(ref => ref.id)), isNull(schema.workspaceItems.deletedAt),
  )) : [];
  for (const ref of itemRefs) {
    const item = items.find(item => item.id === ref.id);
    if (!item || !Number.isSafeInteger(item.version) || item.version < 1) throw createError({ statusCode: 404, statusMessage: 'Den valda källan är inte tillgänglig i arbetsytan.' });
    if (ref.type === 'plan_definition' && item.content.kind !== 'test_plan') throw createError({ statusCode: 400, statusMessage: 'plan_definition kräver en befintlig testplansdefinition.' });
  }
  const rejected = itemRefs.flatMap(ref => {
    const item = items.find(item => item.id === ref.id)!;
    return ref.type !== 'plan_definition' && item.content.kind === 'test_plan' ? [{ type: ref.type as 'material' | 'research', id: ref.id, planVersion: item.version }] : [];
  });
  if (rejected.length) {
    // Suggestions are exact completed runs from this workspace/runtime and the
    // current saved plan version. The model still selects only the user's runs.
    const runs = await connection.select({ id: schema.testRuns.id, itemId: schema.testRuns.itemId, caseId: schema.testRuns.caseId,
      planVersion: schema.testRuns.planVersion, snapshot: schema.testRuns.snapshot }).from(schema.testRuns)
      .innerJoin(schema.workspaceItems, and(eq(schema.workspaceItems.id, schema.testRuns.itemId), eq(schema.workspaceItems.workspaceId, schema.testRuns.workspaceId)))
      .where(and(eq(schema.testRuns.workspaceId, workspaceId), eq(schema.testRuns.runtime, runtimeScope()),
        inArray(schema.testRuns.itemId, rejected.map(ref => ref.id)), eq(schema.testRuns.planVersion, schema.workspaceItems.version),
        isNull(schema.workspaceItems.deletedAt), sql`${schema.testRuns.finishedAt} is not null and ${schema.testRuns.result} is not null`))
      .orderBy(desc(schema.testRuns.finishedAt), desc(schema.testRuns.id)).limit(11);
    const suggestions = runs.filter(run => {
      const plan = items.find(item => item.id === run.itemId);
      return plan?.content.kind === 'test_plan' && run.snapshot.id === run.caseId && plan.content.cases.some(test => test.id === run.caseId);
    }).slice(0, 10).map(run => ({ reportSource: testRunReportSource(run.id), itemId: run.itemId, caseId: run.caseId, planVersion: run.planVersion }));
    const diagnostic = reportSelectionDiagnosticSchema.parse({ code: 'REPORT_SOURCE_KIND_MISMATCH',
      message: 'Urvalet innehåller testplansdefinitioner som material/research, inte sparade testresultat. Inget uppdrag skapades. Välj exakta testkörningars reportSource eller uttryckligen valda caseKeys; föreslagna körningar är bara ett begränsat index. Använd plan_definition endast om användaren uttryckligen valde själva definitionen.',
      rejected, suggestions, suggestionsTruncated: runs.length > 10 });
    throw createError({ statusCode: 400, statusMessage: 'Report source kind mismatch', data: diagnostic });
  }
  return refs.map(ref => ref.type === 'plan_definition' ? { type: 'material', id: ref.id } : ref);
}
