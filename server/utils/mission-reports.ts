import { randomUUID } from 'node:crypto';
import { and, eq, sql, inArray, desc } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { missions, missionReports, missionSnapshots } from '../db/schema/missions';
import { runtimeScope } from '../../shared/runtime-scope';
import { reportDraftSchema, assembleReport, validateReport } from '../../shared/mission-report';
import { redactReportText } from '../../shared/mission';
import { writeMissionReport } from '../../agent/lib/mission-reporter';
import { missionItemEvidence } from './mission-sources';
import { readMissionEvidence, type EvidenceRead } from './mission-evidence';
import { missionRedactor } from './mission-redaction';
import { reconcileMission, requestMissionReport } from './missions';
import { requireWorkspace, saveItem } from './workspaces';
import { appOrigin, internalHeaders } from '../../agent/lib/internal-api';
import { getThreadForUser } from './threads';

export async function readOwnedReport(userId: string, workspaceId: string, reportId: string) {
  await requireWorkspace(userId, workspaceId);
  const [row] = await db.select({ report: missionReports, mission: missions, snapshot: missionSnapshots }).from(missionReports).innerJoin(missions, eq(missions.id, missionReports.missionId)).innerJoin(missionSnapshots, eq(missionSnapshots.id, missionReports.snapshotId)).where(and(eq(missionReports.id, reportId), eq(missions.workspaceId, workspaceId), eq(missions.runtime, runtimeScope())));
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Rapporten hittades inte.' });
  if (row.report.status === 'completed' && !row.report.itemId) throw createError({ statusCode: 404, statusMessage: 'Rapporten är borttagen.' });
  if (row.report.itemId) { const [item] = await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.id, row.report.itemId)); if (!item || item.deletedAt) throw createError({ statusCode: 404, statusMessage: 'Rapporten är borttagen.' }); }
  return row;
}
export async function refreshMissionReports(workspaceId?: string) {
  if (process.env.MISSION_REPORTS_ENABLED === 'false') return;
  const rows = await db.select().from(missions).where(and(eq(missions.runtime, runtimeScope()), workspaceId ? eq(missions.workspaceId, workspaceId) : undefined, sql`${missions.reconciledAt} < now() - interval '15 seconds'`)).orderBy(missions.reconciledAt).limit(50);
  for (const row of rows) {
    try {
      const fresh = await reconcileMission(row.userId, row.workspaceId, row.id);
      if (process.env.MISSION_AUTOMATIC_REPORTS !== 'false' && fresh.config.automaticReports && fresh.dirtySince && (Date.now() - fresh.updatedAt.getTime() >= 60000 || Date.now() - fresh.dirtySince.getTime() >= 300000)) await requestMissionReport(row.userId, row.workspaceId, row.id);
    } catch { console.warn('[mission] Reconciliation deferred', { missionId: row.id }); }
    finally { await db.update(missions).set({ reconciledAt: new Date() }).where(eq(missions.id, row.id)); }
  }
  return rows.length > 0;
}
export async function processMissionReport() {
  if (process.env.MISSION_REPORTS_ENABLED === 'false') return;
  const job = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mission-report-queue:${runtimeScope()}`}, 0))`);
    const rows = await tx.select({ report: missionReports, mission: missions, snapshot: missionSnapshots }).from(missionReports).innerJoin(missions, eq(missions.id, missionReports.missionId)).innerJoin(missionSnapshots, eq(missionSnapshots.id, missionReports.snapshotId)).where(and(eq(missions.runtime, runtimeScope()), inArray(missionReports.status, ['queued', 'running']))).orderBy(missionReports.createdAt);
    if (rows.some(r => r.report.status === 'running' && r.report.leaseUntil && r.report.leaseUntil.getTime() > Date.now())) return;
    for (const row of rows) {
      if (row.report.attempts >= 3) { await tx.update(missionReports).set({ status: 'failed', error: 'Klara kunde inte skriva rapporten efter tre försök.', finishedAt: new Date(), leaseToken: null, leaseUntil: null }).where(eq(missionReports.id, row.report.id)); continue; }
      if (row.report.nextAttemptAt.getTime() > Date.now()) continue;
      const [report] = await tx.update(missionReports).set({ status: 'running', phase: 'Granskar och skriver', attempts: row.report.attempts + 1, leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 240000) }).where(eq(missionReports.id, row.report.id)).returning();
      return { ...row, report: report! };
    }
  });
  if (!job) return;
  const startedAt = Date.now();
  const owned = and(eq(missionReports.id, job.report.id), eq(missionReports.leaseToken, job.report.leaseToken!));
  try {
    await requireWorkspace(job.mission.userId, job.mission.workspaceId);
    const snapshot = structuredClone(job.snapshot.input);
    const readIds = new Set<string>();
    const receipts: typeof job.report.readReceipts = [];
    const readCache = new Map<string, EvidenceRead>();
    const signal = AbortSignal.timeout(150000);
    let imageBytes = 0, images = 0;
    const evidence = snapshot.tasks.flatMap(t => t.sources.flatMap(s => s.evidence));
    const read = async (id: string): Promise<EvidenceRead> => {
      if (readCache.has(id)) return readCache.get(id)!;
      const ref = evidence.find(e => e.id === id);
      if (!ref) return { id, unavailable: true };
      let value = await readMissionEvidence(snapshot.workspaceId, ref, signal);
      if (value.image) { imageBytes += Buffer.byteLength(value.image.data, 'base64'); images++; if (images > 6 || imageBytes > 12 * 1024 * 1024) value = { id, unavailable: true, reason: 'Rapportens bildbudget är slut.' }; }
      if (value.unavailable) snapshot.gaps.push(`${ref.title}: ${value.reason ?? 'Underlag otillgängligt.'}`);
      else {
        if (value.text || value.image) readIds.add(id);
        receipts.push({ id, version: ref.version, hash: ref.hash, digest: value.digest ?? ref.hash, limited: !!value.limited, readAt: new Date().toISOString() });
        if (value.limited) snapshot.gaps.push(`${ref.title}: endast ett begränsat utdrag lästes.`);
      }
      readCache.set(id, value); return value;
    };
    const hasIndependentText = evidence.some(e => !e.unavailable && e.origin !== 'agent' && (e.excerpt || e.itemId));
    const generated = hasIndependentText ? await writeMissionReport(snapshot, read, signal) : null;
    const draft = generated ? validateReport(snapshot, generated.draft, readIds) : reportDraftSchema.parse({
      summary: 'Uppdragets registrerade arbete är sammanställt. Det saknas läsbart oberoende underlag för en fullständig granskning.',
      findings: snapshot.config.criteria.map(c => ({ criterionId: c.id, verdict: 'needs_evidence', conclusion: `${c.text}: behöver kompletteras med läsbart underlag.`, evidenceIds: [], nextStep: 'Koppla observationer och underlag från deluppgifterna och beställ en ny rapport.' })), limitations: ['Ingen modellbedömning gjordes eftersom läsbart oberoende underlag saknas.'],
    });
    const redact = await missionRedactor(db, snapshot.workspaceId);
    draft.summary = redact(draft.summary); draft.limitations = draft.limitations.map(redact);
    for (const finding of draft.findings) { finding.conclusion = redact(finding.conclusion); finding.nextStep = redact(finding.nextStep); }
    const document = assembleReport(snapshot, draft, readIds);
    await db.update(missionReports).set({ phase: 'Sparar rapport', readReceipts: receipts, usage: { ...(generated?.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, steps: 0 }), durationMs: Date.now() - startedAt, queueMs: Math.max(0, startedAt - job.report.createdAt.getTime()) } }).where(owned);
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mission:${job.mission.id}`}, 0))`);
      const [current] = await tx.select().from(missionReports).where(owned);
      if (!current || current.leaseUntil!.getTime() <= Date.now()) return;
      for (const ref of evidence.filter(e => e.itemId && readIds.has(e.id))) {
        const source = await missionItemEvidence(tx, snapshot.workspaceId, ref.itemId!);
        if (source.unavailable || source.version !== ref.version || source.hash !== ref.hash) throw new Error('Evidence changed during review');
      }
      const blocks: import('../../shared/workspace').DocumentBlock[] = [ { kind: 'heading', text: document.title }, { kind: 'text', text: document.summary }, ...document.metrics.map(m => ({ kind: 'chart' as const, chartType: 'bar' as const, title: m.label, data: m.data })), { kind: 'table', columns: ['Kriterium', 'Bedömning', 'Slutsats', 'Nästa steg'], rows: document.findings.map(f => [snapshot.config.criteria.find(c => c.id === f.criterionId)!.text, f.verdict, f.conclusion, f.nextStep]) }, { kind: 'text', text: document.limitations.join('\n\n') } ];
      const item = await saveItem(job.mission.userId, job.mission.workspaceId, { title: `${document.title} · Klaras rapport`, content: { kind: 'text', text: '', blocks }, threadId: job.mission.threadId }, tx);
      await tx.update(missionReports).set({ document, readIds: [...readIds], itemId: item.id, status: 'completed', phase: 'Rapport klar', model: hasIndependentText ? 'glm-5.3-flash' : 'deterministic-rules', error: null, finishedAt: new Date(), leaseToken: null, leaseUntil: null }).where(owned);
    });
  } catch (error) {
    const knownErrors = ['Report must cover every original criterion', 'Unread report citation', 'Evidence belongs to another criterion', 'Supported conclusion requires read evidence', 'Supported conclusion requires independent evidence', 'Evidence changed during review', 'Report model not configured', 'Mission overview exceeds context budget', 'Evidence read limit reached'];
    const diagnostic = process.env.NODE_ENV === 'development' && error instanceof Error ? (await missionRedactor(db, job.mission.workspaceId))(error.message).slice(0, 500) : undefined;
    console.warn('[mission-report] Attempt failed', { id: job.report.id, type: error instanceof Error ? error.name : 'unknown', reason: error instanceof Error && knownErrors.includes(error.message) ? error.message : 'generation_or_storage_error', diagnostic });
    await db.update(missionReports).set({ status: job.report.attempts >= 3 ? 'failed' : 'queued', finishedAt: job.report.attempts >= 3 ? new Date() : null, error: 'Rapporten kunde inte slutföras. Underlaget är sparat.', leaseToken: null, leaseUntil: null, nextAttemptAt: new Date(Date.now() + 30000) }).where(owned);
  }
}
export async function notifyMissionReports() {
  const rows = await db.select({ report: missionReports, mission: missions, snapshot: missionSnapshots }).from(missionReports).innerJoin(missions, eq(missions.id, missionReports.missionId)).innerJoin(missionSnapshots, eq(missionSnapshots.id, missionReports.snapshotId)).where(and(eq(missions.runtime, runtimeScope()), eq(missionReports.status, 'completed'), eq(missionReports.notification, 'pending'))).orderBy(desc(missionReports.createdAt)).limit(10);
  for (const row of rows) {
    const [claim] = await db.update(missionReports).set({ notification: 'sending' }).where(and(eq(missionReports.id, row.report.id), eq(missionReports.notification, 'pending'))).returning();
    if (!claim) continue;
    try {
      const thread = await getThreadForUser(row.mission.userId, row.mission.threadId);
      if (!thread?.sessionId || thread.workspaceId !== row.mission.workspaceId) throw new Error('No parent');
      const response = await fetch(`${appOrigin()}/workers/mission-report/notify`, { method: 'POST', headers: internalHeaders(), signal: AbortSignal.timeout(15000), body: JSON.stringify({ parentSessionId: thread.sessionId, userId: row.mission.userId, threadId: thread.id, reportId: row.report.id, workspaceId: row.mission.workspaceId, summary: redactReportText(row.report.document?.summary ?? ''), stale: row.snapshot.revision !== row.mission.revision }) });
      const receipt = response.headers.get('content-type')?.includes('application/json') ? await response.json() as { ok?: boolean } : null;
      await db.update(missionReports).set({ notification: response.ok && receipt?.ok === true ? 'sent' : 'unknown' }).where(eq(missionReports.id, claim.id));
    } catch { await db.update(missionReports).set({ notification: 'unknown' }).where(eq(missionReports.id, claim.id)); }
  }
}
