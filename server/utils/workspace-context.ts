import { and, eq, isNull, desc, sql } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import { getThreadForUser } from "./threads";
import { requireWorkspace } from "./workspaces";
import { runtimeScope } from '../../shared/runtime-scope';
import { testRunReportSource } from '../../shared/report-selection';

/** Bounded discovery metadata, never credentials or entire private documents. */
export async function workspaceContext(userId: string, threadId: string) {
  const thread = await getThreadForUser(userId, threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: "Workspace not found" });
  const workspace = await requireWorkspace(userId, thread.workspaceId);
  const [items, destinations, operations, browsers, runs] = await Promise.all([
    db.select({ id: schema.workspaceItems.id, title: schema.workspaceItems.title, kind: sql<string>`${schema.workspaceItems.content}->>'kind'`, version: schema.workspaceItems.version, updatedAt: schema.workspaceItems.updatedAt }).from(schema.workspaceItems).where(and(eq(schema.workspaceItems.workspaceId, workspace.id), isNull(schema.workspaceItems.deletedAt))).orderBy(desc(schema.workspaceItems.updatedAt), desc(schema.workspaceItems.id)).limit(26),
    db.select({ destination: schema.workspaceDestinations.destination }).from(schema.workspaceDestinations).where(eq(schema.workspaceDestinations.workspaceId, workspace.id)),
    db.select({ id: schema.externalOperations.id, provider: schema.externalOperations.provider, action: schema.externalOperations.action, state: schema.externalOperations.state, result: schema.externalOperations.result, createdAt: schema.externalOperations.createdAt }).from(schema.externalOperations).where(eq(schema.externalOperations.workspaceId, workspace.id)).orderBy(desc(schema.externalOperations.createdAt)).limit(5),
    db.select({ url: schema.browserAssignments.url, title: schema.browserAssignments.title, control: schema.browserAssignments.control, expiresAt: schema.browserAssignments.expiresAt }).from(schema.browserAssignments).where(and(eq(schema.browserAssignments.workspaceId, workspace.id), eq(schema.browserAssignments.threadId, threadId), eq(schema.browserAssignments.agentId, 'main'), eq(schema.browserAssignments.userId, userId))),
    db.select({ id: schema.testRuns.id, itemId: schema.testRuns.itemId, caseId: schema.testRuns.caseId, planVersion: schema.testRuns.planVersion,
      // A frozen case label for identity selection, never the current plan's title or proof.
      snapshotTitle: sql<string | null>`case when jsonb_typeof(${schema.testRuns.snapshot}->'title') = 'string' and char_length(${schema.testRuns.snapshot}->>'title') between 1 and 300 then ${schema.testRuns.snapshot}->>'title' else null end`,
      reportedOutcome: sql<string | null>`${schema.testRuns.result}->>'outcome'`, startedAt: schema.testRuns.startedAt, finishedAt: schema.testRuns.finishedAt }).from(schema.testRuns)
      .where(and(eq(schema.testRuns.workspaceId, workspace.id), eq(schema.testRuns.runtime, runtimeScope())))
      .orderBy(desc(schema.testRuns.startedAt), desc(schema.testRuns.id)).limit(11),
  ]);
  const browser = browsers[0];
  let page: string | null = null;
  try { const url = new URL(browser?.url || ""); if (["http:", "https:"].includes(url.protocol)) page = `${url.origin}${url.pathname}`; } catch { /* No known page. */ }
  return {
    workspace: { id: workspace.id, name: workspace.name },
    thread: { id: thread.id, title: thread.title },
    items: items.slice(0, 25), itemsTruncated: items.length > 25,
    recentTestRuns: runs.slice(0, 10).map(run => ({ ...run, reportSource: testRunReportSource(run.id) })), testRunsTruncated: runs.length > 10,
    destinations: destinations.map(row => row.destination),
    recentOperations: operations.map(row => ({ id: row.id, provider: row.provider, action: row.action, state: row.state, createdAt: row.createdAt, result: row.result ? { id: row.result.id, title: row.result.title, url: row.result.url } : null })),
    browser: browser ? { lastKnownPage: page, title: browser.title, control: browser.control, active: !!browser.expiresAt && browser.expiresAt > new Date() } : null,
  };
}
