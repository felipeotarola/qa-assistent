import { and, eq, desc, sql } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { randomUUID } from 'node:crypto';
import { setupResultSchema, configureEnvironmentSchema, environmentValuesSchema, type SetupResult, type SetupView } from '../../shared/project-environment';
import { requireWorkspace } from './workspaces';
import { getThreadForUser } from './threads';
import { runtimeScope } from '../../shared/runtime-scope';
import { repositoryRunner } from './repositories';
import { sandboxScope } from './sandbox-scope';
import { sealEnvironment, openEnvironment } from './environment-crypto';
import { appOrigin, internalHeaders } from '../../agent/lib/internal-api';
import { repositoryRequestId } from '#shared/repository-request.mjs';
import { repositoryMapTarget } from '../../shared/repository-map';
import { saveRepositoryMap } from './repository-map';
import { receiveMissionEnvironmentResult } from './mission-environment';

const terminal = (status: string) => !['starting','running','configuring'].includes(status);
const vaultScope = (workspaceId: string, repo: string) => `${workspaceId}:${repo}:test`;
async function vault(workspaceId: string, repo: string) {
  const [row] = await db.select().from(schema.projectEnvironments).where(and(eq(schema.projectEnvironments.workspaceId,workspaceId),eq(schema.projectEnvironments.repoUrl,repo),eq(schema.projectEnvironments.environment,'test')));
  return row;
}
export async function ownedSetup(userId: string, workspaceId: string, id: string) {
  await requireWorkspace(userId, workspaceId);
  const [job] = await db.select().from(schema.setupJobs).where(and(eq(schema.setupJobs.id,id),eq(schema.setupJobs.workspaceId,workspaceId),eq(schema.setupJobs.runtime,runtimeScope())));
  if (!job) throw createError({ statusCode:404,statusMessage:'Konfigurationsuppdraget saknas.' });
  return job;
}
export async function receiveSetupResult(input: unknown) {
  const result = setupResultSchema.parse(input);
  const [job] = await db.select().from(schema.setupJobs).where(eq(schema.setupJobs.id,result.jobId));
  if (!job) throw createError({ statusCode:404,statusMessage:'Unknown setup job' });
  if (job.autonomy) return receiveMissionEnvironmentResult(input);
  const [thread] = await db.select().from(schema.threads).where(eq(schema.threads.id,job.threadId));
  if (!thread || result.workspaceId !== job.workspaceId || result.id !== sandboxScope(thread.userId,job.threadId,job.sessionKey).id) throw createError({statusCode:409,statusMessage:'Setup scope mismatch'});
  if (job.result && job.result.updatedAt > result.updatedAt) return;
  if (result.status === 'completed' && repositoryMapTarget(job.task)) {
    try {
      const itemId = await saveRepositoryMap(thread.userId, job, result.result || '');
      result.message = `Repokartan är sparad i Material. Objekt: ${itemId}. Kodanalys, inte funktionstest.`;
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && (error.name === 'ZodError' || error.message.includes('repository map')))) {
        result.message = 'Analysen avslutades men repokartan kunde inte valideras. Ingen karta sparades. Läs rapporten innan ett nytt försök.';
        result.status = 'failed';
      } else throw error; // Retry transient storage failures through existing reconciliation.
    }
  }
  await db.update(schema.setupJobs).set({status:result.status,result,updatedAt:new Date()}).where(and(eq(schema.setupJobs.id,job.id),sql`coalesce(${schema.setupJobs.result}->>'updatedAt','') <= ${result.updatedAt}`));
  if (!terminal(result.status)) return;
  // Local and production sessions are distinct. The matching runtime's poller
  // can deliver a persisted result even when the VPS callback targets production.
  if (job.runtime !== runtimeScope()) return;
  const version = `${result.status}:${result.updatedAt}`;
  const [claimed] = await db.update(schema.setupJobs).set({notification:'sending',notifiedVersion:version}).where(and(eq(schema.setupJobs.id,job.id),sql`${schema.setupJobs.notifiedVersion} is distinct from ${version}`,sql`${schema.setupJobs.result}->>'updatedAt' = ${result.updatedAt}`)).returning();
  if (!claimed) return;
  const current = await getThreadForUser(thread.userId,job.threadId);
  if (current?.sessionId !== job.parentSessionId) {
    await db.update(schema.setupJobs).set({notification:'session_changed'}).where(eq(schema.setupJobs.id,job.id)); return;
  }
  let notification = 'unknown';
  try {
    const response = await fetch(`${appOrigin()}/workers/setup/notify`, {method:'POST',headers:internalHeaders(),signal:AbortSignal.timeout(20000),body:JSON.stringify({parentSessionId:job.parentSessionId,threadId:job.threadId,userId:thread.userId,model:job.model,reasoning:job.reasoning,task:job.task,result})});
    const receipt = response.headers.get('content-type')?.includes('application/json') ? await response.json() as {ok?:boolean} : null;
    notification = response.ok && receipt?.ok === true ? 'delivered' : 'failed';
  } catch { /* Sending has an ambiguous outcome: do not duplicate a continuation. */ }
  await db.update(schema.setupJobs).set({notification}).where(and(eq(schema.setupJobs.id,job.id),eq(schema.setupJobs.notifiedVersion,version)));
}
export async function listSetupJobs(userId: string, workspaceId: string): Promise<SetupView[]> {
  await requireWorkspace(userId,workspaceId);
  let jobs = await db.select().from(schema.setupJobs).where(and(eq(schema.setupJobs.workspaceId,workspaceId),eq(schema.setupJobs.runtime,runtimeScope()))).orderBy(desc(schema.setupJobs.createdAt)).limit(10);
  // Bounded fallback reconciles missed callbacks; never starts or retries work.
  await Promise.all(jobs.filter(j=>!j.autonomy && (!terminal(j.status)||j.notification==='pending')).slice(0,3).map(async job=>{
    try { const result = await repositoryRunner<SetupResult>('/codex',{action:'status',jobId:job.id,userId,workspaceId,...sandboxScope(userId,job.threadId,job.sessionKey)}); await receiveSetupResult(result); } catch { /* Preserve last known state. */ }
  }));
  jobs = await db.select().from(schema.setupJobs).where(and(eq(schema.setupJobs.workspaceId,workspaceId),eq(schema.setupJobs.runtime,runtimeScope()))).orderBy(desc(schema.setupJobs.createdAt)).limit(10);
  return Promise.all(jobs.map(async job=>{
    const stored = job.result?.environment ? await vault(workspaceId,job.result.environment.repoUrl) : undefined;
    const result = job.result ? { jobId: job.result.jobId, id: job.result.id, workspaceId: job.result.workspaceId, status: job.result.status, message: job.result.message,
      result: job.result.result, environment: job.result.environment, updatedAt: job.result.updatedAt } : null;
    return {id:job.id,threadId:job.threadId,status:job.status,result,autonomous:!!job.autonomy,configuredNames:stored ? Object.keys(openEnvironment(stored.sealedValues,vaultScope(workspaceId,stored.repoUrl))) : [],revision:stored?.revision||0,notification:job.notification};
  }));
}
export async function configureSetup(userId: string, workspaceId: string, id: string, input: unknown) {
  const parsed = configureEnvironmentSchema.safeParse(input);
  if (!parsed.success) throw createError({statusCode:400,statusMessage:'Kontrollera variabelnamn och värden. Inga ändringar sparades.'});
  const body = parsed.data, job = await ownedSetup(userId,workspaceId,id), plan = job.result?.environment;
  if (job.autonomy && body.continue) throw createError({ statusCode:409,statusMessage:'Spara variablerna i Vault och godkänn sedan uppdragets verifierade startplan. Direkta starter stöds inte för autonoma uppdrag.' });
  if (!plan || !['needs_configuration','failed','completed'].includes(job.status)) throw createError({statusCode:409,statusMessage:'Miljön kan inte konfigureras just nu. Uppdatera status.'});
  const names = new Set(plan.variables.map(v=>v.name));
  if ([...Object.keys(body.values),...body.forget].some(name=>!names.has(name))) throw createError({statusCode:400,statusMessage:'Endast variabler för detta uppdrag får ändras.'});
  const scope = vaultScope(workspaceId,plan.repoUrl);
  const stored = await db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${scope},0))`);
    const [existing] = await tx.select().from(schema.projectEnvironments).where(and(eq(schema.projectEnvironments.workspaceId,workspaceId),eq(schema.projectEnvironments.repoUrl,plan.repoUrl),eq(schema.projectEnvironments.environment,'test')));
    if ((existing?.revision||0)!==body.expectedRevision) throw createError({statusCode:409,statusMessage:'Inställningarna har ändrats. Läs om innan du sparar.'});
    const values = Object.fromEntries(Object.entries({... (existing ? openEnvironment(existing.sealedValues,scope):{}),...body.values}).filter(([key])=>!body.forget.includes(key)));
    if (!environmentValuesSchema.safeParse(values).success) throw createError({statusCode:400,statusMessage:'Högst 30 variabler kan sparas per repo.'});
    if (body.continue && plan.variables.some(v=>v.required&&!values[v.name])) throw createError({statusCode:400,statusMessage:'Fyll i obligatoriska variabler innan du fortsätter.'});
    const record = {sealedValues:sealEnvironment(values,scope),revision:(existing?.revision||0)+1,updatedAt:new Date()};
    const [saved] = existing ? await tx.update(schema.projectEnvironments).set(record).where(eq(schema.projectEnvironments.id,existing.id)).returning() : await tx.insert(schema.projectEnvironments).values({id:randomUUID(),workspaceId,repoUrl:plan.repoUrl,...record}).returning();
    return {revision:saved!.revision,values};
  });
  if (!body.continue) return {saved:true,revision:stored.revision,status:job.status};
  const values = Object.fromEntries(Object.entries(stored.values).filter(([key])=>names.has(key)));
  // Persist intent first. An ambiguous response can be retried with the same
  // revision/attempt ID through resume, without restarting twice.
  await db.update(schema.setupJobs).set({applyRevision:stored.revision}).where(eq(schema.setupJobs.id,id));
  return resumeSetup(userId,workspaceId,id,stored.revision,values);
}
export async function resumeSetup(userId: string,workspaceId: string,id: string,revision: number,knownValues?: Record<string,string>) {
  const job = await ownedSetup(userId,workspaceId,id), plan = job.result?.environment;
  if (job.autonomy) throw createError({ statusCode:409,statusMessage:'Uppdragets styrning återupptar miljön efter ett giltigt medgivande.' });
  if (!plan || job.applyRevision!==revision) throw createError({statusCode:409,statusMessage:'Ingen sparad fortsättning finns.'});
  const entry = await vault(workspaceId,plan.repoUrl);
  if (!entry || entry.revision!==revision) throw createError({statusCode:409,statusMessage:'Konfigurationen har ändrats. Bekräfta den nya versionen.'});
  const values = knownValues || Object.fromEntries(Object.entries(openEnvironment(entry.sealedValues,vaultScope(workspaceId,plan.repoUrl))).filter(([key])=>plan.variables.some(v=>v.name===key)));
  try {
    const result = await repositoryRunner<SetupResult>('/codex',{action:'configure',jobId:id,userId,workspaceId,...sandboxScope(userId,job.threadId,job.sessionKey),values,attemptId:repositoryRequestId(id,String(revision))},15000);
    await receiveSetupResult(result); return {saved:true,revision,status:result.status};
  } catch { throw createError({statusCode:502,statusMessage:'Inställningarna är sparade, men fortsättningen kunde inte bekräftas. Kontrollera status och använd Försök fortsätta igen.'}); }
}
