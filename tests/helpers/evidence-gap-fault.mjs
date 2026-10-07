// Test-only physical file-read fault. No app services, model, database writes,
// fabricated result rows or review instructions are imported by this module.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, link, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fingerprint, sha256 } from './evidence-acceptance.mjs';

export const GAP_FAULT_PROTOCOL = 'syna-evidence-gap-fault-v1';
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,150}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const strict = (value, fields) => assert.ok(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key)), 'Unknown fault contract field');
export function validateGapFaultManifest(m) {
  strict(m, ['protocol', 'sourceHash', 'runtime', 'variant', 'fixture', 'helperSha256', 'acceptanceManifest', 'acceptanceManifestSha256', 'perTrialSeconds', 'maxSeconds', 'trials']);
  assert.equal(m.protocol, GAP_FAULT_PROTOCOL); assert.ok(digest(m.sourceHash)); assert.match(m.runtime, /^autonomy-test:[a-z0-9-]+$/);
  assert.ok(['resolvable', 'persistent'].includes(m.variant));
  assert.ok(Number.isInteger(m.perTrialSeconds) && m.perTrialSeconds >= 60 && m.perTrialSeconds <= 1500);
  strict(m.fixture, ['path', 'sha256', 'origin', 'resultPath', 'queryKey']);
  assert.equal(typeof m.fixture.path, 'string'); assert.ok(digest(m.fixture.sha256));
  const origin = new URL(m.fixture.origin); assert.equal(origin.origin, m.fixture.origin); assert.ok(['http:', 'https:'].includes(origin.protocol));
  assert.ok(!origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash);
  assert.match(m.fixture.resultPath, /^\/[a-zA-Z0-9/_-]{1,120}$/); assert.match(m.fixture.queryKey, /^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/);
  assert.equal(typeof m.acceptanceManifest, 'string'); assert.ok(digest(m.acceptanceManifestSha256));
  assert.ok(digest(m.helperSha256), 'The imported physical-fault helper must be prelocked too');
  assert.ok(Array.isArray(m.trials) && m.trials.length >= 1 && m.trials.length <= 5);
  assert.equal(m.maxSeconds, m.perTrialSeconds * m.trials.length, 'Total fault budget must equal the locked trial count times its per-trial budget');
  assert.equal(new Set(m.trials.map(t => t.workspaceId)).size, m.trials.length);
  for (const t of m.trials) { strict(t, ['workspaceId', 'userId']); assert.ok(id(t.workspaceId) && id(t.userId)); }
  return m;
}

function instant(value) {
  assert.ok(typeof value === 'string' && /Z$/.test(value) && Number.isFinite(Date.parse(value)), 'Fault clock requires an explicit UTC instant');
  return Date.parse(value);
}

/** One arm-time deadline covers setup, idle time and every sequential trial.
 * Call only at initial arm, never when a later trial arrives or during restore. */
export function gapFaultClock(manifest, armedAt) {
  validateGapFaultManifest(manifest);
  return Object.freeze({ armedAt, perTrialSeconds: manifest.perTrialSeconds, maxSeconds: manifest.maxSeconds,
    deadlineAt: new Date(instant(armedAt) + manifest.maxSeconds * 1000).toISOString() });
}

/** The acceptance observer starts at its own intake acknowledgement. This
 * separate physical driver starts a trial window at the stored mission creation
 * instant; neither a late poll nor a repeated observation moves that instant. */
export function gapTrialClock(clock, mission, previous = null) {
  assert.ok(id(mission.id));
  const startedAt = mission.created_at instanceof Date ? mission.created_at.toISOString() : mission.created_at;
  assert.ok(instant(startedAt) >= instant(clock.armedAt), 'Fault cannot adopt a pre-arm mission');
  const next = { missionId: mission.id, startedAt,
    deadlineAt: new Date(Math.min(instant(clock.deadlineAt), instant(startedAt) + clock.perTrialSeconds * 1000)).toISOString() };
  if (previous) assert.deepEqual(previous, next, 'A trial cannot replace its identity or extend its original deadline');
  return Object.freeze(next);
}

export function gapDeadlineOpen(clock, now = Date.now()) {
  assert.ok(Number.isFinite(now)); return now < instant(clock.deadlineAt);
}

/** Query values are deliberately NOT read or recorded. Fixture routing, not a
 * model-chosen search string, identifies the physical observation class. */
export function isGapResultUrl(value, fixture) {
  try { const u = new URL(value); return u.origin === fixture.origin && u.pathname === fixture.resultPath && u.searchParams.has(fixture.queryKey); }
  catch { return false; }
}

export function selectGapCaptures(state, manifest, trial, armedAt, chosenCaseKey = null) {
  const scope = state.missions.filter(m => m.runtime === manifest.runtime && m.workspace_id === trial.workspaceId && m.user_id === trial.userId
    && m.controller_version === 1 && +new Date(m.created_at) >= +new Date(armedAt));
  assert.ok(scope.length <= 1, 'One fault workspace may contain only one newly accepted mission');
  if (!scope.length) return { caseKey: chosenCaseKey, captures: [] };
  const mission = scope[0];
  const candidates = state.captures.filter(c => {
    const run = state.runs.find(r => r.id === c.run_id), attempt = state.attempts.find(a => a.id === run?.mission_attempt_id);
    const task = state.tasks.find(t => t.id === attempt?.task_id);
    const bindings = (state.gapBrowserBindings ?? []).filter(b => b.id === attempt?.id);
    const binding = bindings.length === 1 ? bindings[0] : null;
    const jobs = binding ? state.jobs.filter(j => j.id === binding.job_id) : [];
    const job = jobs.length === 1 ? jobs[0] : null;
    if (!binding || binding.mission_id !== mission.id || binding.task_id !== attempt?.task_id || binding.kind !== 'browser_tests'
      || binding.runtime !== manifest.runtime || binding.workspace_id !== trial.workspaceId || binding.user_id !== trial.userId
      || binding.thread_id !== mission.thread_id || !id(binding.dispatch_id) || binding.job_id !== binding.dispatch_id
      || binding.job_thread_id !== mission.thread_id || binding.job_runtime !== manifest.runtime
      || binding.job_workspace_id !== trial.workspaceId || binding.job_user_id !== trial.userId
      || !id(binding.session_id) || job?.session_id !== binding.session_id
      || binding.executor_resource_id !== attempt?.executor_resource_id
      || binding.executor_resource_id !== null && binding.executor_resource_id !== binding.dispatch_id) return false;
    if (!run || !attempt || attempt.mission_id !== mission.id || attempt.kind !== 'browser_tests' || !job?.session_id
      || run.runtime !== manifest.runtime || run.workspace_id !== trial.workspaceId || run.thread_id !== mission.thread_id
      || +new Date(run.started_at) < +new Date(armedAt) || !task || task.mission_id !== mission.id || task.plan_revision !== mission.plan_revision) return false;
    if (manifest.variant === 'resolvable' && task.spec?.complement || (task.supplement_round ?? 0) > 2) return false;
    if (state.reviews.some(r => r.run_id === run.id && (r.status === 'running' || r.status === 'completed'))) return false;
    return c.item_id && c.blob_path && !c.deleted_at && !c.error && c.version === 1 && c.provenance?.version === 1 && c.provenance.origin === 'tool'
      && c.provenance.sourceType === 'test' && c.provenance.sourceId === run.id && ['browser-action', 'test-capture'].includes(c.provenance.producer)
      && digest(c.provenance.sha256) && isGapResultUrl(c.provenance.url, manifest.fixture) && isGapResultUrl(c.url, manifest.fixture);
  }).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
  if (!chosenCaseKey && candidates.length) {
    const run = state.runs.find(r => r.id === candidates[0].run_id); chosenCaseKey = `${run.item_id}:${run.case_id}`;
  }
  return { caseKey: chosenCaseKey, captures: candidates.filter(c => { const r = state.runs.find(r => r.id === c.run_id); return `${r.item_id}:${r.case_id}` === chosenCaseKey; }) };
}

/** A renamed file alone does not prove the reviewer missed it. Require the
 * persisted exact model input, other actually-read evidence and a physical
 * provider receipt. The acceptance oracle separately verifies typed gap and
 * bounded original-case continuation. */
export function gapReadProof(state, receipts) {
  return receipts.map(receipt => {
    const review = state.reviews.find(r => r.run_id === receipt.runId && r.status === 'completed'
      && r.input?.evidence?.some(e => e.itemId === receipt.itemId && e.readStatus === 'unavailable' && e.provenance?.sha256 === receipt.sha256));
    const otherRead = review?.input.evidence.filter(e => e.readStatus === 'read' && !receipts.some(r => r.itemId === e.itemId)) ?? [];
    const physical = review && state.attempts.some(a => a.kind === 'review' && a.reviewCalls?.some(call => call.reviewId === review.id && call.providerCalls > 0));
    return { itemId: receipt.itemId, runId: receipt.runId, reviewId: review?.id ?? null, inputHash: review?.input_hash ?? null,
      sourceHash: review?.source_hash ?? null, otherReadItems: otherRead.map(e => e.itemId), physicalModel: !!physical,
      observedReadMiss: !!review && otherRead.length > 0 && !!physical };
  });
}

function inside(root, path) {
  const sub = relative(root, path); assert.ok(sub && sub !== '..' && !sub.startsWith(`..${sep}`) && !isAbsolute(sub), 'Path escapes the owned fault root'); return path;
}
async function noLinks(root, path) {
  inside(root, path);
  let current = path;
  while (current !== root) { assert.ok(!(await lstat(current)).isSymbolicLink(), 'Symlink/reparse path is forbidden'); current = dirname(current); }
  assert.equal(await realpath(root), root, 'Fault root must be canonical');
  assert.equal(await realpath(path), path, 'Evidence path must be canonical');
}
const blobPath = (root, workspaceId, key) => {
  assert.match(key, new RegExp(`^pat/workspaces/${workspaceId}/[a-f0-9-]{36}/[a-zA-Z0-9_.-]+$`));
  return inside(root, resolve(root, ...key.split('/')));
};

/** Append-only pre-effect journal and hard-link restore avoid overwriting any
 * replacement. A killed driver can replay restore from this exact journal.
 * Callers supply the fixture-derived storage root, never a model path. */
export async function createGapFileStore({ storageRoot, journalRoot, scope, recover = false, assertBeforeFault = () => {} }) {
  storageRoot = resolve(storageRoot); journalRoot = resolve(journalRoot);
  assert.ok(id(scope.workspaceId) && id(scope.userId) && digest(scope.sourceHash));
  await mkdir(journalRoot, { recursive: true });
  assert.equal(await realpath(journalRoot), journalRoot); assert.equal(await realpath(storageRoot), storageRoot);
  const journalPath = resolve(journalRoot, 'journal.jsonl');
  let rows = [];
  if (recover) {
    await noLinks(journalRoot, journalPath);
    const text = await readFile(journalPath, 'utf8'); assert.ok(Buffer.byteLength(text) <= 1024 * 1024);
    rows = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.ok(rows.length > 0 && fingerprint(rows[0].scope) === fingerprint(scope), 'Recovery scope does not match original fault');
  }
  const journal = await open(journalPath, recover ? 'a' : 'wx');
  async function append(row) { await journal.write(`${JSON.stringify(row)}\n`); await journal.sync(); rows.push(row); }
  if (!recover) await append({ kind: 'scope', scope, createdAt: new Date().toISOString() });
  const planned = () => rows.filter(r => r.kind === 'planned');
  async function quarantine(capture, run) {
    assertBeforeFault();
    assert.equal(run?.workspace_id, scope.workspaceId, 'Capture run belongs to another workspace');
    assert.equal(capture.run_id, run.id, 'Capture does not belong to the selected original run');
    assert.equal(capture.provenance?.sourceId, run.id, 'Capture provenance belongs to another run');
    const existing = planned().find(r => r.itemId === capture.item_id); if (existing) return existing;
    assert.ok(planned().length < 64, 'Fault file limit reached');
    const source = blobPath(storageRoot, scope.workspaceId, capture.blob_path); await noLinks(storageRoot, source);
    const info = await lstat(source); assert.ok(info.isFile() && info.size > 0 && info.size <= 4 * 1024 * 1024);
    assert.ok(planned().reduce((sum, r) => sum + r.bytes, 0) + info.size <= 64 * 1024 * 1024, 'Fault byte limit reached');
    const bytes = await readFile(source); assert.equal(sha256(bytes), capture.provenance.sha256, 'Original stored bytes changed before fault');
    const slot = `${randomUUID()}.held`, destination = inside(journalRoot, resolve(journalRoot, slot));
    const reserve = await open(destination, 'wx'); await reserve.close();
    const row = { kind: 'planned', itemId: capture.item_id, captureId: capture.id, runId: run.id, threadId: run.thread_id,
      actionId: capture.id, blobPath: capture.blob_path, slot, bytes: bytes.length, sha256: sha256(bytes),
      originalRunIdentityHash: fingerprint({ id: run.id, itemId: run.item_id, caseId: run.case_id, snapshot: run.snapshot,
        target: run.target, missionAttemptId: run.mission_attempt_id }), plannedAt: new Date().toISOString() };
    await append(row); assertBeforeFault();
    await rename(source, destination); await append({ kind: 'quarantined', itemId: row.itemId, at: new Date().toISOString() }); return row;
  }
  async function restore() {
    for (const row of planned()) {
      if (rows.some(r => r.kind === 'restored' && r.itemId === row.itemId)) continue;
      assert.match(row.slot, /^[a-f0-9-]{36}\.held$/); assert.ok(digest(row.sha256));
      const source = inside(journalRoot, resolve(journalRoot, row.slot)), destination = blobPath(storageRoot, scope.workspaceId, row.blobPath);
      await noLinks(storageRoot, dirname(destination));
      const held = await readFile(source).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      const original = await readFile(destination).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (original) {
        await noLinks(storageRoot, destination); assert.equal(sha256(original), row.sha256, 'Refuse to overwrite replaced evidence');
        // Crash after planning, or after the hard link and before unlink.
        if (held) { await noLinks(journalRoot, source); assert.ok(!held.length || sha256(held) === row.sha256); await unlink(source); }
      } else {
        assert.ok(held?.length && sha256(held) === row.sha256, 'Missing/modified quarantined bytes require operator investigation');
        await noLinks(journalRoot, source); await link(source, destination); await unlink(source);
      }
      await append({ kind: 'restored', itemId: row.itemId, at: new Date().toISOString() });
    }
  }
  return { quarantine, restore, rows: () => structuredClone(rows), close: () => journal.close(), journalPath };
}
