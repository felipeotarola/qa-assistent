import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { GAP_FAULT_PROTOCOL, validateGapFaultManifest, gapFaultClock, gapTrialClock, gapDeadlineOpen, isGapResultUrl, selectGapCaptures, gapReadProof, createGapFileStore } from './helpers/evidence-gap-fault.mjs';
import { sha256 } from './helpers/evidence-acceptance.mjs';

const sourceHash = 'a'.repeat(64), workspaceId = 'bb08c894-3776-435a-932e-7d49a27f43d6', userId = 'owner';
const manifest = () => ({ protocol: GAP_FAULT_PROTOCOL, sourceHash, runtime: 'autonomy-test:gap', variant: 'resolvable',
  fixture: { path: 'tests/fixtures/gap-search/server.mjs', sha256: 'b'.repeat(64), origin: 'http://gap-fixture.test', resultPath: '/products', queryKey: 'q' },
  helperSha256: 'e'.repeat(64), acceptanceManifest: '.data/autonomy-isolation/gap-manifest.json', acceptanceManifestSha256: 'c'.repeat(64), perTrialSeconds: 1200, maxSeconds: 1200, trials: [{ workspaceId, userId }] });
function state() {
  return { missions: [{ id: 'mission', runtime: 'autonomy-test:gap', workspace_id: workspaceId, user_id: userId, controller_version: 1, created_at: '2026-10-05T10:01:00Z', thread_id: 'thread', plan_revision: 1 }],
    tasks: [{ id: 'task', mission_id: 'mission', plan_revision: 1, spec: { kind: 'browser_tests' }, supplement_round: 0 }],
    attempts: [{ id: 'attempt', task_id: 'task', mission_id: 'mission', kind: 'browser_tests', executor_resource_id: null }], jobs: [{ id: 'job', session_id: 'session' }],
    gapBrowserBindings: [{ id: 'attempt', mission_id: 'mission', task_id: 'task', dispatch_id: 'job', executor_resource_id: null,
      runtime: 'autonomy-test:gap', kind: 'browser_tests', thread_id: 'thread', workspace_id: workspaceId, user_id: userId,
      job_id: 'job', job_thread_id: 'thread', job_runtime: 'autonomy-test:gap', session_id: 'session', job_workspace_id: workspaceId, job_user_id: userId }],
    runs: [{ id: 'run', workspace_id: workspaceId, runtime: 'autonomy-test:gap', mission_attempt_id: 'attempt', thread_id: 'thread', item_id: 'plan', case_id: 'case', started_at: '2026-10-05T10:01:00Z' }], reviews: [],
    captures: [{ id: 'capture', run_id: 'run', item_id: 'item', blob_path: `pat/workspaces/${workspaceId}/${randomUUID()}/capture.json`, version: 1, created_at: '2026-10-05T10:02:00Z', url: 'http://gap-fixture.test/products?q=%5BREDACTED%5D',
      provenance: { version: 1, origin: 'tool', sourceType: 'test', sourceId: 'run', producer: 'browser-action', sha256: 'd'.repeat(64), url: 'http://gap-fixture.test/products?q=%5BREDACTED%5D' } }] };
}
test('gap fault locks variant, code identity and result route without query value', () => {
  validateGapFaultManifest(manifest());
  for (const change of [m => m.variant = 'report-only', m => m.runtime = 'production', m => m.sourceHash = 'main', m => m.maxSeconds = 100000,
    m => m.fixture.secret = 'never', m => m.fixture.origin += '/products', m => m.fixture.resultPath = '/../etc', m => m.trials.push(m.trials[0])]) {
    const m = manifest(); change(m); assert.throws(() => validateGapFaultManifest(m));
  }
  assert.ok(isGapResultUrl('http://gap-fixture.test/products?q=anything', manifest().fixture));
  assert.equal(isGapResultUrl('http://evil.test/products?q=anything', manifest().fixture), false);
  assert.equal(isGapResultUrl('http://gap-fixture.test/products', manifest().fixture), false);
});
test('three serial trials reserve at most 4500 total seconds and cannot widen either locked budget', () => {
  const m = { ...manifest(), perTrialSeconds: 1500, maxSeconds: 4500,
    trials: [1, 2, 3].map(n => ({ workspaceId: `workspace_${n}`, userId })) };
  validateGapFaultManifest(m);
  for (const change of [v => v.maxSeconds = 1500, v => v.maxSeconds = 4501, v => v.perTrialSeconds = 1501,
    v => v.perTrialSeconds = 0, v => delete v.perTrialSeconds, v => v.trials.pop()]) {
    const value = structuredClone(m); change(value); assert.throws(() => validateGapFaultManifest(value));
  }
  const clock = gapFaultClock(m, '2026-10-05T10:00:00.000Z');
  assert.equal(clock.deadlineAt, '2026-10-05T11:15:00.000Z'); assert.equal(clock.maxSeconds, 4500);
  assert.equal(Object.isFrozen(clock), true); assert.throws(() => { clock.deadlineAt = '2099-01-01T00:00:00.000Z'; });
  assert.equal(gapDeadlineOpen(clock, Date.parse('2026-10-05T11:14:59.999Z')), true);
  assert.equal(gapDeadlineOpen(clock, Date.parse('2026-10-05T11:15:00.000Z')), false);
});
test('late polling and subsequent trials inherit arm deadline without resetting or extending it', () => {
  const m = { ...manifest(), perTrialSeconds: 1500, maxSeconds: 4500, trials: [1, 2, 3].map(n => ({ workspaceId: `workspace_${n}`, userId })) };
  const clock = gapFaultClock(m, '2026-10-05T10:00:00.000Z');
  const first = gapTrialClock(clock, { id: 'first', created_at: '2026-10-05T10:02:00.000Z' });
  assert.equal(first.deadlineAt, '2026-10-05T10:27:00.000Z');
  assert.deepEqual(gapTrialClock(clock, { id: 'first', created_at: new Date(first.startedAt) }, first), first);
  assert.throws(() => gapTrialClock(clock, { id: 'first', created_at: '2026-10-05T10:10:00.000Z' }, first));
  assert.throws(() => gapTrialClock(clock, { id: 'replacement', created_at: first.startedAt }, first));
  const last = gapTrialClock(clock, { id: 'last', created_at: '2026-10-05T11:10:00.000Z' });
  assert.equal(last.deadlineAt, clock.deadlineAt, 'Late third trial gets only the remaining five minutes');
  const tooLate = gapTrialClock(clock, { id: 'late', created_at: '2026-10-05T11:16:00.000Z' });
  assert.equal(gapDeadlineOpen(tooLate, Date.parse(tooLate.startedAt)), false);
  assert.throws(() => gapTrialClock(clock, { id: 'old', created_at: '2026-10-05T09:59:59.000Z' }));
});
test('only exact fresh owned runtime/physical attempt capture may be selected', () => {
  const choose = s => selectGapCaptures(s, manifest(), { workspaceId, userId }, '2026-10-05T10:00:00Z');
  assert.equal(choose(state()).captures.length, 1);
  for (const alter of [s => s.missions[0].user_id = 'other', s => s.missions[0].runtime = 'other', s => s.missions[0].created_at = '2026-10-04T00:00:00Z',
    s => s.runs[0].mission_attempt_id = 'wrong', s => s.jobs[0].session_id = null, s => s.captures[0].provenance.sourceId = 'other', s => s.captures[0].provenance.origin = 'agent',
    s => s.tasks[0].plan_revision = 2, s => s.captures[0].url = 'http://evil.test/products?q=x', s => s.reviews.push({ run_id: 'run', status: 'running' })]) {
    const s = state(); alter(s); assert.equal(choose(s).captures.length, 0);
  }
});
test('dispatch binding accepts null physical resource only with exact job authority', () => {
  const choose = s => selectGapCaptures(s, manifest(), { workspaceId, userId }, '2026-10-05T10:00:00Z');
  assert.equal(choose(state()).captures.length, 1);
  const explicit = state(); explicit.attempts[0].executor_resource_id = explicit.gapBrowserBindings[0].executor_resource_id = 'job';
  assert.equal(choose(explicit).captures.length, 1);
  for (const field of ['id', 'mission_id', 'task_id', 'kind', 'runtime', 'thread_id', 'workspace_id', 'user_id', 'dispatch_id',
    'job_id', 'job_thread_id', 'job_runtime', 'session_id', 'job_workspace_id', 'job_user_id', 'executor_resource_id']) {
    const s = state(); s.gapBrowserBindings[0][field] = 'foreign'; assert.equal(choose(s).captures.length, 0, field);
  }
  for (const alter of [s => delete s.gapBrowserBindings, s => s.gapBrowserBindings = [],
    s => s.gapBrowserBindings.push({ ...s.gapBrowserBindings[0] }), s => s.jobs.push({ ...s.jobs[0] }),
    s => s.gapBrowserBindings[0].dispatch_id = null, s => delete s.gapBrowserBindings[0].executor_resource_id,
    s => s.jobs[0].session_id = 'replacement', s => s.attempts[0].executor_resource_id = 'conflict',
    s => s.tasks[0].mission_id = 'foreign']) {
    const s = state(); alter(s); assert.equal(choose(s).captures.length, 0);
  }
  const missing = state(); missing.gapBrowserBindings = []; missing.attempts[0].executor_resource_id = 'job';
  assert.equal(choose(missing).captures.length, 0, 'No legacy resource-ID fallback authority');
});
test('resolvable restores successors; persistent is limited to same original case and two rounds', () => {
  const s = state(); s.tasks[0].spec.complement = { runId: 'original' }; s.tasks[0].supplement_round = 1;
  assert.equal(selectGapCaptures(s, manifest(), { workspaceId, userId }, '2026-10-05T10:00:00Z', 'plan:case').captures.length, 0);
  const m = { ...manifest(), variant: 'persistent' };
  assert.equal(selectGapCaptures(s, m, { workspaceId, userId }, '2026-10-05T10:00:00Z', 'plan:case').captures.length, 1);
  assert.equal(selectGapCaptures(s, m, { workspaceId, userId }, '2026-10-05T10:00:00Z', 'other:case').captures.length, 0);
  s.tasks[0].supplement_round = 3; assert.equal(selectGapCaptures(s, m, { workspaceId, userId }, '2026-10-05T10:00:00Z', 'plan:case').captures.length, 0);
});
test('quarantine receipt alone cannot certify a model read miss', () => {
  const s = state(), receipt = { itemId: 'item', runId: 'run', sha256: 'd'.repeat(64) };
  assert.equal(gapReadProof(s, [receipt])[0].observedReadMiss, false);
  s.reviews.push({ id: 'review', run_id: 'run', status: 'completed', input: { evidence: [{ itemId: 'item', readStatus: 'unavailable', provenance: { sha256: receipt.sha256 } }, { itemId: 'other', readStatus: 'read' }] } });
  assert.equal(gapReadProof(s, [receipt])[0].observedReadMiss, false);
  s.attempts.push({ kind: 'review', reviewCalls: [{ reviewId: 'review', providerCalls: 1 }] });
  assert.equal(gapReadProof(s, [receipt])[0].observedReadMiss, true);
  s.reviews[0].input.evidence[0].readStatus = 'read'; assert.equal(gapReadProof(s, [receipt])[0].observedReadMiss, false);
});
async function files(fn) {
  const root = await mkdtemp(resolve(tmpdir(), 'syna-evidence-gap-unit-')), storageRoot = resolve(root, 'storage'), journalRoot = resolve(root, 'journal');
  await mkdir(storageRoot); const s = state(), capture = s.captures[0], run = s.runs[0], bytes = Buffer.from('Declared synthetic bytes; not prior browser evidence.');
  capture.provenance.sha256 = sha256(bytes); const path = resolve(storageRoot, capture.blob_path); await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, bytes);
  try { await fn({ storageRoot, journalRoot, scope: { workspaceId, userId, sourceHash }, capture, run, path, bytes }); }
  finally { assert.ok(root.startsWith(resolve(tmpdir(), 'syna-evidence-gap-unit-'))); await rm(root, { recursive: true }); }
}
test('real file quarantine is absent at read boundary and restores identical bytes without overwrite', async () => files(async f => {
  const store = await createGapFileStore(f);
  try {
    await store.quarantine(f.capture, f.run); await assert.rejects(readFile(f.path), { code: 'ENOENT' });
    assert.equal(store.rows().filter(r => r.kind === 'planned').length, 1); await store.quarantine(f.capture, f.run);
    await store.restore(); assert.deepEqual(await readFile(f.path), f.bytes); await store.restore();
    assert.equal(store.rows().filter(r => r.kind === 'restored').length, 1);
  } finally { await store.close(); }
}));
test('deadline crossing during file preparation prevents rename and restore preserves original bytes', async () => files(async f => {
  let calls = 0;
  const store = await createGapFileStore({ ...f, assertBeforeFault: () => { assert.ok(++calls === 1, 'Fixed physical fault deadline elapsed'); } });
  try {
    await assert.rejects(store.quarantine(f.capture, f.run), /deadline elapsed/);
    assert.equal(calls, 2); assert.deepEqual(await readFile(f.path), f.bytes);
    assert.equal(store.rows().filter(r => r.kind === 'quarantined').length, 0);
    await store.restore(); assert.deepEqual(await readFile(f.path), f.bytes);
  } finally { await store.close(); }
}));
test('restart uses original journal and refuses another owner, changed bytes or replacement file', async () => files(async f => {
  let store = await createGapFileStore(f); await store.quarantine(f.capture, f.run); await store.close();
  const originalJournal = await readFile(resolve(f.journalRoot, 'journal.jsonl'));
  await assert.rejects(createGapFileStore({ ...f, recover: true, scope: { ...f.scope, userId: 'another' } }), /Recovery scope/);
  assert.deepEqual(await readFile(resolve(f.journalRoot, 'journal.jsonl')), originalJournal);
  store = await createGapFileStore({ ...f, recover: true });
  try {
    await writeFile(f.path, 'replacement'); await assert.rejects(store.restore(), /overwrite/); assert.equal(await readFile(f.path, 'utf8'), 'replacement');
    await rm(f.path); await store.restore(); assert.deepEqual(await readFile(f.path), f.bytes);
  } finally { await store.close(); }
}));
test('foreign workspace path and unexpected original byte digest are denied before rename', async () => files(async f => {
  const store = await createGapFileStore(f);
  try {
    await assert.rejects(store.quarantine({ ...f.capture, blob_path: '../escape' }, f.run));
    await assert.rejects(store.quarantine({ ...f.capture, provenance: { ...f.capture.provenance, sha256: 'e'.repeat(64) } }, f.run), /bytes changed/);
    await assert.rejects(store.quarantine(f.capture, { ...f.run, workspace_id: 'another' }), /another workspace/);
    await assert.rejects(store.quarantine({ ...f.capture, run_id: 'another' }, f.run), /selected original/);
    assert.deepEqual(await readFile(f.path), f.bytes); assert.equal(store.rows().filter(r => r.kind === 'planned').length, 0);
  } finally { await store.close(); }
}));
test('missing recovery journal is not created as an accidental replacement', async () => files(async f => {
  await assert.rejects(createGapFileStore({ ...f, recover: true }), { code: 'ENOENT' });
  await assert.rejects(readFile(resolve(f.journalRoot, 'journal.jsonl')), { code: 'ENOENT' });
}));
