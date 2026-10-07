import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportFaultController, reportFaultAuthorized } from './helpers/report-fault-control.mjs';
import { reportFaultManifest } from './helpers/report-fault-compile.mjs';
import { validateReportFaultManifest, auditReportFaultCompletion, REPORT_FAULT_PREPARATION } from './helpers/report-fault-contract.mjs';
import { fingerprint } from './helpers/evidence-acceptance.mjs';

const sha = 'a'.repeat(64), now = Date.parse('2026-10-06T10:00:00Z');
const provider = { providerCalls: 1, unknownCalls: 0, inputTokens: 2, outputTokens: 3, totalTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, durationMs: 1 };
function manifest(taskId = 'REP-05') {
  const prep = { protocol: REPORT_FAULT_PREPARATION, taskId, reviewerVersion: '7', runtime: 'autonomy-test:fault', realProviderCalls: 0, realBrowserActions: 0, completedAt: new Date(now).toISOString(),
    trials: [1, 2, 3].map(i => ({ workspaceId: `w${i}`, seedHash: sha, selection: [{ type: 'test', id: `run${i}`, label: 'Saved original' }],
      mutation: { itemId: `item${i}`, version: 1, contentHash: fingerprint({ kind: 'text', text: 'Original' }), replacementText: 'SYNTHETIC FAULT SOURCE EDIT: changed by owner' },
      wrongRun: { itemId: `item${i}`, registeredRunId: `run${i}`, claimedRunId: `other${i}`, contentHash: sha } })) };
  return reportFaultManifest({ preparation: prep, preparationPath: '.data/autonomy-isolation/prep.json', preparationSha256: sha, accountFile: '.data/autonomy-isolation/account.json', sourceHash: sha,
    configFile: '.data/autonomy-isolation/config.json', receiptFile: '.data/autonomy-isolation/receipts.jsonl', codeHashes: { a: sha, b: sha, c: sha, d: sha } });
}
function fixture(taskId = 'REP-05', extra = {}) {
  const m = manifest(taskId), log = [], item = { id: 'item1', title: 'Source', version: 1, content: { kind: 'text', text: 'Original' }, provenance: { origin: 'tool' } };
  let clock = now, patches = 0;
  const c = reportFaultController({ manifest: m, deadlineAt: new Date(now + 4500_000).toISOString(), now: () => clock,
    journal: async row => log.push(structuredClone(row)), verifyArm: async () => ({ userId: 'ordinary', cookie: 'PRIVATE COOKIE' }),
    queueIdentity: async value => value.missionId === 'mission' ? { workspaceId: 'w1', threadId: 'thread', userId: 'ordinary', missionId: 'mission', reportId: 'report', snapshotId: 'snapshot', attemptId: 'attempt' } : null,
    currentItem: async () => structuredClone(item), patchItem: async (_state, _item, text) => { patches++; item.version++; item.content.text = text; item.provenance.origin = 'user'; return item; }, ...extra,
  });
  return { c, log, m, item, get patches() { return patches; }, advance: ms => { clock += ms; } };
}
const arm = c => c.arm({ workspaceId: 'w1', threadId: 'thread', promptSha256: sha });
const candidate = { missionId: 'mission', reportId: 'report', snapshotId: 'snapshot', connectionId: 'connection' };
const held = { missionId: 'mission', workspaceId: 'w1', inputFingerprint: sha, requestSha256: sha, providerResponseSha256: sha,
  evidence: [{ id: 'item:item1', digest: sha }], providerCompletedAt: new Date(now).toISOString() };

test('separate manifests require three locked repetitions and the exact catalog fault, not normal relabelling', () => {
  for (const task of ['REP-05', 'REP-06', 'REP-07']) assert.ok(validateReportFaultManifest(manifest(task), { execute: true }));
  const fewer = manifest(); fewer.trials.pop(); assert.throws(() => validateReportFaultManifest(fewer), /three/);
  const wrong = manifest(); wrong.variant = 'normal'; assert.throws(() => validateReportFaultManifest(wrong));
  const duplicated = manifest(); duplicated.trials[1].workspaceId = 'w1'; assert.throws(() => validateReportFaultManifest(duplicated));
});
test('control authentication rejects missing/wrong token without leaking expected bytes', () => {
  assert.equal(reportFaultAuthorized(undefined, sha), false); assert.equal(reportFaultAuthorized(`Bearer ${'b'.repeat(64)}`, sha), false); assert.equal(reportFaultAuthorized(`Bearer ${sha}`, sha), true);
});
test('commit arm is one-shot, exact owner/thread and journal-before-drop; credentials never leave memory', async () => {
  const f = fixture(); await arm(f.c);
  assert.equal(await f.c.commit(candidate, new AbortController().signal), true);
  assert.equal(f.log.at(-1).state, 'commit_verified');
  await f.c.dropped({ ...candidate, droppedAt: new Date(now + 1).toISOString() });
  assert.equal(f.c.receipt('w1').state, 'commit_ack_dropped');
  assert.equal(await f.c.commit(candidate, new AbortController().signal), false);
  await assert.rejects(arm(f.c), /already armed/); assert.ok(!JSON.stringify(f.log).includes('PRIVATE COOKIE'));
});
test('foreign/unarmed/expired/aborted commit cannot be counted as a real lost acknowledgement', async () => {
  const f = fixture(); assert.equal(await f.c.commit(candidate, new AbortController().signal), false);
  await arm(f.c); assert.equal(await f.c.commit({ ...candidate, missionId: 'other' }, new AbortController().signal), false);
  const cancelled = new AbortController(); cancelled.abort(); assert.equal(await f.c.commit(candidate, cancelled.signal), false);
  f.advance(1500_001); assert.equal(await f.c.commit(candidate, new AbortController().signal), false);
  assert.equal(f.log.length, 1);
  const foreign = fixture('REP-05', { queueIdentity: async () => ({ workspaceId: 'w1', threadId: 'other', userId: 'ordinary' }) }); await arm(foreign.c);
  assert.equal(await foreign.c.commit(candidate, new AbortController().signal), false);
});
test('freshness fault performs exactly one ordinary owner edit after read and releases only its exact request', async () => {
  const f = fixture('REP-06'); await arm(f.c); assert.equal(await f.c.matches(held), true);
  const receipt = await f.c.response(held, new AbortController().signal);
  assert.deepEqual(receipt, { released: true, requestSha256: sha }); assert.equal(f.patches, 1); assert.equal(f.item.version, 2);
  assert.deepEqual(f.log.map(r => r.state), ['armed', 'owner_patch_started', 'source_changed_response_released']);
  await assert.rejects(f.c.response(held, new AbortController().signal)); assert.equal(f.patches, 1);
});
test('unread source, changed version, stale epoch, missing owner receipt and network ambiguity cannot pass freshness', async () => {
  for (const mutate of [f => { f.item.version++; }, f => { f.item.content.text = 'different'; }, f => f.advance(1500_001)]) {
    const f = fixture('REP-06'); await arm(f.c); mutate(f); await assert.rejects(f.c.response(held, new AbortController().signal)); assert.equal(f.patches, 0);
  }
  const unread = fixture('REP-06'); await arm(unread.c); await assert.rejects(unread.c.response({ ...held, evidence: [] }, new AbortController().signal)); assert.equal(unread.patches, 0);
  const unknown = fixture('REP-06', { patchItem: async () => { throw new Error('Lost owner API acknowledgement'); } }); await arm(unknown.c);
  await assert.rejects(unknown.c.response(held, new AbortController().signal)); assert.equal(unknown.c.receipt('w1').state, 'owner_patch_failed_or_unknown');
  await assert.rejects(unknown.c.response(held, new AbortController().signal));
});
test('completion oracle refuses missing actual faults, duplicate report queues and product execution masquerading as report-only', () => {
  const m = manifest(), trial = m.trials[0];
  const before = { missions: [], attempts: [], runs: [{ id: 'run1' }], jobs: [], repositories: [], setups: [], reports: [], captures: [], items: [] };
  const evidence = { id: 'item:evidence', version: 1, hash: sha, origin: 'tool', evidencePolicyVersion: 2, observedAt: new Date(now).toISOString(),
    provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: 'run1', observedAt: new Date(now).toISOString() } };
  const after = { ...structuredClone(before), missions: [{ id: 'mission', thread_id: 'thread', lifecycle: 'closed', intent: 'report_only' }],
    attempts: [{ id: 'attempt', mission_id: 'mission', kind: 'report', executor_resource_id: 'report', usage: { provider } }],
    reports: [{ id: 'report', mission_id: 'mission', status: 'completed', document: { partial: true }, read_receipts: [{ id: evidence.id, version: 1, hash: sha, limited: false }],
      input: { tasks: [{ sources: [{ sourceType: 'test', sourceId: 'run1', schemaVersion: 2,
        target: { environment: 'test', url: 'https://example.test', revision: 'golden' }, startedAt: new Date(now - 1000).toISOString(), finishedAt: new Date(now + 1000).toISOString(), evidence: [evidence] }] }] } }] };
  const receipt = { ...candidate, state: 'commit_ack_dropped', threadId: 'thread', physicalBoundary: 'postgres_backend_commit_before_client_ack' };
  assert.equal(auditReportFaultCompletion(m, trial, before, after, 'thread', receipt).reportId, 'report');
  const noModel = structuredClone(after); noModel.attempts = []; assert.throws(() => auditReportFaultCompletion(m, trial, before, noModel, 'thread', receipt), /physical provider/);
  const foreignModel = structuredClone(after); foreignModel.attempts[0].executor_resource_id = 'another-report'; assert.throws(() => auditReportFaultCompletion(m, trial, before, foreignModel, 'thread', receipt), /physical provider/);
  const noRead = structuredClone(after); noRead.reports[0].read_receipts = []; assert.throws(() => auditReportFaultCompletion(m, trial, before, noRead, 'thread', receipt), /full read receipt/);
  const unknownCost = structuredClone(after); Object.assign(unknownCost.attempts[0].usage.provider, { unknownCalls: 1, inputTokens: null, totalTokens: null });
  assert.equal(auditReportFaultCompletion(m, trial, before, unknownCost, 'thread', receipt).reportId, 'report');
  assert.throws(() => auditReportFaultCompletion(m, trial, before, after, 'thread', null));
  after.reports.push({ ...after.reports[0], id: 'duplicate' }); assert.throws(() => auditReportFaultCompletion(m, trial, before, after, 'thread', receipt));
  after.reports.pop(); after.jobs.push({ id: 'new-browser' }); assert.throws(() => auditReportFaultCompletion(m, trial, before, after, 'thread', receipt), /created jobs/);
});
test('changed-source acceptance requires the exact final freshness rejection, not an arbitrary report failure after edit', () => {
  const m = manifest('REP-06'), trial = m.trials[0]; trial.selection = [{ type: 'material', id: 'item1', label: 'Version note' }];
  const before = { missions: [], attempts: [], runs: [], jobs: [], repositories: [], setups: [], reports: [], captures: [], items: [{ id: 'item1', title: 'Note', version: 1, content: { kind: 'text', text: 'Original' }, provenance: { origin: 'tool' } }] };
  const after = { ...structuredClone(before), missions: [{ id: 'mission', thread_id: 'thread', lifecycle: 'closed', intent: 'report_only' }],
    attempts: [{ id: 'attempt', mission_id: 'mission', kind: 'report', executor_resource_id: 'report', usage: { provider } }],
    reports: [{ id: 'report', mission_id: 'mission', status: 'failed', document: null, input: { tasks: [{ sources: [{ sourceType: 'material', sourceId: 'item1' }] }] } }] };
  Object.assign(after.items[0], { version: 2, content: { kind: 'text', text: trial.mutation.replacementText }, provenance: { origin: 'user' } });
  const receipt = { ...candidate, attemptId: 'attempt', state: 'source_changed_response_released', threadId: 'thread', itemId: 'item1', beforeVersion: 1, afterVersion: 2,
    providerCompletedAt: new Date(now).toISOString(), changedAt: new Date(now + 1).toISOString(), releasedAt: new Date(now + 2).toISOString() };
  const proof = { reportId: 'report', reason: 'Evidence changed during review', files: [{ occurrences: 1, matchedDiagnosticSha256: [sha] }] };
  assert.equal(auditReportFaultCompletion(m, trial, before, after, 'thread', receipt, proof).reportId, null);
  for (const invalid of [null, { ...proof, reportId: 'another' }, { ...proof, reason: 'generation_or_storage_error' }, { ...proof, files: [] }]) assert.throws(() => auditReportFaultCompletion(m, trial, before, after, 'thread', receipt, invalid));
  assert.throws(() => auditReportFaultCompletion(m, trial, before, after, 'thread', { ...receipt, attemptId: 'other' }, proof), /another report attempt/);
  after.attempts[0].usage.provider = { ...provider, providerCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 0 };
  assert.throws(() => auditReportFaultCompletion(m, trial, before, after, 'thread', receipt, proof), /physical provider/);
});
