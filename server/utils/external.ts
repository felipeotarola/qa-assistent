import { createHash } from "node:crypto";
import { and, eq, desc, sql, inArray } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import type { Destination, ExternalProvider, ExternalInput } from "../../shared/external";
import { getConnector } from "../connectors";
import { mintUserToken } from "./connect";
import { requireWorkspace, ownedItem } from "./workspaces";
import { githubAdapter, openLinearAdapter, ExternalServiceError } from "./external-providers";
import { finishExternalWrite, replayExternalReceipt, ReceiptConflict } from "./external-receipts";
import { confirmedEvidence } from "./confirmed-evidence";

export async function externalAdapter(provider: ExternalProvider, userId: string) {
  let token: string;
  try { token = await mintUserToken(getConnector(provider), userId); }
  catch { throw createError({ statusCode: 424, statusMessage: `Connect your ${provider} account in Settings > Integrations first. The provider may require administrator setup.` }); }
  return provider === "github" ? githubAdapter(token) : openLinearAdapter(token);
}
export async function destinations(userId: string, workspaceId: string) {
  await requireWorkspace(userId, workspaceId);
  return (await db.select().from(schema.workspaceDestinations).where(eq(schema.workspaceDestinations.workspaceId, workspaceId))).map(r => r.destination);
}
export async function saveDestination(userId: string, workspaceId: string, input: Omit<Destination, "label">) {
  await requireWorkspace(userId, workspaceId);
  const adapter = await externalAdapter(input.provider, userId);
  try {
    const destination = await adapter.validate(input.targetId, input.projectId);
    await db.insert(schema.workspaceDestinations).values({ workspaceId, provider: input.provider, destination }).onConflictDoUpdate({ target: [schema.workspaceDestinations.workspaceId, schema.workspaceDestinations.provider], set: { destination } });
    return destination;
  }
  finally { await adapter.close().catch(() => undefined); }
}
export async function removeDestination(userId: string, workspaceId: string, provider: ExternalProvider) {
  await requireWorkspace(userId, workspaceId);
  await db.delete(schema.workspaceDestinations).where(and(eq(schema.workspaceDestinations.workspaceId, workspaceId), eq(schema.workspaceDestinations.provider, provider)));
}
export async function operationHistory(userId: string, workspaceId: string) {
  await requireWorkspace(userId, workspaceId);
  return db.select({ id: schema.externalOperations.id, provider: schema.externalOperations.provider, action: schema.externalOperations.action, state: schema.externalOperations.state, destination: schema.externalOperations.destination, result: schema.externalOperations.result, createdAt: schema.externalOperations.createdAt }).from(schema.externalOperations).where(eq(schema.externalOperations.workspaceId, workspaceId)).orderBy(desc(schema.externalOperations.createdAt)).limit(30);
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export async function externalOperation(userId: string, workspaceId: string, callKey: string, input: ExternalInput, threadId?: string) {
  const targets = await destinations(userId, workspaceId);
  if (input.action === "destinations") return { destinations: targets };
  if (input.action === "history") return { operations: await operationHistory(userId, workspaceId) };
  const target = targets.find(d => d.provider === input.provider);
  if (!target) throw createError({ statusCode: 400, statusMessage: "Choose a provider and configure its destination in this workspace first. Do not guess a destination." });
  const writing = ["create", "update", "comment"].includes(input.action);
  const evidenceItems = writing ? await Promise.all([...new Set(input.evidenceItemIds ?? [])].map(id => ownedItem(userId, workspaceId, id))) : [];
  if (["read", "update", "comment"].includes(input.action) && !input.issueId) throw createError({ statusCode: 400, statusMessage: "issueId required" });
  if (input.action === "create" && !input.title) throw createError({ statusCode: 400, statusMessage: "title required" });
  if (input.action === "comment" && !input.body?.trim()) throw createError({ statusCode: 400, statusMessage: "comment body required" });
  if (input.action === "update" && input.title === undefined && input.body === undefined) throw createError({ statusCode: 400, statusMessage: "title or body required" });
  const id = hash(`${userId}:${workspaceId}:${callKey}`);
  const fingerprint = hash(JSON.stringify([target, input.action, input.issueId ?? null, input.title ?? null, input.body ?? null]));
  const adapter = await externalAdapter(target.provider, userId);
  try {
    if (!writing) return input.action === "list" ? await adapter.list(target, input.cursor) : { issue: await adapter.read(target, input.issueId!) };
    // Validate access before reserving a mutation, so a missing grant or an
    // out-of-scope issue doesn't leave an ambiguous receipt.
    await adapter.validate(target.targetId, target.projectId);
    if (input.action !== "create") await adapter.read(target, input.issueId!);
    const cached = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`external:${workspaceId}`}, 0))`);
      const [existing] = await tx.select().from(schema.externalOperations).where(eq(schema.externalOperations.id, id));
      if (existing) {
        return replayExternalReceipt(existing, fingerprint);
      }
      const [uncertain] = await tx.select().from(schema.externalOperations).where(and(eq(schema.externalOperations.workspaceId, workspaceId), eq(schema.externalOperations.fingerprint, fingerprint), inArray(schema.externalOperations.state, ["pending", "unknown"])));
      if (uncertain) throw createError({ statusCode: 409, statusMessage: "An identical write has an uncertain outcome. Check the external system before continuing." });
      await tx.insert(schema.externalOperations).values({ id, workspaceId, provider: target.provider, action: input.action, fingerprint, destination: target });
      return null;
    });
    if (cached) return { saved: true, destination: target, issue: cached, replayed: true };
    const result = await finishExternalWrite(() => adapter.write(target, input), async (state, result) => {
      await db.transaction(async tx => {
        await tx.update(schema.externalOperations).set({ state, ...(result ? { result } : {}) }).where(eq(schema.externalOperations.id, id));
        const links = confirmedEvidence(state, result, evidenceItems, { operationId: id, workspaceId, provider: target.provider, threadId });
        if (links.length) await tx.insert(schema.workspaceEvidence).values(links).onConflictDoNothing();
      });
    });
    return { saved: true, destination: target, issue: result };
  }
  catch (error) {
    if (error instanceof ReceiptConflict) throw createError({ statusCode: 409, statusMessage: error.message });
    if (error instanceof ExternalServiceError) throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    throw error;
  }
  finally { await adapter.close().catch(() => undefined); }
}
