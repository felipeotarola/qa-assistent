import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { randomUUID } from 'node:crypto';
import { requireWorkspace } from './workspaces';
import { openEnvironment, sealEnvironment } from './environment-crypto';
import { environmentValuesSchema, vaultEntrySchema, type VaultEntry } from '../../shared/project-environment';

export const environmentVaultScope = (workspaceId: string, repo: string) => `${workspaceId}:${repo}:test`;

export async function listVaultEntries(userId: string, workspaceId: string): Promise<VaultEntry[]> {
  await requireWorkspace(userId, workspaceId);
  const rows = await db.select().from(schema.projectEnvironments).where(and(eq(schema.projectEnvironments.workspaceId, workspaceId), eq(schema.projectEnvironments.environment, 'test')));
  return rows.map(row => ({ repoUrl: row.repoUrl, revision: row.revision, configuredNames: Object.keys(openEnvironment(row.sealedValues, environmentVaultScope(workspaceId, row.repoUrl))) }));
}

export async function saveVaultEntry(userId: string, workspaceId: string, input: unknown) {
  const parsed = vaultEntrySchema.safeParse(input);
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Kontrollera repo-adress, variabelnamn och värden. Inget har sparats.' });
  await requireWorkspace(userId, workspaceId);
  const { repoUrl, expectedRevision, values, forget } = parsed.data;
  const scope = environmentVaultScope(workspaceId, repoUrl);
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${scope},0))`);
    const [existing] = await tx.select().from(schema.projectEnvironments).where(and(eq(schema.projectEnvironments.workspaceId, workspaceId), eq(schema.projectEnvironments.repoUrl, repoUrl), eq(schema.projectEnvironments.environment, 'test')));
    if ((existing?.revision || 0) !== expectedRevision) throw createError({ statusCode: 409, statusMessage: 'Vaulten har ändrats. Stäng och öppna den igen innan du sparar.' });
    const merged = Object.fromEntries(Object.entries({ ...(existing ? openEnvironment(existing.sealedValues, scope) : {}), ...values }).filter(([name]) => !forget.includes(name)));
    if (!environmentValuesSchema.safeParse(merged).success) throw createError({ statusCode: 400, statusMessage: 'Högst 30 variabler kan sparas per repo.' });
    const record = { sealedValues: sealEnvironment(merged, scope), revision: expectedRevision + 1, updatedAt: new Date() };
    if (existing) await tx.update(schema.projectEnvironments).set(record).where(eq(schema.projectEnvironments.id, existing.id));
    else await tx.insert(schema.projectEnvironments).values({ id: randomUUID(), workspaceId, repoUrl, ...record });
    // Values never leave the server again, including in the save response.
    return { repoUrl, revision: record.revision, configuredNames: Object.keys(merged) };
  });
}
