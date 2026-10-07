import { criterionEvidenceScope } from '../../shared/mission-regression';
import { randomUUID } from 'node:crypto';
import { and, eq, sql, inArray, desc } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { missions, missionReports, missionSnapshots } from '../db/schema/missions';
import { runtimeScope } from '../../shared/runtime-scope';
import { MISSION_REPORT_VERSION, REPORT_POLICY_ERROR, hasCurrentReportPolicy, independentMissionEvidence, reportDraftSchema, assembleReport, validateReport, reportObservationText, reviewedReportChecks } from '../../shared/mission-report';
import { redactReportText, type WorkResult, type MissionSnapshot, type EvidenceRef } from '../../shared/mission';
import { evidenceApplicability } from '../../shared/evidence-rules';
import { REVIEWER_VERSION, REVIEW_MODEL } from '../../shared/result-assessment';
import type { ReportDraft } from '../../shared/mission-report';
import { writeMissionReport } from '../../agent/lib/mission-reporter';
import { missionHash, missionItemEvidence, readMissionSource } from './mission-sources';
import { readMissionEvidence, type EvidenceRead } from './mission-evidence';
import { missionRedactor } from './mission-redaction';
import { reviewFailureDiagnostic as structuredOutputFailureDiagnostic } from './result-review-diagnostic';
import { currentMissionDelivery, reconcileMission, requestMissionReport } from './missions';
import { requireWorkspace, saveItem, type WorkspaceDatabase } from './workspaces';
import { appOrigin, internalHeaders } from '../../agent/lib/internal-api';
import { getThreadForUser } from './threads';
import { queueExecution, beginQueueModel, settleQueueModel, type QueueModelCall } from './mission-review-admission';

/** Revalidate the prior checkpoint review without putting all its images into
 * the report model's context. Called under the workspace content lock. Blob
 * availability is a point-in-time check; external object deletion is not an
 * atomic database operation. Consumed bytes are discarded after hashing. */
async function verifyReviewedDeliveries(connection: WorkspaceDatabase, snapshot: MissionSnapshot, draft: ReportDraft, reads: ReadonlyMap<string, EvidenceRead>) {
  const signal = AbortSignal.timeout(60000);
  // A substantiated contradiction can finish QA, but cannot conceal missing
  // mandatory checkpoints behind a previously complete frozen projection.
  const supported = draft.findings.filter(finding => {
    const delivery = snapshot.config.criteria.find(criterion => criterion.id === finding.criterionId)?.delivery;
    return finding.verdict !== 'needs_evidence' && snapshot.delivery?.criteria.find(criterion => criterion.criterionId === finding.criterionId)?.complete
      && (delivery?.kind === 'regression_comparison' || delivery?.kind === 'test_cases' || delivery?.kind === 'source' && delivery.sourceTypes.includes('test'));
  });
  const reviewed = reviewedReportChecks(snapshot, reads);
  if (!supported.length && !reviewed.size) return;
  const latest = await currentMissionDelivery(connection, snapshot.missionId);
  const scope = (config: MissionSnapshot['config']) => ({ target: config.target, criteria: config.criteria, caseKeys: config.caseKeys });
  if (missionHash(scope(latest.config)) !== missionHash(scope(snapshot.config))) throw new Error('Reviewed delivery changed during report');
  const checkedRuns = new Set<string>();
  let files = 0, bytes = 0;
  const currentSources = new Map<string, WorkResult>();
  const currentSource = async (runId: string) => {
    let current = currentSources.get(runId);
    if (!current) {
      current = await readMissionSource(connection, snapshot.workspaceId, 'test', runId);
      currentSources.set(runId, current);
    }
    return current;
  };
  // Cache physical reads, never scope eligibility. Every consumer below still
  // checks its own source fingerprint, digest and target/provenance rules.
  const proofReads = new Map<string, EvidenceRead>();
  const readProof = async (runId: string, ref: EvidenceRef) => {
    const key = JSON.stringify([runId, ref.id, ref.hash]);
    const cached = proofReads.get(key);
    if (cached) return cached;
    if (ref.itemId) {
      const [item] = await connection.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.id, ref.itemId), eq(schema.workspaceItems.workspaceId, snapshot.workspaceId)));
      if (item?.content.kind === 'file' || item?.content.kind === 'image') { files++; bytes += item.content.size; }
      if (files > 200 || bytes > 64 * 1024 * 1024) throw new Error('Reviewed delivery verification budget exceeded');
    }
    signal.throwIfAborted();
    const read = await readMissionEvidence(snapshot.workspaceId, ref, signal);
    signal.throwIfAborted();
    proofReads.set(key, read);
    return read;
  };
  // A partial report can also display current saved review rows. Bind their
  // status/fingerprint and every cited byte again before committing metadata.
  for (const row of reviewed.values()) {
    signal.throwIfAborted();
    const frozen = row.source;
    if (row.criterionIds.some(id => !criterionEvidenceScope(latest, id, frozen).allowed)) throw new Error('Reviewed delivery changed during report');
    const current = await currentSource(frozen.sourceId);
    if (current.status !== 'completed' || current.assessment?.status !== 'completed' || !current.assessment.finishedAt || current.assessment.stale
      || current.sourceRevision !== frozen.sourceRevision || missionHash(current.assessment) !== missionHash(frozen.assessment)
      || missionHash(current.claims) !== missionHash(frozen.claims)) throw new Error('Reviewed delivery changed during report');
    for (const id of row.evidenceIds) {
      const ref = frozen.evidence.find(e => e.id === id)!, fresh = current.evidence.find(e => e.id === id);
      if (!fresh || fresh.unavailable || fresh.hash !== ref.hash || fresh.version !== ref.version) throw new Error('Reviewed delivery proof unavailable');
      const read = await readProof(frozen.sourceId, ref);
      if (read.unavailable || read.limited || !(read.text || read.image) || read.digest !== reads.get(id)?.digest) throw new Error('Reviewed delivery proof unavailable');
    }
  }
  for (const finding of supported) {
    const delivery = snapshot.config.criteria.find(criterion => criterion.id === finding.criterionId)?.delivery;
    if (!delivery) continue;
    if (!latest.delivery.criteria.find(criterion => criterion.criterionId === finding.criterionId)?.complete) throw new Error('Reviewed delivery changed during report');
    const runIds: string[] = [];
    if (delivery.kind === 'test_cases') for (const caseKey of delivery.caseKeys) {
      const runId = snapshot.delivery?.cases.find(test => test.caseKey === caseKey)?.runId;
      if (!runId || latest.delivery.cases.find(test => test.caseKey === caseKey)?.runId !== runId) throw new Error('Reviewed delivery changed during report');
      runIds.push(runId);
    }
    else if (delivery.kind === 'regression_comparison') {
      const current = snapshot.delivery?.cases.find(test => test.caseKey === delivery.caseKey)?.runId;
      if (!delivery.baseline || !current || latest.delivery.cases.find(test => test.caseKey === delivery.caseKey)?.runId !== current) throw new Error('Reviewed delivery changed during report');
      runIds.push(delivery.baseline.runId, current);
    } else {
      const exactRefs = delivery.sourceRefs?.filter(ref => ref.type === 'test') ?? [];
      runIds.push(...(exactRefs.length ? exactRefs.map(ref => ref.id) : snapshot.tasks.filter(task => task.criterionIds.includes(finding.criterionId))
        .flatMap(task => task.sources.filter(source => source.sourceType === 'test').map(source => source.sourceId))));
      if (!runIds.length) throw new Error('Reviewed delivery changed during report');
    }
    for (const runId of new Set(runIds)) {
      signal.throwIfAborted();
      const frozen = snapshot.tasks.filter(task => task.criterionIds.includes(finding.criterionId)).flatMap(task => task.sources).find(source => source.sourceType === 'test' && source.sourceId === runId);
      const scope = frozen ? criterionEvidenceScope(snapshot, finding.criterionId, frozen) : null;
      if (!scope?.allowed) throw new Error('Reviewed delivery changed during report');
      const checkKey = missionHash({ runId, target: scope.target });
      const review = frozen?.assessment;
      if (!frozen || !review?.id || !review.sourceHash || review.stale || review.verdict !== 'supported' || review.reviewerVersion !== REVIEWER_VERSION || !frozen.claims?.length) throw new Error('Reviewed delivery changed during report');
      const current = await currentSource(runId);
      if (current.status !== 'completed' || current.sourceRevision !== frozen.sourceRevision || current.assessment?.stale || current.assessment?.id !== review.id || current.assessment.sourceHash !== review.sourceHash || current.assessment.reviewerVersion !== review.reviewerVersion || current.assessment.verdict !== 'supported' || missionHash(current.claims) !== missionHash(frozen.claims) || missionHash(current.assessment) !== missionHash(review)) throw new Error('Reviewed delivery changed during report');
      if (checkedRuns.has(checkKey)) continue;
      checkedRuns.add(checkKey);
      const verify = async (ref: EvidenceRef) => {
        const latest = current.evidence.find(evidence => evidence.id === ref.id);
        if (!latest || latest.unavailable || latest.version !== ref.version || latest.hash !== ref.hash || !independentMissionEvidence(frozen, ref, scope.target)) return false;
        const read = await readProof(runId, ref);
        const eligible = !!(read.text || read.image) && evidenceApplicability({ schemaVersion: frozen.schemaVersion, sourceType: 'test', sourceId: runId, target: frozen.target, expectedTarget: scope.target, startedAt: frozen.startedAt, finishedAt: frozen.finishedAt }, {
          ...ref, requiresDigest: ref.kind === 'image', digest: read.digest,
          readStatus: read.unavailable ? 'unavailable' : read.limited ? 'limited' : 'read',
        }).eligible;
        return eligible;
      };
      for (const claim of frozen.claims) {
        const findings = review.findings?.filter(finding => finding.requirementId === claim.id) ?? [];
        if (findings.length !== 1 || findings[0]!.verdict !== 'supported') throw new Error('Reviewed delivery changed during report');
        let supported = false;
        for (const id of findings[0]!.evidenceIds) {
          const ref = frozen.evidence.find(evidence => evidence.id === id || evidence.itemId === id);
          if (ref && await verify(ref)) { supported = true; break; }
        }
        if (!supported) throw new Error('Reviewed delivery proof unavailable');
      }
    }
  }
}

async function requireCurrentReportPolicy(connection: WorkspaceDatabase, reportId: string, snapshotId: string) {
  const [row] = await connection.select({ version: missionReports.version, input: missionSnapshots.input }).from(missionReports)
    .innerJoin(missionSnapshots, eq(missionReports.snapshotId, missionSnapshots.id))
    .where(and(eq(missionReports.id, reportId), eq(missionSnapshots.id, snapshotId)));
  if (!row || !hasCurrentReportPolicy(row.version, row.input)) throw new Error(REPORT_POLICY_ERROR);
}

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
  // Autonomous missions are reconciled by their controller. Selecting them
  // here would compete for its mission lock even without generating a report.
  const rows = await db.select().from(missions).where(and(eq(missions.runtime, runtimeScope()), sql`${missions.controllerVersion} is distinct from 1`, workspaceId ? eq(missions.workspaceId, workspaceId) : undefined, sql`${missions.reconciledAt} < now() - interval '15 seconds'`)).orderBy(missions.reconciledAt).limit(50);
  for (const row of rows) {
    try {
      const fresh = await reconcileMission(row.userId, row.workspaceId, row.id);
      if (fresh.controllerVersion !== 1 && process.env.MISSION_AUTOMATIC_REPORTS !== 'false' && fresh.config.automaticReports && fresh.dirtySince && (Date.now() - fresh.updatedAt.getTime() >= 60000 || Date.now() - fresh.dirtySince.getTime() >= 300000)) await requestMissionReport(row.userId, row.workspaceId, row.id);
    } catch { console.warn('[mission] Reconciliation deferred', { missionId: row.id }); }
    finally { await db.update(missions).set({ reconciledAt: new Date() }).where(eq(missions.id, row.id)); }
  }
  return rows.length > 0;
}
export async function processMissionReport() {
  if (process.env.MISSION_REPORTS_ENABLED === 'false') return;
  const outdatedMissions = new Map<string, { userId: string; workspaceId: string }>();
  const job = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mission-report-queue:${runtimeScope()}`}, 0))`);
    const rows = await tx.select({ report: missionReports, mission: missions, snapshot: missionSnapshots }).from(missionReports).innerJoin(missions, eq(missions.id, missionReports.missionId)).innerJoin(missionSnapshots, eq(missionSnapshots.id, missionReports.snapshotId)).where(and(eq(missions.runtime, runtimeScope()), inArray(missionReports.status, ['queued', 'running']))).orderBy(missionReports.createdAt);
    const current = rows.filter(r => hasCurrentReportPolicy(r.report.version, r.snapshot.input));
    for (const old of rows.filter(r => !current.includes(r))) {
      await tx.update(missionReports).set({ status: 'failed', phase: 'Bevispolicy uppdaterad', error: REPORT_POLICY_ERROR, finishedAt: new Date(), leaseToken: null, leaseUntil: null }).where(eq(missionReports.id, old.report.id));
      await tx.update(missions).set({ dirtySince: new Date(), reconciledAt: new Date(0) }).where(eq(missions.id, old.mission.id));
      if (old.mission.controllerVersion !== 1) outdatedMissions.set(old.mission.id, { userId: old.mission.userId, workspaceId: old.mission.workspaceId });
    }
    if (current.some(r => r.report.status === 'running' && r.report.leaseUntil && r.report.leaseUntil.getTime() > Date.now())) return;
    for (const row of current) {
      if (row.report.nextAttemptAt.getTime() > Date.now()) continue;
      const execution = await queueExecution(tx, 'report', row.report.id);
      if (execution.status === 'deferred') continue;
      if (execution.status === 'obsolete' || execution.status === 'legacy' && row.report.attempts >= 3 || execution.status === 'allowed' && execution.reportPurpose === 'interim' && row.report.attempts >= 1) {
        await tx.update(missionReports).set({ status: 'failed', error: execution.status === 'obsolete' ? execution.reason : 'Klara kunde inte skriva rapporten efter tre försök.', finishedAt: new Date(), leaseToken: null, leaseUntil: null }).where(eq(missionReports.id, row.report.id)); continue;
      }
      const [report] = await tx.update(missionReports).set({ status: 'running', phase: 'Granskar och skriver', attempts: row.report.attempts + 1, leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 240000) }).where(eq(missionReports.id, row.report.id)).returning();
      return { ...row, report: report! };
    }
  });
  for (const [missionId, owner] of outdatedMissions) await requestMissionReport(owner.userId, owner.workspaceId, missionId);
  if (!job) return;
  const startedAt = Date.now();
  const owned = and(eq(missionReports.id, job.report.id), eq(missionReports.leaseToken, job.report.leaseToken!));
  const liveOwned = and(owned, eq(missionReports.version, MISSION_REPORT_VERSION), sql`${missionReports.leaseUntil} at time zone 'UTC' > clock_timestamp()`);
  let modelCall: QueueModelCall | null = null, modelUsage: { tokens: number | null; durationMs: number; toolCalls?: number; provider?: import('../../shared/provider-usage').ProviderUsage } | null = null, denied = false, deferred = false, maxToolCalls = 24, maxTokens = 100000, denialReason = '';
  const receipts: typeof job.report.readReceipts = [];
  try {
    await requireWorkspace(job.mission.userId, job.mission.workspaceId);
    const snapshot = structuredClone(job.snapshot.input);
    const readIds = new Set<string>();
    const readCache = new Map<string, EvidenceRead>();
    let signal = AbortSignal.timeout(150000);
    let imageBytes = 0, images = 0;
    const evidence = snapshot.tasks.flatMap(t => t.sources.flatMap(s => s.evidence));
    const read = async (id: string): Promise<EvidenceRead> => {
      if (readCache.has(id)) return readCache.get(id)!;
      const ref = evidence.find(e => e.id === id);
      if (!ref) return { id, unavailable: true };
      let value = await readMissionEvidence(snapshot.workspaceId, ref, signal);
      if (value.image) { imageBytes += Buffer.byteLength(value.image.data, 'base64'); images++; if (images > 6 || imageBytes > 12 * 1024 * 1024) value = { id, unavailable: true, reason: 'Rapportens bildbudget är slut.' }; }
      if (value.unavailable) { ref.unavailable = true; snapshot.gaps.push(`${ref.title}: ${value.reason ?? 'Underlag otillgängligt.'}`); }
      else {
        if (!value.limited && (value.text || value.image)) readIds.add(id);
        receipts.push({ id, version: ref.version, hash: ref.hash, digest: value.digest ?? ref.hash, limited: !!value.limited, readAt: new Date().toISOString() });
        if (value.limited) snapshot.gaps.push(`${ref.title}: endast ett begränsat utdrag lästes.`);
      }
      readCache.set(id, value); return value;
    };
    const hasIndependentText = snapshot.tasks.some(t => t.sources.some(s => s.evidence.some(e => independentMissionEvidence(s, e) && (e.excerpt || e.itemId))));
    if (hasIndependentText) {
      const admission = await beginQueueModel('report', job.report.id, job.report.attempts, job.report.leaseToken!);
      if (admission.execution.status === 'deferred' || admission.execution.status === 'obsolete') {
        denied = true; deferred = admission.execution.status === 'deferred'; denialReason = admission.execution.reason; throw new Error(denialReason);
      }
      modelCall = admission.call;
      if (admission.execution.status === 'allowed') {
        signal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, admission.execution.deadlineAt.getTime() - Date.now()))]);
        maxToolCalls = admission.execution.remainingToolCalls;
        maxTokens = admission.execution.remainingTokens;
      }
    }
    const beforeModel = () => db.transaction(async tx => {
      const admission = await queueExecution(tx, 'report', job.report.id);
      if (admission.status === 'deferred' || admission.status === 'obsolete') { denied = true; deferred = admission.status === 'deferred'; denialReason = admission.reason; throw new Error(denialReason); }
      if (modelCall && (admission.status !== 'allowed' || admission.attemptId !== modelCall.execution.attemptId)) { denied = true; denialReason = 'Rapporten är bunden till ett annat körförsök.'; throw new Error(denialReason); }
      const [current] = await tx.select({ id: missionReports.id }).from(missionReports).where(liveOwned);
      if (!current) { denied = true; denialReason = 'Rapportens kölease är inte längre aktuell.'; throw new Error(denialReason); }
      await requireCurrentReportPolicy(tx, job.report.id, job.report.snapshotId);
    });
    const generated = hasIndependentText ? await writeMissionReport(snapshot, read, signal, { maxToolCalls, maxTokens, beforeModel,
      onUsage: (provider, toolCalls) => { modelUsage = { tokens: provider.totalTokens, durationMs: Date.now() - startedAt, toolCalls, provider }; },
    }) : null;
    if (modelCall && generated) { modelUsage = { tokens: generated.usage.totalTokens, durationMs: Date.now() - startedAt, toolCalls: generated.usage.toolCalls ?? 0, provider: generated.usage.provider }; await settleQueueModel(modelCall, modelUsage); }
    const draft = generated ? validateReport(snapshot, generated.draft, readIds, readCache) : reportDraftSchema.parse({
      summary: 'Uppdragets registrerade arbete är sammanställt. Inget tillämpligt oberoende underlag valdes för granskning.',
      findings: snapshot.config.criteria.map(c => ({ criterionId: c.id, verdict: 'needs_evidence', conclusion: `${c.text}: kan inte bedömas som underbyggt utifrån rapportens tillämpliga underlag.`, evidenceIds: [], nextStep: 'Koppla observationer och underlag från deluppgifterna och beställ en ny rapport.' })), limitations: ['Ingen modellbedömning eller läsning av underlag gjordes i detta rapportsteg.'],
    });
    const redact = await missionRedactor(db, snapshot.workspaceId);
    draft.summary = redact(draft.summary); draft.limitations = draft.limitations.map(redact);
    for (const finding of draft.findings) { finding.conclusion = redact(finding.conclusion); finding.nextStep = redact(finding.nextStep); }
    const document = assembleReport(snapshot, draft, readIds, readCache, redact);
    await db.update(missionReports).set({ phase: 'Sparar rapport', readReceipts: receipts, usage: { ...(generated?.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, steps: 0 }), durationMs: Date.now() - startedAt, queueMs: Math.max(0, startedAt - job.report.createdAt.getTime()) } }).where(liveOwned);
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mission:${job.mission.id}`}, 0))`);
      // Serialize with edits/deletion before checking source identities, not
      // only later when saveItem persists the report itself.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${snapshot.workspaceId}`}, 0))`);
      const admission = await queueExecution(tx, 'report', job.report.id);
      if (admission.status === 'deferred' || admission.status === 'obsolete') { denied = true; deferred = admission.status === 'deferred'; denialReason = admission.reason; throw new Error(denialReason); }
      const finalOwned = admission.status === 'allowed' ? and(liveOwned, sql`${admission.deadlineAt.toISOString()}::timestamptz > clock_timestamp()`) : liveOwned;
      const [current] = await tx.select().from(missionReports).where(finalOwned).for('update');
      if (!current) return;
      await requireCurrentReportPolicy(tx, job.report.id, job.report.snapshotId);
      await verifyReviewedDeliveries(tx, snapshot, draft, readCache);
      for (const ref of evidence.filter(e => e.itemId && readIds.has(e.id))) {
        const source = await missionItemEvidence(tx, snapshot.workspaceId, ref.itemId!);
        if (source.unavailable || source.version !== ref.version || source.hash !== ref.hash) throw new Error('Evidence changed during review');
      }
      const blocks: import('../../shared/workspace').DocumentBlock[] = [ { kind: 'heading', text: document.title }, { kind: 'text', text: document.summary }, ...document.findings.flatMap(finding => finding.observations?.length ? [{ kind: 'heading' as const, text: document.criteria.find(criterion => criterion.id === finding.criterionId)?.text ?? 'Klaras observationer' }, ...finding.observations.map(observation => ({ kind: 'text' as const, text: `${observation.originLabel}\n${reportObservationText(observation)}\nUnderlag: ${observation.evidenceIds.join(', ')}` }))] : []), ...document.metrics.map(m => ({ kind: 'chart' as const, chartType: 'bar' as const, title: m.label, data: m.data })), { kind: 'table', columns: ['Kriterium', 'Bedömning', 'Slutsats', 'Nästa steg'], rows: document.findings.map(f => [snapshot.config.criteria.find(c => c.id === f.criterionId)!.text, f.verdict, f.conclusion, f.nextStep]) }, { kind: 'text', text: document.limitations.join('\n\n') } ];
      const item = await saveItem(job.mission.userId, job.mission.workspaceId, { title: `${document.title} · Klaras rapport`, content: { kind: 'text', text: '', blocks }, threadId: job.mission.threadId }, tx, { provenance: { version: 1, origin: 'agent', producer: 'agent-authored', observedAt: null } });
      const [completed] = await tx.update(missionReports).set({ document, readIds: [...readIds], itemId: item.id, status: 'completed', phase: 'Rapport klar', model: !generated || (generated.usage.provider?.providerCalls === 0 && generated.usage.provider.unknownCalls === 0) ? 'deterministic-rules' : REVIEW_MODEL, error: null, finishedAt: new Date(), leaseToken: null, leaseUntil: null }).where(finalOwned).returning({ id: missionReports.id });
      if (!completed) throw new Error('Report lease expired before persistence');
    });
  } catch (error) {
    if (error instanceof Error && error.message === REPORT_POLICY_ERROR) { denied = true; deferred = false; denialReason = REPORT_POLICY_ERROR; }
    if (modelCall) await settleQueueModel(modelCall, modelUsage);
    const knownErrors = [REPORT_POLICY_ERROR, 'Report must cover every original criterion', 'Unread report citation', 'Evidence belongs to another criterion', 'Conclusive finding requires read evidence', 'Conclusive finding requires independent evidence', 'Supported finding requires complete criterion delivery', 'Supported finding requires read independent evidence for every requested source type', 'Supported finding requires read independent evidence for every requested source', 'Supported finding requires read independent evidence for every selected run', 'Evidence changed during review', 'Reviewed delivery changed during report', 'Reviewed delivery proof unavailable', 'Reviewed delivery verification budget exceeded', 'Report model not configured', 'Mission overview exceeds context budget', 'Evidence read limit reached'];
    const diagnostic = process.env.NODE_ENV === 'development' && error instanceof Error ? (await missionRedactor(db, job.mission.workspaceId))(error.message).slice(0, 500) : undefined;
    console.warn('[mission-report] Attempt failed', { id: job.report.id, type: error instanceof Error ? error.name : 'unknown', reason: error instanceof Error && knownErrors.includes(error.message) ? error.message : 'generation_or_storage_error', structuredOutputDiagnostic: structuredOutputFailureDiagnostic(error), diagnostic });
    // Read-only report retries may reserve another finite physical invocation.
    // Unknown prior usage stays charged; the next admission decides whether
    // delivery budget/deadline still permits it. Queue leases fence one commit.
    const failed = job.snapshot.input.reportPurpose === 'interim' || denied && !deferred || job.report.attempts >= 3 && !modelCall;
    // Preserve this attempt's read/usage diagnostics even if draft validation
    // fails. The invocation ledger remains the aggregate source of truth; a
    // stale worker cannot overwrite its successor's receipts.
    const failedUsage = modelUsage as typeof modelUsage;
    const diagnostics = receipts.length || failedUsage ? { readReceipts: receipts, usage: failedUsage ? {
      inputTokens: failedUsage.provider?.inputTokens ?? null, outputTokens: failedUsage.provider?.outputTokens ?? null, totalTokens: failedUsage.tokens,
      steps: failedUsage.provider?.providerCalls ?? 0, durationMs: Date.now() - startedAt, queueMs: Math.max(0, startedAt - job.report.createdAt.getTime()),
    } : null } : {};
    await db.update(missionReports).set({ ...diagnostics, status: failed ? 'failed' : 'queued', finishedAt: failed ? new Date() : null, error: denialReason || (modelCall && modelUsage === null ? 'Modellanropets utfall eller förbrukning är okänd. Underlaget är sparat.' : 'Rapporten kunde inte slutföras. Underlaget är sparat.'), leaseToken: null, leaseUntil: null, nextAttemptAt: new Date(Date.now() + 30000) }).where(liveOwned);
  }
}
export async function notifyMissionReports() {
  const rows = await db.select({ report: missionReports, mission: missions, snapshot: missionSnapshots }).from(missionReports).innerJoin(missions, eq(missions.id, missionReports.missionId)).innerJoin(missionSnapshots, eq(missionSnapshots.id, missionReports.snapshotId)).where(and(eq(missions.runtime, runtimeScope()), eq(missionReports.status, 'completed'), eq(missionReports.notification, 'pending'))).orderBy(desc(missionReports.createdAt)).limit(10);
  for (const row of rows) {
    if (row.mission.controllerVersion === 1) {
      // The saved mission/report is the UI notification. Autonomous completion
      // must not wake V into an unrelated parent-chat continuation.
      await db.update(missionReports).set({ notification: 'recorded' }).where(and(eq(missionReports.id, row.report.id), eq(missionReports.notification, 'pending')));
      continue;
    }
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
