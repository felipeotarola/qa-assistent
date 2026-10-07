import { and, eq } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { runtimeScope } from '../../shared/runtime-scope';
import { authorizeMissionOperation } from './mission-attempts';
import type { BrowserActor } from './browser-mission-guard';

type WorkspaceReadInput = { action: string; itemId?: string; version?: number };
/** Iris cannot author its own requirements or gather unrelated workspace data.
 * The immutable task snapshot, not model input, chooses which plans it may read. */
export async function irisWorkspaceRead(userId: string, workspaceId: string, threadId: string, agentId: string, input: WorkspaceReadInput, actor: BrowserActor) {
  if (!actor.browserJobId) return null;
  if (input.action !== 'read' && input.action !== 'list' && input.action !== 'evidence') throw createError({ statusCode: 403, statusMessage: 'Iris får bara läsa underlag. Resultat sparas genom testverktyget.' });
  const [job] = await db.select().from(schema.browserJobs).where(and(eq(schema.browserJobs.id, actor.browserJobId), eq(schema.browserJobs.threadId, threadId), eq(schema.browserJobs.runtime, runtimeScope())));
  if (!job || !actor.executorSessionId || job.sessionId !== actor.executorSessionId || agentId !== actor.executorSessionId || !['running', 'dispatch_unknown'].includes(job.status)) throw createError({ statusCode: 403, statusMessage: 'Materialanropet saknar rätt aktiva Iris-session.' });
  const [origin] = await db.select({ attempt: schema.missionAttempts, mission: schema.missions, task: schema.missionTasks }).from(schema.missionAttempts)
    .innerJoin(schema.missions, eq(schema.missionAttempts.missionId, schema.missions.id))
    .innerJoin(schema.missionTasks, eq(schema.missionAttempts.taskId, schema.missionTasks.id))
    .where(and(eq(schema.missionAttempts.dispatchId, job.id), eq(schema.missionAttempts.runtime, runtimeScope()), eq(schema.missions.runtime, runtimeScope()), eq(schema.missions.workspaceId, workspaceId), eq(schema.missions.userId, userId)));
  // Legacy jobs keep their existing read access, but never gain write access.
  if (!origin) return null;
  const { attempt, task } = origin;
  const spec = task.spec;
  if (!actor.callId || attempt.kind !== 'browser_tests' || spec?.kind !== 'browser_tests' || input.action !== 'read') throw createError({ statusCode: 403, statusMessage: 'Iris får bara läsa testplanen som valts för körförsöket.' });
  const selected = spec.planVersions?.find(plan => plan.itemId === input.itemId);
  if (!selected || input.version !== undefined && input.version !== selected.version) throw createError({ statusCode: 403, statusMessage: 'Testplanen eller versionen ingår inte i körförsöket.' });
  await authorizeMissionOperation({ userId, workspaceId, attemptId: attempt.id, dispatchId: attempt.dispatchId, callId: actor.callId, tool: 'workspace', input });
  const [snapshot] = await db.select({ id: schema.workspaceItems.id, title: schema.workspaceItemVersions.title, content: schema.workspaceItemVersions.content, version: schema.workspaceItemVersions.version })
    .from(schema.workspaceItemVersions).innerJoin(schema.workspaceItems, eq(schema.workspaceItemVersions.itemId, schema.workspaceItems.id))
    .where(and(eq(schema.workspaceItems.workspaceId, workspaceId), eq(schema.workspaceItemVersions.itemId, selected.itemId), eq(schema.workspaceItemVersions.version, selected.version)));
  if (!snapshot || snapshot.content.kind !== 'test_plan') throw createError({ statusCode: 409, statusMessage: 'Den frysta testplanen saknas.' });
  const cases = snapshot.content.cases.filter(test => spec.caseKeys.includes(`${snapshot.id}:${test.id}`));
  if (!cases.length) throw createError({ statusCode: 409, statusMessage: 'Körförsökets testurval saknas i den frysta planen.' });
  return { item: { ...snapshot, content: { ...snapshot.content, cases } }, historical: true, selectionOnly: true };
}
