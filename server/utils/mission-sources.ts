import { createHash } from 'node:crypto';
import { and, eq, desc } from 'drizzle-orm';
import { schema } from '@nuxthub/db';
import { runtimeScope } from '../../shared/runtime-scope';
import { redactReportText, workStatus, type WorkResult, type EvidenceRef } from '../../shared/mission';
import type { WorkspaceDatabase } from './workspaces';
import { missionRedactor, redactMissionValue } from './mission-redaction';
import { runCoverage } from '../../shared/test-run';

function canonical(value: unknown): unknown { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' && !(value instanceof Date) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value; }
export const missionHash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'null').digest('hex');
const iso = (v: Date | null | undefined) => v?.toISOString() ?? null;
function observation(id: string, title: string, excerpt: string, origin: EvidenceRef['origin'], observedAt: string | null, url: string | null = null): EvidenceRef {
  const text = redactReportText(excerpt).slice(0, 32000);
  return { id, title, excerpt: text, origin, observedAt, url, itemId: null, version: null, hash: missionHash(text), kind: 'observation', unavailable: false };
}
export async function missionItemEvidence(connection: WorkspaceDatabase, workspaceId: string, itemId: string): Promise<EvidenceRef> {
  const [item] = await connection.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.id, itemId), eq(schema.workspaceItems.workspaceId, workspaceId)));
  const unavailable = !item || !!item.deletedAt;
  const [report] = await connection.select({ id: schema.missionReports.id }).from(schema.missionReports).where(eq(schema.missionReports.itemId, itemId)).limit(1);
  const [source] = unavailable ? [] : await connection.select().from(schema.workspaceEvidence).where(and(eq(schema.workspaceEvidence.itemId, itemId), eq(schema.workspaceEvidence.workspaceId, workspaceId), eq(schema.workspaceEvidence.itemVersion, item.version))).orderBy(desc(schema.workspaceEvidence.createdAt)).limit(1);
  const text = !unavailable && ['text', 'diagram'].includes(item.content.kind) ? redactReportText(JSON.stringify(item.content)).slice(0, 32000) : '';
  return { id: `item:${itemId}`, itemId, title: unavailable ? 'Underlag otillgängligt' : item.title, version: item?.version ?? null, hash: missionHash(unavailable ? 'unavailable' : item.content), kind: item?.content.kind === 'image' ? 'image' : 'text', origin: report ? 'agent' : 'source', excerpt: text, url: source?.url ?? null, observedAt: iso(source?.observedAt ?? item?.updatedAt), unavailable };
}
export async function readMissionSource(connection: WorkspaceDatabase, workspaceId: string, type: WorkResult['sourceType'], id: string): Promise<WorkResult> {
  const result: WorkResult = { schemaVersion: 1, sourceType: type, sourceId: id, attemptId: id, status: 'unknown', reportedOutcome: 'unknown', summary: '', limitations: [], target: null, startedAt: null, finishedAt: null, evidence: [], assessment: null };
  if (type === 'test') {
    const [run] = await connection.select().from(schema.testRuns).where(and(eq(schema.testRuns.id, id), eq(schema.testRuns.workspaceId, workspaceId)));
    if (!run) throw createError({ statusCode: 404, statusMessage: 'Test run not in workspace' });
    if (run.runtime && run.runtime !== runtimeScope()) throw createError({ statusCode: 404, statusMessage: 'Test run not in runtime' });
    if (!run.runtime) result.limitations.push('Historisk körning utan registrerad runtime; kopplad uttryckligen.');
    result.status = run.finishedAt ? 'completed' : 'running'; result.reportedOutcome = run.result?.outcome === 'passed' ? 'achieved' : run.result?.outcome === 'blocked' ? 'blocked' : run.result ? 'partial' : 'unknown';
    result.summary = redactReportText(run.result?.actual ?? 'Testet pågår.'); result.target = run.target; result.startedAt = iso(run.startedAt); result.finishedAt = iso(run.finishedAt);
    result.claims = run.result ? runCoverage(run.snapshot, run.result).checks.map(c => ({ id: c.id, requirement: c.requirement, reportedStatus: c.status, reportedActual: c.actual })) : [];
    if (run.result?.unverified) result.limitations.push(redactReportText(run.result.unverified));
    const captures = await connection.select().from(schema.testCaptures).where(eq(schema.testCaptures.runId, id)).orderBy(schema.testCaptures.createdAt, schema.testCaptures.id);
    for (const item of [...new Set([...(run.result?.evidenceItemIds ?? []), ...captures.flatMap(c => c.itemId ? [c.itemId] : [])])]) result.evidence.push(await missionItemEvidence(connection, workspaceId, item));
    for (const capture of captures) result.evidence.push(observation(`capture:${capture.id}`, capture.title, JSON.stringify({ action: capture.action, url: capture.url, error: capture.error }), 'tool', iso(capture.createdAt), capture.url));
    const [assessment] = await connection.select().from(schema.resultAssessments).where(and(eq(schema.resultAssessments.runId, id), eq(schema.resultAssessments.runtime, runtimeScope()))).orderBy(desc(schema.resultAssessments.createdAt)).limit(1);
    if (assessment) result.assessment = { verdict: assessment.assessment?.verdict ?? assessment.status, summary: assessment.assessment?.summary ?? assessment.error ?? '', stale: assessment.input.evidence.some(e => e.itemId && !result.evidence.some(r => r.itemId === e.itemId && r.version === e.version && !r.unavailable)) };
  } else if (type === 'setup') {
    const [job] = await connection.select().from(schema.setupJobs).where(and(eq(schema.setupJobs.id, id), eq(schema.setupJobs.workspaceId, workspaceId), eq(schema.setupJobs.runtime, runtimeScope())));
    if (!job) throw createError({ statusCode: 404, statusMessage: 'Setup job not in workspace' });
    result.status = workStatus(job.status); result.summary = redactReportText(job.result?.result ?? job.result?.message ?? job.task); result.startedAt = iso(job.createdAt); result.finishedAt = ['running', 'unknown'].includes(result.status) ? null : job.result?.updatedAt ?? iso(job.updatedAt);
    const env = job.result?.environment;
    if (env) {
      result.target = { environment: 'VPS', url: `http://127.0.0.1:${env.port}/`, revision: env.commit }; result.reportedOutcome = env.httpStatus && env.httpStatus >= 400 ? 'blocked' : 'unknown';
      // EnvironmentManager.inspect overwrites the model's commit and HTTP status
      // with git and HTTP probes. Reuse that observation, not the narrative.
      result.evidence.push(observation(`environment:${id}`, 'VPS-kontroll av commit och HTTP', JSON.stringify({ repo: env.repoUrl, commit: env.commit, port: env.port, httpStatus: env.httpStatus, processId: env.processId, observation: 'EnvironmentManager HTTP probe', limit: 'Gäller endast HTTP-svaret på roten. Verifierar inte funktionella tester.' }), 'tool', job.result!.updatedAt));
    }
    result.evidence.push(observation(`setup:${id}`, 'Ottos rapport', JSON.stringify({ report: result.summary, environment: env && { commit: env.commit, port: env.port, httpStatus: env.httpStatus } }), 'agent', job.result?.updatedAt ?? iso(job.createdAt)));
    result.limitations.push(env ? 'Kommando och miljökrav anges av utföraren. Sparad commit och HTTP-status kommer från VPS-kontrollen; kontrollens exakta tidpunkt saknas och jobbets uppdateringstid visas.' : 'Ingen verifierad startplan eller HTTP-kontroll har sparats.');
  } else if (type === 'browser') {
    const [row] = await connection.select({ job: schema.browserJobs }).from(schema.browserJobs).innerJoin(schema.threads, eq(schema.threads.id, schema.browserJobs.threadId)).where(and(eq(schema.browserJobs.id, id), eq(schema.threads.workspaceId, workspaceId), eq(schema.browserJobs.runtime, runtimeScope())));
    if (!row) throw createError({ statusCode: 404, statusMessage: 'Browser job not in workspace' });
    const job = row.job;
    result.status = workStatus(job.status); result.summary = redactReportText(job.report || job.task); result.startedAt = iso(job.createdAt); result.finishedAt = result.status === 'running' ? null : iso(job.updatedAt);
    result.evidence.push(observation(`browser:${id}`, 'Iris rapport', result.summary, 'agent', iso(job.updatedAt)));
    result.limitations.push('En agentrapport styrker inte ensam att alla teststeg verifierats. Koppla de faktiska testkörningarna till uppdraget.');
  } else if (type === 'repository') {
    const [run] = await connection.select().from(schema.repositoryRuns).where(and(eq(schema.repositoryRuns.id, id), eq(schema.repositoryRuns.workspaceId, workspaceId)));
    if (!run) throw createError({ statusCode: 404, statusMessage: 'Repository run not in workspace' });
    if (run.runtime && run.runtime !== runtimeScope()) throw createError({ statusCode: 404, statusMessage: 'Repository run not in runtime' });
    if (!run.runtime) result.limitations.push('Historisk repokörning utan registrerad runtime; kopplad uttryckligen.');
    const job = run.job;
    result.status = job ? workStatus(job.status) : 'running'; result.summary = redactReportText(job?.message ?? 'Väntar på repojobb'); result.startedAt = iso(run.createdAt); result.finishedAt = job?.finishedAt ?? null;
    result.target = { environment: 'repository', url: run.config.url, revision: job?.commit ?? '' };
    if (job) { result.evidence.push(observation(`repo:${id}`, 'Kommando och logg', JSON.stringify({ exitCode: job.testExitCode, command: job.plan?.command, commit: job.commit, logs: job.logs }), 'tool', job.updatedAt)); result.reportedOutcome = job.status === 'blocked' ? 'blocked' : 'unknown'; }
    result.limitations.push('Ett lyckat kommando verifierar inte automatiskt appstart eller uppdragets alla kriterier.');
  } else {
    const evidence = await missionItemEvidence(connection, workspaceId, id);
    if (evidence.unavailable) throw createError({ statusCode: 404, statusMessage: 'Material not available' });
    result.status = 'completed'; result.summary = evidence.title; result.evidence = [evidence]; result.finishedAt = evidence.observedAt;
  }
  if (!result.target?.revision) result.limitations.push('Observerad version saknas.');
  const redact = await missionRedactor(connection, workspaceId);
  result.summary = redact(result.summary);
  result.limitations = result.limitations.map(redact);
  for (const evidence of result.evidence) { evidence.excerpt = redact(evidence.excerpt); evidence.title = redact(evidence.title); }
  if (result.assessment) result.assessment.summary = redact(result.assessment.summary);
  if (result.claims) result.claims = result.claims.map(c => ({ ...c, requirement: redact(c.requirement), reportedActual: redact(c.reportedActual) }));
  const clean = redactMissionValue(result, redact);
  clean.sourceRevision = missionHash(clean);
  return clean;
}
