import { createHash, randomUUID } from 'node:crypto';
import { and, eq, desc, sql } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { environmentPlanSchema } from '../../shared/project-environment';
import { authorizeEnvironmentConsentSchema, canonicalEnvironmentPlan, environmentPlanIdentity, grantEnvironmentConsentSchema, revokeEnvironmentConsentSchema, ENVIRONMENT_CONSENT_DEFAULT_MS, ENVIRONMENT_CONSENT_MAX_MS, type EnvironmentConsentAuthorization, type EnvironmentConsentPlan, type EnvironmentConsentStatus, type EnvironmentConsentView } from '../../shared/project-environment-consent';
import { runtimeScope } from '../../shared/runtime-scope';
import { requireWorkspace, type WorkspaceDatabase } from './workspaces';
import { environmentVaultScope } from './project-vault';
import { openEnvironment } from './environment-crypto';
import { sandboxScope } from './sandbox-scope';

type Consent = typeof schema.environmentConsents.$inferSelect;
export const environmentPlanHash = (plan: unknown) => createHash('sha256').update(canonicalEnvironmentPlan(plan)).digest('hex');
const invalid = (message: string) => createError({ statusCode: 409, statusMessage: message });
const missing = () => createError({ statusCode: 404, statusMessage: 'Medgivandet eller konfigurationsuppdraget saknas.' });
async function clock(reader: WorkspaceDatabase) {
  const [row] = await reader.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
  return new Date(row!.now);
}
async function verifiedPlan(reader: WorkspaceDatabase, userId: string, workspaceId: string, setupJobId: string, lock = false): Promise<EnvironmentConsentPlan | null> {
  const query = reader.select({ job: schema.setupJobs }).from(schema.setupJobs).innerJoin(schema.threads, eq(schema.threads.id, schema.setupJobs.threadId)).where(and(
    eq(schema.setupJobs.id, setupJobId), eq(schema.setupJobs.workspaceId, workspaceId), eq(schema.setupJobs.runtime, runtimeScope()), eq(schema.threads.userId, userId), eq(schema.threads.workspaceId, workspaceId),
  ));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw missing();
  const job = row.job, result = job.result;
  if (lock && !['needs_configuration', 'failed', 'completed'].includes(job.status)) throw invalid('Miljön är inte redo för ett medgivande eller en konfigurationsstart.');
  if (!result?.environment) return null;
  if (result.jobId !== job.id || result.workspaceId !== workspaceId || result.id !== sandboxScope(userId, job.threadId, job.sessionKey).id) throw invalid('Startplanens ägare kunde inte verifieras.');
  if (job.autonomy && (job.autonomy.environmentExecution.phase !== 'prepare' || result.executorStopped !== true || result.cleanup !== 'confirmed'
    || result.fingerprint !== job.autonomy.fingerprint || !['completed', 'needs_configuration'].includes(job.status))) throw invalid('Uppdragets förberedelse måste vara verifierad och städad innan medgivande kan ges.');
  const parsed = environmentPlanSchema.safeParse(result.environment);
  if (!parsed.success) throw invalid('En verifierad startplan krävs innan medgivande kan ges.');
  return environmentPlanIdentity(parsed.data);
}
async function vaultState(reader: WorkspaceDatabase, workspaceId: string, repoUrl: string) {
  const [entry] = await reader.select().from(schema.projectEnvironments).where(and(eq(schema.projectEnvironments.workspaceId, workspaceId), eq(schema.projectEnvironments.repoUrl, repoUrl), eq(schema.projectEnvironments.environment, 'test')));
  return { revision: entry?.revision ?? 0, names: entry ? Object.keys(openEnvironment(entry.sealedValues, environmentVaultScope(workspaceId, repoUrl))).sort() : [] };
}
function view(row: Consent, now: Date, current?: { planHash: string; vaultRevision: number }): EnvironmentConsentView {
  return { id: row.id, revision: row.revision, grantSetupJobId: row.grantSetupJobId, repoUrl: row.repoUrl, environment: 'test', plan: row.plan, planHash: row.planHash, allowedNames: row.allowedNames, vaultRevision: row.vaultRevision,
    expiresAt: row.expiresAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
    status: row.revokedAt ? 'revoked' : row.expiresAt.getTime() <= now.getTime() ? 'expired' : current && (current.planHash !== row.planHash || current.vaultRevision !== row.vaultRevision) ? 'outdated' : 'active' };
}

export async function environmentConsentStatus(userId: string, workspaceId: string, setupJobId: string): Promise<EnvironmentConsentStatus> {
  await requireWorkspace(userId, workspaceId);
  const plan = await verifiedPlan(db, userId, workspaceId, setupJobId);
  if (!plan) return { setupJobId, plan: null, planHash: null, vaultRevision: 0, configuredNames: [], missingNames: [], consents: [] };
  const state = await vaultState(db, workspaceId, plan.repoUrl), planHash = environmentPlanHash(plan), now = await clock(db);
  const rows = await db.select().from(schema.environmentConsents).where(and(eq(schema.environmentConsents.workspaceId, workspaceId), eq(schema.environmentConsents.userId, userId), eq(schema.environmentConsents.runtime, runtimeScope()), eq(schema.environmentConsents.repoUrl, plan.repoUrl), eq(schema.environmentConsents.environment, 'test'))).orderBy(desc(schema.environmentConsents.createdAt)).limit(20);
  return { setupJobId, plan, planHash, vaultRevision: state.revision, configuredNames: state.names, missingNames: plan.variables.filter(variable => variable.required && !state.names.includes(variable.name)).map(variable => variable.name), consents: rows.map(row => view(row, now, { planHash, vaultRevision: state.revision })) };
}

/** Called only by the session-authenticated grant route. Saving Vault values or
 * agent suggestions never invoke this operation. Replays return the old receipt
 * even after expiry/revocation; they do not renew or restore permission. */
export async function grantEnvironmentConsent(userId: string, workspaceId: string, setupJobId: string, input: unknown, connection: WorkspaceDatabase = db): Promise<EnvironmentConsentView> {
  const parsed = grantEnvironmentConsentSchema.safeParse(input);
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Kontrollera startplan, variabelnamn och giltighetstid.' });
  const body = parsed.data;
  return connection.transaction(async tx => {
    await requireWorkspace(userId, workspaceId, tx);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`environment-consent:${workspaceId}:${runtimeScope()}:${body.requestId}`}, 0))`);
    const [existing] = await tx.select().from(schema.environmentConsents).where(and(eq(schema.environmentConsents.workspaceId, workspaceId), eq(schema.environmentConsents.runtime, runtimeScope()), eq(schema.environmentConsents.requestId, body.requestId)));
    if (existing) {
      if (existing.userId !== userId || existing.grantSetupJobId !== setupJobId || existing.planHash !== body.expectedPlanHash || existing.vaultRevision !== body.expectedVaultRevision || JSON.stringify(existing.allowedNames) !== JSON.stringify(body.allowedNames) || body.expiresAt && Date.parse(body.expiresAt) !== existing.expiresAt.getTime()) throw invalid('Begäran har redan använts för ett annat medgivande.');
      const state = await vaultState(tx, workspaceId, existing.repoUrl);
      return view(existing, await clock(tx), { planHash: existing.planHash, vaultRevision: state.revision });
    }
    // Resolve the repo before taking its existing Vault lock, then re-read the
    // plan with a row lock. Callback updates cannot alter the accepted plan.
    const initial = await verifiedPlan(tx, userId, workspaceId, setupJobId);
    if (!initial) throw invalid('En verifierad startplan krävs innan medgivande kan ges.');
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${environmentVaultScope(workspaceId, initial.repoUrl)}, 0))`);
    const plan = await verifiedPlan(tx, userId, workspaceId, setupJobId, true);
    if (!plan || plan.repoUrl !== initial.repoUrl || environmentPlanHash(plan) !== body.expectedPlanHash) throw invalid('Startplanen har ändrats. Läs den aktuella planen innan du godkänner.');
    const state = await vaultState(tx, workspaceId, plan.repoUrl);
    if (state.revision !== body.expectedVaultRevision) throw invalid('Vaulten har ändrats. Bekräfta den aktuella versionen.');
    if (body.allowedNames.some(name => !plan.variables.some(variable => variable.name === name) || !state.names.includes(name)) || plan.variables.some(variable => variable.required && !body.allowedNames.includes(variable.name))) throw invalid('Medgivandet måste omfatta sparade obligatoriska variabler och får bara innehålla planens variabler.');
    const now = await clock(tx), expiresAt = body.expiresAt ? new Date(body.expiresAt) : new Date(now.getTime() + ENVIRONMENT_CONSENT_DEFAULT_MS);
    if (expiresAt <= now || expiresAt.getTime() - now.getTime() > ENVIRONMENT_CONSENT_MAX_MS) throw invalid('Medgivandet måste gälla framåt i tiden och högst sju dagar.');
    const [saved] = await tx.insert(schema.environmentConsents).values({ id: randomUUID(), userId, workspaceId, runtime: runtimeScope(), requestId: body.requestId, grantSetupJobId: setupJobId, repoUrl: plan.repoUrl, environment: 'test', plan, planHash: body.expectedPlanHash, allowedNames: body.allowedNames, vaultRevision: state.revision, expiresAt, createdAt: now }).returning();
    return view(saved!, now);
  });
}

export async function revokeEnvironmentConsent(userId: string, workspaceId: string, consentId: string, input: unknown, connection: WorkspaceDatabase = db): Promise<EnvironmentConsentView> {
  const parsed = revokeEnvironmentConsentSchema.safeParse(input);
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Medgivandets aktuella version krävs.' });
  return connection.transaction(async tx => {
    await requireWorkspace(userId, workspaceId, tx);
    const where = and(eq(schema.environmentConsents.id, consentId), eq(schema.environmentConsents.workspaceId, workspaceId), eq(schema.environmentConsents.userId, userId), eq(schema.environmentConsents.runtime, runtimeScope()));
    const [initial] = await tx.select().from(schema.environmentConsents).where(where);
    if (!initial) throw missing();
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${environmentVaultScope(workspaceId, initial.repoUrl)}, 0))`);
    const [row] = await tx.select().from(schema.environmentConsents).where(where).for('update');
    if (!row) throw missing();
    const now = await clock(tx);
    if (row.revokedAt) return view(row, now);
    if (row.revision !== parsed.data.expectedRevision) throw invalid('Medgivandet har ändrats. Läs aktuell status.');
    const [revoked] = await tx.update(schema.environmentConsents).set({ revokedAt: now, revision: row.revision + 1 }).where(where).returning();
    return view(revoked!, now);
  });
}

/** Ref-only eligibility under current locks. This is NOT a capability to inject
 * secrets: P2b must recheck at the worker's actual release boundary. The caller
 * supplies its server-authoritative mandate deadline and checks its own fencing. */
export async function authorizeEnvironmentConsent(userId: string, workspaceId: string, input: unknown, options: { deadline: Date; connection?: WorkspaceDatabase }): Promise<EnvironmentConsentAuthorization> {
  const parsed = authorizeEnvironmentConsentSchema.safeParse(input);
  if (!parsed.success || !Number.isFinite(options.deadline.getTime())) throw createError({ statusCode: 400, statusMessage: 'Medgivande, startplan och uppdragets tidsgräns krävs.' });
  const body = parsed.data;
  return (options.connection ?? db).transaction(async tx => {
    await requireWorkspace(userId, workspaceId, tx);
    const where = and(eq(schema.environmentConsents.id, body.consentId), eq(schema.environmentConsents.workspaceId, workspaceId), eq(schema.environmentConsents.userId, userId), eq(schema.environmentConsents.runtime, runtimeScope()));
    const [initial] = await tx.select().from(schema.environmentConsents).where(where);
    if (!initial) throw missing();
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${environmentVaultScope(workspaceId, initial.repoUrl)}, 0))`);
    const plan = await verifiedPlan(tx, userId, workspaceId, body.setupJobId, true);
    const [consent] = await tx.select().from(schema.environmentConsents).where(where).for('update');
    const now = await clock(tx);
    if (!consent || consent.revokedAt || consent.expiresAt <= now || options.deadline <= now) throw invalid('Medgivandet är återkallat eller tidsgränsen har passerat.');
    if (consent.revision !== body.consentRevision || !plan || plan.repoUrl !== consent.repoUrl || consent.environment !== 'test' || environmentPlanHash(plan) !== consent.planHash || consent.planHash !== body.expectedPlanHash || body.vaultRevision !== consent.vaultRevision) throw invalid('Medgivandet gäller inte den aktuella startplanen.');
    const state = await vaultState(tx, workspaceId, consent.repoUrl);
    if (state.revision !== consent.vaultRevision || consent.allowedNames.some(name => !state.names.includes(name)) || plan.variables.some(variable => variable.required && !consent.allowedNames.includes(variable.name))) throw invalid('Vaulten har ändrats. Ett nytt medgivande krävs.');
    return { consentId: consent.id, consentRevision: consent.revision, setupJobId: body.setupJobId, workspaceId, repoUrl: consent.repoUrl, environment: 'test', planHash: consent.planHash, commit: plan.commit, allowedNames: [...consent.allowedNames], vaultRevision: consent.vaultRevision, validUntil: new Date(Math.min(consent.expiresAt.getTime(), options.deadline.getTime())).toISOString() };
  });
}
