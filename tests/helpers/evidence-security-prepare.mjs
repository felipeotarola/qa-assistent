// Fixture preparation only. No provider, browser or natural-intake proof.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { and, eq, inArray } from 'drizzle-orm';
import { fingerprint, sha256 } from './evidence-acceptance.mjs';
import { SECURITY_PROTOCOL, validateEvidenceSecurityManifest } from './evidence-security.mjs';
export const SECURITY_PREPARATION_PROTOCOL = 'syna-security-report-preparation-v1';

export function securityManifestFromPreparation({ artifact, artifactPath, artifactBytes, requesterAccountFile, ownerAccountFile, sourceHash }) {
  assert.equal(artifact.protocol, SECURITY_PREPARATION_PROTOCOL); assert.equal(artifact.preparation, 'synthetic-golden');
  assert.equal(artifact.realProviderCalls, 0); assert.equal(artifact.realBrowserActions, 0); assert.ok(artifact.completedAt && !artifact.preparationFailed);
  assert.equal(fingerprint(JSON.parse(artifactBytes)), fingerprint(artifact), 'Preparation bytes must match the locked receipt');
  return validateEvidenceSecurityManifest({ protocol: SECURITY_PROTOCOL, taskId: 'SEC-08', variant: 'owner-runtime-anonymous-contract', sourceHash,
    runtime: artifact.runtime, preparation: 'synthetic-golden', trials: artifact.trials.map(t => {
      assert.equal(t.state, 'prepared');
      return { requesterAccountFile, ownerAccountFile, requesterId: artifact.requesterId, ownerId: artifact.ownerId,
        allowed: t.allowed, private: t.private, foreignRuntime: t.foreignRuntime, originArtifacts: [{ path: artifactPath, sha256: sha256(artifactBytes) }] };
    }) });
}

/** Requires two already existing ordinary isolated accounts and an exclusive
 * stopped-runtime window. Creates fresh reports through authored mission/report
 * services using the no-evidence deterministic path. Historical rows are never
 * rewritten. The artifact does not claim prior Iris or model-generated work. */
export async function prepareSecurityEvidence({ app, requesterId, ownerId, runtime, repetitions = 3, assertExclusive, onProgress = async () => {} }) {
  assert.equal(process.env.PAT_RUNTIME_SCOPE, runtime); assert.match(runtime, /^autonomy-test:[a-z0-9-]+$/);
  assert.equal(process.env.GRUNDEN_API_TOKEN, ''); assert.notEqual(requesterId, ownerId); assert.equal(typeof assertExclusive, 'function');
  assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 5);
  const { db, schema } = app;
  for (const id of [requesterId, ownerId]) assert.ok((await db.select().from(schema.user).where(eq(schema.user.id, id)))[0], 'Existing ordinary isolated account required');
  await assertExclusive();
  const foreignRuntime = `${runtime}-security-${randomUUID()}`, previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Security fixture preparation forbids every HTTP/model call'); };
  const artifact = { protocol: SECURITY_PREPARATION_PROTOCOL, preparation: 'synthetic-golden', runtime, requesterId, ownerId,
    realProviderCalls: 0, realBrowserActions: 0, reportMethod: 'authored deterministic no-evidence report worker; synthetic private marker only',
    startedAt: new Date().toISOString(), authoringHashes: {}, trials: [] };
  try {
    const { missionAction, requestMissionReport } = await import('../../server/utils/missions.ts');
    const { processMissionReport } = await import('../../server/utils/mission-reports.ts');
    for (const path of ['tests/helpers/evidence-security-prepare.mjs', 'server/utils/missions.ts', 'server/utils/mission-reports.ts', 'shared/mission-report.ts']) artifact.authoringHashes[path] = sha256(await readFile(path));
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      const trial = { repetition, state: 'preparing' }; artifact.trials.push(trial); await onProgress(artifact);
      for (const kind of ['allowed', 'private', 'foreignRuntime']) {
        await assertExclusive(); process.env.PAT_RUNTIME_SCOPE = kind === 'foreignRuntime' ? foreignRuntime : runtime;
        const active = await db.select({ id: schema.missionReports.id }).from(schema.missionReports).innerJoin(schema.missions, eq(schema.missions.id, schema.missionReports.missionId))
          .where(and(eq(schema.missions.runtime, process.env.PAT_RUNTIME_SCOPE), inArray(schema.missionReports.status, ['queued', 'running'])));
        assert.equal(active.length, 0, 'Never drive another report while preparing security data');
        const userId = kind === 'private' ? ownerId : requesterId, workspaceId = randomUUID(), threadId = randomUUID(), marker = `evidence-owner-marker-${randomUUID().replaceAll('-', '')}`;
        trial.preparingReference = { kind, workspaceId, threadId, runtime: process.env.PAT_RUNTIME_SCOPE }; await onProgress(artifact);
        await db.insert(schema.workspaces).values({ id: workspaceId, userId, name: `SYNTHETIC SECURITY FIXTURE ${kind} ${repetition}` });
        await db.insert(schema.threads).values({ id: threadId, userId, workspaceId, title: 'SYNTHETIC SECURITY FIXTURE' });
        const config = { title: `SYNTHETIC SECURITY FIXTURE ${marker}`, goal: 'Synthetic private report used only to test read isolation. No browser or model execution claimed.',
          scope: 'Harmless synthetic marker only.', criteria: [{ id: 'marker', text: 'No product verification claimed.' }], target: null, caseKeys: [], automaticReports: false };
        const created = await missionAction(userId, workspaceId, threadId, { action: 'create', requestId: randomUUID(), config });
        await missionAction(userId, workspaceId, threadId, { action: 'update', missionId: created.id, expectedRevision: created.revision, config, status: 'closed', reason: 'Synthetic fixture preparation only.' });
        const queued = await requestMissionReport(userId, workspaceId, created.id); assert.ok(queued.reportId);
        // Prevent legacy chat wakeups if this explicit preparation is interrupted.
        await db.update(schema.missionReports).set({ notification: 'recorded' }).where(eq(schema.missionReports.id, queued.reportId));
        await processMissionReport();
        const [report] = await db.select().from(schema.missionReports).where(eq(schema.missionReports.id, queued.reportId));
        assert.equal(report?.status, 'completed'); assert.equal(report.model, 'deterministic-rules'); assert.ok(report.itemId && report.document);
        assert.ok(JSON.stringify(report.document).includes(marker)); assert.equal(report.usage.totalTokens, 0);
        trial[kind] = { workspaceId, reportId: report.id, runtime: process.env.PAT_RUNTIME_SCOPE, documentHash: fingerprint(report.document), marker };
        await onProgress(artifact);
      }
      delete trial.preparingReference; trial.state = 'prepared'; await onProgress(artifact);
    }
    for (const [path, hash] of Object.entries(artifact.authoringHashes)) assert.equal(sha256(await readFile(path)), hash, 'Preparation code changed during writes');
    process.env.PAT_RUNTIME_SCOPE = runtime; await assertExclusive(); artifact.completedAt = new Date().toISOString(); await onProgress(artifact); return artifact;
  } catch (error) { artifact.preparationFailed = true; await onProgress(artifact); throw error; }
  finally { process.env.PAT_RUNTIME_SCOPE = runtime; globalThis.fetch = previousFetch; }
}
