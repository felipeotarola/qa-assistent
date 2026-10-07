import assert from 'node:assert/strict';
import { evidencePromptProtocol, validateEvidenceManifest, evidenceSeed, fingerprint } from './evidence-acceptance.mjs';
import { providerUsageSchema } from '../../shared/provider-usage.ts';
import { independentMissionEvidence } from '../../shared/mission-report.ts';

export const REPORT_FAULT_PROTOCOL = 'syna-report-fault-acceptance-v2';
export const REPORT_FAULT_PROTOCOLS = Object.freeze(['syna-report-fault-acceptance-v1', 'syna-report-fault-acceptance-v2']);
export const REPORT_FAULT_PREPARATION = 'syna-report-fault-preparation-v1';
export const reportFaultVariants = { 'REP-05': 'lost-queue-commit-ack', 'REP-06': 'source-change-after-read', 'REP-07': 'wrong-run-provenance' };
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,150}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const strict = (value, keys) => assert.ok(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)), 'Unexpected fault field');

export function validateReportFaultManifest(value, { execute = false } = {}) {
  strict(value, ['protocol', 'catalogVersion', 'taskId', 'variant', 'sourceHash', 'runtime', 'model', 'reasoning', 'observationSeconds', 'trials', 'preparation', 'reviewerVersion', 'fault']);
  assert.ok(REPORT_FAULT_PROTOCOLS.includes(value.protocol), 'Unsupported report fault protocol'); assert.equal(value.variant, reportFaultVariants[value.taskId]);
  assert.ok(value.variant); assert.equal(value.preparation, 'synthetic-golden');
  assert.equal(value.trials.length, 3, 'Exactly three prelocked repetitions; no after-the-fact replacement');
  strict(value.fault, ['configFile', 'receiptFile', 'codeHashes', 'maxHoldMs']);
  assert.equal(typeof value.fault.configFile, 'string'); assert.equal(typeof value.fault.receiptFile, 'string');
  assert.equal(value.fault.maxHoldMs, 10000);
  assert.ok(Object.keys(value.fault.codeHashes ?? {}).length >= 4 && Object.values(value.fault.codeHashes).every(digest), 'Freeze every transport/control/oracle file');
  const trials = value.trials.map(trial => {
    strict(trial, ['workspaceId', 'accountFile', 'selection', 'seedHash', 'targetRevision', 'originArtifacts', 'mutation', 'wrongRun']);
    const { mutation, wrongRun, ...base } = trial;
    if (value.taskId === 'REP-06') {
      strict(mutation, ['itemId', 'version', 'contentHash', 'replacementText']);
      assert.ok(identifier(mutation.itemId) && Number.isInteger(mutation.version) && mutation.version >= 1 && digest(mutation.contentHash));
      assert.equal(typeof mutation.replacementText, 'string'); assert.ok(mutation.replacementText.startsWith('SYNTHETIC FAULT SOURCE EDIT:') && mutation.replacementText.length < 2000);
      assert.equal(wrongRun, undefined);
    } else if (value.taskId === 'REP-07') {
      strict(wrongRun, ['itemId', 'registeredRunId', 'claimedRunId', 'contentHash']);
      assert.ok([wrongRun.itemId, wrongRun.registeredRunId, wrongRun.claimedRunId].every(identifier) && digest(wrongRun.contentHash));
      assert.notEqual(wrongRun.registeredRunId, wrongRun.claimedRunId); assert.equal(mutation, undefined);
    } else { assert.equal(mutation, undefined); assert.equal(wrongRun, undefined); }
    return base;
  });
  validateEvidenceManifest({ ...value, protocol: evidencePromptProtocol(value.protocol), variant: 'normal', trials, fault: undefined }, { execute });
  return value;
}

export function validateReportFaultPreparation(artifact, { manifest, trial, seed, reviews, reviewerVersion }) {
  assert.equal(artifact.protocol, REPORT_FAULT_PREPARATION); assert.equal(artifact.runtime, manifest.runtime);
  assert.equal(artifact.taskId, manifest.taskId); assert.equal(artifact.variant, manifest.variant); assert.equal(artifact.reviewerVersion, reviewerVersion);
  assert.equal(artifact.realProviderCalls, 0); assert.equal(artifact.realBrowserActions, 0); assert.ok(artifact.completedAt && !artifact.preparationFailed);
  const locked = artifact.trials.find(t => t.workspaceId === trial.workspaceId); assert.ok(locked);
  assert.equal(fingerprint(locked.seed), fingerprint(seed)); assert.equal(locked.seedHash, trial.seedHash);
  for (const row of locked.reviews) {
    const saved = reviews.find(review => review.id === row.id); assert.ok(saved && saved.status === 'completed' && saved.reviewer_version === reviewerVersion);
    assert.equal(fingerprint(saved), fingerprint(row), 'Fixture review changed; never silently re-certify it');
    assert.ok(['synthetic-golden-reviewer', 'deterministic-rules'].includes(saved.model));
  }
  assert.ok(seed.runs.every(run => !run.mission_attempt_id && run.result?.actual.includes('SYNTHETIC GOLDEN FIXTURE')));
  if (manifest.taskId === 'REP-06') {
    const item = seed.material.find(c => c.id === trial.mutation.itemId);
    assert.ok(item && item.content.kind === 'text' && item.provenance?.producer === 'research-page' && item.provenance.origin === 'tool');
    assert.equal(item.version, trial.mutation.version); assert.equal(fingerprint(item.content), trial.mutation.contentHash);
  }
  if (manifest.taskId === 'REP-07') {
    const item = seed.captures.find(c => c.item_id === trial.wrongRun.itemId);
    assert.ok(item && item.run_id === trial.wrongRun.registeredRunId && item.provenance?.sourceId === trial.wrongRun.claimedRunId);
    assert.equal(fingerprint(item.content), trial.wrongRun.contentHash);
    assert.ok(reviews.some(review => review.run_id === trial.wrongRun.registeredRunId && review.assessment?.verdict === 'needs_evidence'));
  }
  return { preparation: 'synthetic-golden-fault', realProviderCalls: 0, realBrowserActions: 0, reviewerVersion, preparedAt: artifact.completedAt };
}

const newRows = (before, after) => after.filter(row => !before.some(old => old.id === row.id));
export function auditReportFaultCompletion(manifest, trial, before, after, threadId, receipt, freshnessProof = null) {
  const missions = newRows(before.missions, after.missions).filter(mission => mission.thread_id === threadId);
  assert.equal(missions.length, 1); const mission = missions[0];
  assert.equal(mission.intent, 'report_only'); assert.equal(mission.lifecycle, 'closed');
  assert.equal(after.claims?.filter(claim => claim.mission_id === mission.id).length ?? 0, 0, 'Report-only resource claim remained');
  for (const field of ['runs', 'jobs', 'repositories', 'setups']) assert.equal(newRows(before[field], after[field]).length, 0, `Report-only created ${field}`);
  assert.ok(after.attempts.filter(a => a.mission_id === mission.id).every(a => ['report', 'review'].includes(a.kind)));
  const reports = after.reports.filter(report => report.mission_id === mission.id);
  assert.ok(reports.length, 'No report queue was actually created');
  const selected = trial.selection.map(ref => `${ref.type}:${ref.id}`).sort();
  for (const report of reports) {
    const actual = [...new Set(report.input.tasks.flatMap(task => task.sources.map(source => `${source.sourceType}:${source.sourceId}`)))].sort();
    assert.deepEqual(actual, selected, 'Exact saved selection was replaced');
    for (const original of before.runs.filter(run => trial.selection.some(ref => ref.type === 'test' && ref.id === run.id) && run.result?.outcome === 'failed')) {
      const source = report.input.tasks.flatMap(task => task.sources).find(source => source.sourceType === 'test' && source.sourceId === original.id);
      assert.equal(source?.reportedOutcome, 'partial', 'Original product failure disappeared from report input');
    }
  }
  const seedBefore = evidenceSeed(before, trial.selection), seedAfter = evidenceSeed(after, trial.selection);
  assert.equal(fingerprint(seedBefore.runs), fingerprint(seedAfter.runs), 'Original executor results changed');
  if (manifest.taskId !== 'REP-06') assert.equal(fingerprint(seedBefore), fingerprint(seedAfter), 'Original evidence changed');
  const completed = reports.filter(report => report.status === 'completed' && report.document);
  const modelReports = manifest.taskId === 'REP-06' ? reports.filter(report => report.id === receipt?.reportId) : completed;
  assert.ok(modelReports.length, 'No exact report was available to verify real scheduled model work');
  for (const report of modelReports) {
    const attempts = after.attempts.filter(a => a.mission_id === mission.id && a.kind === 'report' && a.executor_resource_id === report.id);
    assert.ok(attempts.some(attempt => providerUsageSchema.safeParse(attempt.usage?.provider).success && attempt.usage.provider.providerCalls > 0), 'No exact report-bound physical provider receipt; deterministic fallback is not model acceptance');
    if (manifest.taskId !== 'REP-06') assert.ok(report.read_receipts?.some(receipt => !receipt.limited
      && report.input.tasks.some(task => task.sources.some(source => source.evidence?.some(ref => independentMissionEvidence(source, ref)
        && ref.id === receipt.id && ref.version === receipt.version && ref.hash === receipt.hash)))), 'No full read receipt for an eligible source');
  }
  if (manifest.taskId === 'REP-05') {
    assert.equal(receipt?.state, 'commit_ack_dropped'); assert.equal(receipt.missionId, mission.id); assert.equal(receipt.threadId, threadId);
    assert.equal(receipt.physicalBoundary, 'postgres_backend_commit_before_client_ack');
    assert.equal(reports.length, 1, 'Lost queue acknowledgement created another report');
    assert.equal(completed.length, 1); assert.equal(completed[0].id, receipt.reportId);
    assert.equal(completed[0].document.partial, true, 'The declared incomplete original cannot become a full endorsement');
  } else if (manifest.taskId === 'REP-06') {
    assert.equal(receipt?.state, 'source_changed_response_released'); assert.equal(receipt.missionId, mission.id); assert.equal(receipt.threadId, threadId);
    assert.equal(receipt.itemId, trial.mutation.itemId); assert.equal(receipt.beforeVersion, trial.mutation.version); assert.equal(receipt.afterVersion, trial.mutation.version + 1);
    assert.ok(after.attempts.some(a => a.id === receipt.attemptId && a.mission_id === mission.id && a.executor_resource_id === receipt.reportId && a.kind === 'report'), 'Provider barrier belongs to another report attempt');
    assert.ok(Date.parse(receipt.providerCompletedAt) <= Date.parse(receipt.changedAt) && Date.parse(receipt.changedAt) <= Date.parse(receipt.releasedAt));
    assert.equal(freshnessProof?.reportId, receipt.reportId, 'The exact report must reach its final freshness guard');
    assert.equal(freshnessProof?.reason, 'Evidence changed during review');
    assert.ok(freshnessProof.files?.some(file => file.occurrences > 0 && file.matchedDiagnosticSha256?.every(digest)), 'Generic report failure is not a freshness rejection');
    const strip = seed => ({ ...seed, material: seed.material.map(c => c.id === trial.mutation.itemId ? { ...c, version: null, content: null, provenance: null } : c) });
    assert.equal(fingerprint(strip(seedBefore)), fingerprint(strip(seedAfter)), 'Unexpected input edit outside declared source');
    const changed = seedAfter.material.find(c => c.id === trial.mutation.itemId);
    assert.equal(changed.version, trial.mutation.version + 1); assert.equal(changed.provenance.origin, 'user');
    assert.equal(changed.content.text, trial.mutation.replacementText);
    for (const report of completed) {
      assert.equal(report.document.partial, true, 'Changed evidence cannot receive an unqualified report');
      assert.ok(report.document.findings.some(f => f.verdict === 'needs_evidence'));
      assert.ok(report.document.findings.every(f => f.verdict === 'needs_evidence' || !f.evidenceIds.includes(`item:${trial.mutation.itemId}`)), 'Changed old evidence was conclusive');
    }
    assert.ok(completed.length || reports.every(report => report.status === 'failed'), 'Changed source left unfinished queue');
  } else {
    assert.equal(completed.length, 1); assert.equal(completed[0].document.partial, true);
    assert.ok(completed[0].document.findings.some(f => f.verdict === 'needs_evidence'));
    assert.ok(completed[0].document.findings.every(f => f.verdict === 'needs_evidence' || !f.evidenceIds.includes(`item:${trial.wrongRun.itemId}`)), 'Wrong-run provenance became conclusive');
  }
  return { missionId: mission.id, reportId: completed[0]?.id ?? null, reportIds: reports.map(r => r.id),
    checks: ['exact report-only selection', 'original runs preserved', 'no new execution', manifest.variant], semanticProse: 'pending' };
}
