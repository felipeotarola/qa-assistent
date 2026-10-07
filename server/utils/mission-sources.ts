import { createHash } from 'node:crypto';
import { and, eq, desc } from 'drizzle-orm';
import { schema } from '@nuxthub/db';
import { runtimeScope } from '../../shared/runtime-scope';
import { redactReportText, workStatus, type WorkResult, type EvidenceRef } from '../../shared/mission';
import type { WorkspaceDatabase } from './workspaces';
import { missionRedactor, redactMissionValue } from './mission-redaction';
import { runCoverage, runResultScope } from '../../shared/test-run';
import { EVIDENCE_POLICY_VERSION, normalizeEvidenceProvenance, type EvidenceProvenance } from '../../shared/evidence-provenance';
import { REVIEWER_VERSION } from '../../shared/result-assessment';
import { buildReviewInput, hashReview, readCurrentRunAssessment } from './result-assessments';

function canonical(value: unknown): unknown { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' && !(value instanceof Date) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value; }
export const missionHash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'null').digest('hex');
const iso = (v: Date | null | undefined) => v?.toISOString() ?? null;
function observation(id: string, title: string, excerpt: string, provenance: EvidenceProvenance, url: string | null = null): EvidenceRef {
  const text = redactReportText(excerpt).slice(0, 32000);
  return { id, title, excerpt: text, origin: provenance.origin, evidencePolicyVersion: EVIDENCE_POLICY_VERSION, provenance, observedAt: provenance.observedAt, url, itemId: null, version: null, hash: missionHash({ text, provenance, evidencePolicyVersion: EVIDENCE_POLICY_VERSION }), kind: 'observation', unavailable: false };
}
export async function missionItemEvidence(connection: WorkspaceDatabase, workspaceId: string, itemId: string): Promise<EvidenceRef> {
  const [item] = await connection.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.id, itemId), eq(schema.workspaceItems.workspaceId, workspaceId)));
  const unavailable = !item || !!item.deletedAt;
  const [report] = await connection.select({ id: schema.missionReports.id }).from(schema.missionReports).where(eq(schema.missionReports.itemId, itemId)).limit(1);
  const text = !unavailable && ['text', 'diagram', 'test_plan'].includes(item.content.kind) ? redactReportText(JSON.stringify(item.content)).slice(0, 32000) : '';
  const provenance = normalizeEvidenceProvenance(item?.provenance);
  // A definition records intended checks, never executor observations. Even an
  // old/misclassified tool provenance must not promote its text into run proof.
  const origin = item?.content.kind === 'test_plan' && provenance?.origin === 'tool' ? 'unknown' : provenance?.origin ?? 'unknown';
  return { id: `item:${itemId}`, itemId, title: unavailable ? 'Underlag otillgängligt' : item.title, version: item?.version ?? null, hash: missionHash({ content: unavailable ? 'unavailable' : item.content, provenance, evidencePolicyVersion: EVIDENCE_POLICY_VERSION }), kind: item?.content.kind === 'image' ? 'image' : 'text', origin: report ? 'agent' : origin, evidencePolicyVersion: EVIDENCE_POLICY_VERSION, provenance, excerpt: text, url: provenance?.url ?? null, observedAt: provenance?.observedAt ?? null, unavailable };
}
export async function readMissionSource(connection: WorkspaceDatabase, workspaceId: string, type: WorkResult['sourceType'], id: string): Promise<WorkResult> {
  const result: WorkResult = { schemaVersion: 2, sourceType: type, sourceId: id, attemptId: id, status: 'unknown', reportedOutcome: 'unknown', summary: '', limitations: [], target: null, startedAt: null, finishedAt: null, evidence: [], assessment: null };
  if (type === 'test') {
    const [run] = await connection.select().from(schema.testRuns).where(and(eq(schema.testRuns.id, id), eq(schema.testRuns.workspaceId, workspaceId)));
    if (!run) throw createError({ statusCode: 404, statusMessage: 'Test run not in workspace' });
    if (run.runtime && run.runtime !== runtimeScope()) throw createError({ statusCode: 404, statusMessage: 'Test run not in runtime' });
    if (!run.runtime) result.limitations.push('Historisk körning utan registrerad runtime; kopplad uttryckligen.');
    result.status = run.finishedAt ? 'completed' : 'running'; result.reportedOutcome = run.result?.outcome === 'passed' ? 'achieved' : run.result?.outcome === 'blocked' ? 'blocked' : run.result ? 'partial' : 'unknown';
    result.summary = redactReportText(run.result?.actual ?? 'Testet pågår.'); result.target = run.target; result.startedAt = iso(run.startedAt); result.finishedAt = iso(run.finishedAt);
    result.claims = run.result ? runCoverage(run.snapshot, run.result).checks.map(c => ({ id: c.id, requirement: c.requirement, reportedStatus: c.status, reportedActual: c.actual })) : [];
    if (run.snapshot.basis?.kind === 'exploratory') result.limitations.push('Testets förväntningar är utforskande hypoteser, inte fastställda produktkrav. Observationer kan verifieras men avvikelser ska beskrivas med denna reservation.');
    else if (!run.snapshot.basis) result.limitations.push('Testets kravgrund är inte registrerad.');
    for (const remaining of runResultScope(run.result).remaining) result.limitations.push(redactReportText(`${remaining.checkId ? `${remaining.checkId}: ` : ''}${remaining.reason}`));
    const captures = await connection.select().from(schema.testCaptures).where(eq(schema.testCaptures.runId, id)).orderBy(schema.testCaptures.createdAt, schema.testCaptures.id);
    for (const item of [...new Set([...(run.result?.evidenceItemIds ?? []), ...captures.flatMap(c => c.itemId ? [c.itemId] : [])])]) result.evidence.push(await missionItemEvidence(connection, workspaceId, item));
    for (const capture of captures) result.evidence.push(observation(`capture:${capture.id}`, capture.title, JSON.stringify({ action: capture.action, url: capture.url, error: capture.error }), { version: 1, origin: 'tool', producer: 'capture-metadata', sourceType: 'test', sourceId: id, observedAt: iso(capture.createdAt) }, capture.url));
    const assessment = await readCurrentRunAssessment(workspaceId, id, connection)
      ?? (await connection.select().from(schema.resultAssessments).where(and(eq(schema.resultAssessments.runId, id), eq(schema.resultAssessments.runtime, runtimeScope()))).orderBy(desc(schema.resultAssessments.createdAt)).limit(1))[0];
    if (assessment) result.assessment = {
      status: assessment.status, finishedAt: iso(assessment.finishedAt), inputHash: assessment.inputHash,
      verdict: assessment.assessment?.verdict ?? assessment.status,
      summary: assessment.assessment?.summary ?? assessment.error ?? '',
      reviewerVersion: assessment.reviewerVersion,
      id: assessment.id,
      sourceHash: assessment.sourceHash,
      ruleFindings: assessment.input.ruleFindings,
      findings: assessment.assessment?.findings ?? [],
      stale: assessment.reviewerVersion !== REVIEWER_VERSION || assessment.input.schemaVersion !== 2 || assessment.inputHash !== hashReview(assessment.input) || !run.finishedAt || !run.result || assessment.sourceHash !== hashReview(await buildReviewInput(workspaceId, id, connection)),
    };
  } else if (type === 'setup') {
    const [job] = await connection.select().from(schema.setupJobs).where(and(eq(schema.setupJobs.id, id), eq(schema.setupJobs.workspaceId, workspaceId), eq(schema.setupJobs.runtime, runtimeScope())));
    if (!job) throw createError({ statusCode: 404, statusMessage: 'Setup job not in workspace' });
    result.status = workStatus(job.status); result.summary = redactReportText(job.result?.result ?? job.result?.message ?? job.task); result.startedAt = iso(job.createdAt); result.finishedAt = ['running', 'unknown'].includes(result.status) ? null : job.result?.updatedAt ?? iso(job.updatedAt);
    const env = job.result?.environment;
    if (env) {
      result.target = { environment: 'VPS', url: `http://127.0.0.1:${env.port}/`, revision: env.commit }; result.reportedOutcome = env.httpStatus && env.httpStatus >= 400 ? 'blocked' : 'unknown';
      // EnvironmentManager.inspect overwrites the model's commit and HTTP status
      // with git and HTTP probes. Reuse that observation, not the narrative.
        const identityOnly = env.probeKind === 'identity';
        result.evidence.push(observation(`environment:${id}`, identityOnly ? 'VPS-kontroll av repoidentitet och startplan' : 'VPS-kontroll av commit och HTTP', JSON.stringify({ repo: env.repoUrl, commit: env.commit, port: env.port, httpStatus: env.httpStatus, processId: env.processId,
          observation: identityOnly ? 'EnvironmentManager identity probe; ingen app har startats' : 'EnvironmentManager HTTP probe', executionProfile: env.executionProfile,
          limit: identityOnly ? 'Verifierar repo, commit och installationsprofil. Startkommandot är ett förslag som ännu inte har körts.' : 'Gäller endast HTTP-svaret på roten. Verifierar inte funktionella tester.', observedAt: env.observedAt ?? null }), { version: 1, origin: 'tool', producer: 'environment-probe', sourceType: 'setup', sourceId: id, observedAt: env.observedAt ?? null }));
    }
    result.evidence.push(observation(`setup:${id}`, 'Ottos rapport', JSON.stringify({ report: result.summary, environment: env && { commit: env.commit, port: env.port, httpStatus: env.httpStatus } }), { version: 1, origin: 'agent', producer: 'agent-authored', sourceType: 'setup', sourceId: id, observedAt: null }));
      result.limitations.push(env ? `Kommando och miljökrav anges av utföraren. Sparad commit ${env.probeKind === 'identity' ? 'och installationsprofil kommer från identitetskontrollen; appstart är inte verifierad.' : 'och HTTP-status kommer från VPS-kontrollen.'}${env.observedAt ? '' : ' Kontrollens exakta tidpunkt saknas; jobbets uppdateringstid visas.'}` : 'Ingen verifierad startplan eller HTTP-kontroll har sparats.');
  } else if (type === 'browser') {
    const [row] = await connection.select({ job: schema.browserJobs }).from(schema.browserJobs).innerJoin(schema.threads, eq(schema.threads.id, schema.browserJobs.threadId)).where(and(eq(schema.browserJobs.id, id), eq(schema.threads.workspaceId, workspaceId), eq(schema.browserJobs.runtime, runtimeScope())));
    if (!row) throw createError({ statusCode: 404, statusMessage: 'Browser job not in workspace' });
    const job = row.job;
    result.status = workStatus(job.status); result.summary = redactReportText(job.report || job.task); result.startedAt = iso(job.createdAt); result.finishedAt = result.status === 'running' ? null : iso(job.updatedAt);
    result.evidence.push(observation(`browser:${id}`, 'Iris rapport', result.summary, { version: 1, origin: 'agent', producer: 'agent-authored', sourceType: 'browser', sourceId: id, observedAt: null }));
    result.limitations.push('En agentrapport styrker inte ensam att alla teststeg verifierats.');
  } else if (type === 'repository') {
    const [run] = await connection.select().from(schema.repositoryRuns).where(and(eq(schema.repositoryRuns.id, id), eq(schema.repositoryRuns.workspaceId, workspaceId)));
    if (!run) throw createError({ statusCode: 404, statusMessage: 'Repository run not in workspace' });
    if (run.runtime && run.runtime !== runtimeScope()) throw createError({ statusCode: 404, statusMessage: 'Repository run not in runtime' });
    if (!run.runtime) result.limitations.push('Historisk repokörning utan registrerad runtime; kopplad uttryckligen.');
    const job = run.job;
    result.status = job ? workStatus(job.status) : 'running'; result.summary = redactReportText(job?.message ?? 'Väntar på repojobb'); result.startedAt = iso(run.createdAt); result.finishedAt = job?.finishedAt ?? null;
    result.target = { environment: 'repository', url: run.config.url, revision: job?.commit ?? '' };
    if (job) { result.evidence.push(observation(`repo:${id}`, 'Kommando och logg', JSON.stringify({ exitCode: job.testExitCode, command: job.plan?.command, commit: job.commit, logs: job.logs }), { version: 1, origin: 'tool', producer: 'repository-runner', sourceType: 'repository', sourceId: id, observedAt: job.updatedAt })); result.reportedOutcome = job.status === 'blocked' ? 'blocked' : 'unknown'; }
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
