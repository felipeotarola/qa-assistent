import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, schema } from "@nuxthub/db";
import { ownedItem } from "./workspaces";
import { destinations, externalOperation } from "./external";
import { renderTestPlan, planSection, updatePlanSection } from "../../shared/test-plan";
import type { ExternalIssue } from "../../shared/external";

export async function testPlanPublication(userId: string, workspaceId: string, itemId: string) {
  const item = await ownedItem(userId, workspaceId, itemId);
  if (item.content.kind !== "test_plan") throw createError({ statusCode: 400, statusMessage: "Choose a test plan" });
  const destination = (await destinations(userId, workspaceId)).find(d => d.provider === "linear");
  const receipts = await db.select({ id: schema.externalOperations.id, action: schema.externalOperations.action, version: schema.workspaceEvidence.itemVersion, issue: schema.externalOperations.result, destination: schema.externalOperations.destination })
    .from(schema.workspaceEvidence).innerJoin(schema.externalOperations, sql`${schema.workspaceEvidence.id} = ${schema.externalOperations.id} || ':' || ${itemId}`)
    .where(and(eq(schema.workspaceEvidence.itemId, itemId), eq(schema.externalOperations.provider, "linear"), eq(schema.externalOperations.state, "complete"), inArray(schema.externalOperations.action, ["create", "update"])))
    .orderBy(desc(schema.workspaceEvidence.createdAt));
  const published = receipts.find(r => {
    if (!r.issue || r.destination.targetId !== destination?.targetId || r.destination.projectId !== destination?.projectId) return false;
    const target = JSON.stringify([r.destination.targetId, r.destination.projectId ?? null]);
    const key = `test-plan:${itemId}:${target}:${r.action === 'create' ? 'create' : `update:${r.issue.id}:${r.version}`}`;
    return r.id === createHash('sha256').update(`${userId}:${workspaceId}:${key}`).digest('hex');
  });
  return { destination: destination ?? null, published: published?.issue ? { version: published.version, issue: published.issue } : null, currentVersion: item.version };
}

export async function publishTestPlan(userId: string, workspaceId: string, itemId: string, expectedVersion: number, threadId?: string) {
  // Serialize publishing this plan, including the provider write, so double
  // clicks and simultaneous chats resolve to the same confirmed issue.
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`publish-test-plan:${workspaceId}:${itemId}`}, 0))`);
    const item = await ownedItem(userId, workspaceId, itemId);
    if (item.content.kind !== "test_plan") throw createError({ statusCode: 400, statusMessage: "Choose a test plan" });
    if (item.version !== expectedVersion) throw createError({ statusCode: 409, statusMessage: "Plan changed. Read it again before publishing." });
    if (!item.content.cases.length) throw createError({ statusCode: 400, statusMessage: "Add test cases before publishing" });
    const { destination, published } = await testPlanPublication(userId, workspaceId, itemId);
    if (!destination) throw createError({ statusCode: 400, statusMessage: "Välj Linear-destination under Workspace → Kopplingar först." });
    if (published?.version === item.version) return { saved: true, issue: published.issue, version: item.version, replayed: true };
    const markdown = renderTestPlan(item.title, item.content, item.version);
    if (markdown.length > 45000) throw createError({ statusCode: 400, statusMessage: "Planen är för stor för ett Linear-ärende. Dela upp den i mindre planer." });
    let body = planSection(itemId, markdown);
    if (published) {
      const current = await externalOperation(userId, workspaceId, "read", { action: "read", provider: "linear", issueId: published.issue.id }) as { issue: ExternalIssue };
      try { body = updatePlanSection(current.issue.body, itemId, markdown); }
      catch { throw createError({ statusCode: 409, statusMessage: "Testplanens avsnitt har ändrats i Linear. Kontrollera ärendet innan du uppdaterar." }); }
    }
    const target = JSON.stringify([destination.targetId, destination.projectId ?? null]);
    // The create key deliberately excludes the version: an uncertain creation
    // cannot be bypassed by editing the local plan and creating another issue.
    const key = published ? `test-plan:${itemId}:${target}:update:${published.issue.id}:${item.version}` : `test-plan:${itemId}:${target}:create`;
    const result = await externalOperation(userId, workspaceId, key, { action: published ? "update" : "create", provider: "linear", ...(published ? { issueId: published.issue.id } : { title: item.title }), body, evidenceItemIds: [itemId] }, threadId, { [itemId]: item.version });
    return { ...result, version: item.version };
  });
}
