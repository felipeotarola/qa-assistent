import assert from 'node:assert/strict';
import { readFile, realpath, stat, appendFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { readIsolationFixture, assertIsolatedDatabaseUrl, isolatedProcessEnvironment } from './autonomy-isolation.mjs';
import { validateReportFaultManifest } from './report-fault-contract.mjs';
import { sha256, fingerprint } from './evidence-acceptance.mjs';

export async function reportFaultPrivateFile(path) {
  const root = await realpath(resolve('.data/autonomy-isolation')), candidate = resolve(path), actual = await realpath(candidate), sub = relative(root, actual);
  assert.ok(candidate === actual && sub && !isAbsolute(sub) && sub !== '..' && !sub.startsWith(`..${sep}`), 'Expected owned regular isolation file');
  const info = await stat(actual); assert.ok(info.isFile() && info.size <= 128 * 1024 * 1024);
  return readFile(actual);
}
export async function loadReportFaultConfig(path, { allowExpired = false } = {}) {
  const config = JSON.parse(await reportFaultPrivateFile(path));
  assert.equal(config.kind, 'syna-report-fault-driver'); assert.equal(config.version, 1);
  assert.match(config.controlKey, /^[a-f0-9]{64}$/); assert.equal(config.appOrigin, 'http://127.0.0.1:58000');
  for (const port of [config.controlPort, config.pgPort].filter(p => p != null)) assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
  assert.notEqual(config.controlPort, config.pgPort);
  const fixture = await readIsolationFixture(config.fixtureFile), manifestBytes = await reportFaultPrivateFile(config.manifestFile);
  isolatedProcessEnvironment(fixture); // Validate every auth/service origin before any credential can be used.
  assert.equal(sha256(manifestBytes), config.manifestSha256);
  const manifest = validateReportFaultManifest(JSON.parse(manifestBytes), { execute: true });
  assert.equal(manifest.runtime, fixture.runtimeScope); assert.equal(manifest.sourceHash, fixture.app.sourceSha256);
  const upstream = new URL(assertIsolatedDatabaseUrl(config.upstreamDatabaseUrl)), configured = new URL(fixture.databaseUrl);
  assert.equal(upstream.hostname, '127.0.0.1'); assert.equal(upstream.pathname, configured.pathname);
  assert.equal(upstream.username, configured.username); assert.equal(upstream.password, configured.password);
  assert.notEqual(Number(upstream.port), config.pgPort);
  assert.equal(manifest.taskId === 'REP-05', config.pgPort != null);
  assert.ok(Number.isFinite(Date.parse(config.deadlineAt)) && (allowExpired || Date.parse(config.deadlineAt) > Date.now()) && Date.parse(config.deadlineAt) <= Date.now() + 4800 * 1000, 'Prelocked fault window must be finite and current');
  for (const [file, hash] of Object.entries(manifest.fault.codeHashes)) {
    assert.match(file, /^tests\/(?:helpers\/report-fault-[a-z-]+\.mjs|helpers\/autonomy-web-restart\.mjs|autonomy-evidence\.acceptance\.mjs)$/);
    assert.equal(sha256(await readFile(file)), hash, `Changed fault implementation: ${file}`);
  }
  const receiptPath = resolve(manifest.fault.receiptFile), root = resolve('.data/autonomy-isolation');
  assert.equal(await realpath(resolve(receiptPath, '..')), await realpath(root), 'Receipt must be directly in the owned isolation directory');
  return { config, fixture, manifest, upstream, receiptPath };
}
export function reportFaultAuthorized(header, key) {
  const expected = Buffer.from(`Bearer ${key}`), actual = Buffer.from(header ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Minimal control plane with injected actual SQL/API operations. A fault is
 * armed once per fresh workspace/thread, before V receives the normal prompt. */
export function reportFaultController({ manifest, deadlineAt, journal, verifyArm, queueIdentity, currentItem, patchItem, now = () => Date.now() }) {
  const states = new Map(), locks = new Map();
  const live = state => now() < Math.min(Date.parse(deadlineAt), Date.parse(state.armedAt) + manifest.observationSeconds * 1000);
  const serial = (key, fn) => { const next = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn); locks.set(key, next); return next; };
  const record = async (state, update) => { Object.assign(state, update); await journal(publicState(state)); };
  const publicState = state => Object.fromEntries(Object.entries(state).filter(([key]) => !['cookie'].includes(key)));
  const match = identity => [...states.values()].find(state => state.workspaceId === identity.workspaceId && state.state === 'armed' && live(state));
  return {
    async arm({ workspaceId, threadId, promptSha256 }) {
      return serial(workspaceId, async () => {
        assert.ok(!states.has(workspaceId), 'This workspace was already armed; failed trials cannot be replaced');
        const trial = manifest.trials.find(t => t.workspaceId === workspaceId); assert.ok(trial);
        assert.match(threadId, /^[a-zA-Z0-9_-]{1,150}$/); assert.match(promptSha256, /^[a-f0-9]{64}$/);
        assert.ok(now() < Date.parse(deadlineAt)); const authorization = await verifyArm(trial, threadId);
        const state = { workspaceId, threadId, userId: authorization.userId, cookie: authorization.cookie, promptSha256, state: 'armed', armedAt: new Date(now()).toISOString() };
        states.set(workspaceId, state); await journal(publicState(state)); return publicState(state);
      });
    },
    async commit(candidate, signal) {
      if (manifest.taskId !== 'REP-05' || signal.aborted) return false;
      const row = await queueIdentity(candidate); if (!row) return false;
      return serial(row.workspaceId, async () => {
        const state = states.get(row.workspaceId); if (!state || state.state !== 'armed' || !live(state) || signal.aborted || row.threadId !== state.threadId || row.userId !== state.userId) return false;
        await record(state, { ...row, state: 'commit_verified', physicalBoundary: 'postgres_backend_commit_before_client_ack', connectionId: candidate.connectionId, committedObservedAt: new Date(now()).toISOString() });
        if (signal.aborted) return false;
        return true;
      });
    },
    async dropped(candidate) {
      const state = [...states.values()].find(s => s.state === 'commit_verified' && s.reportId === candidate.reportId && s.snapshotId === candidate.snapshotId && s.connectionId === candidate.connectionId); assert.ok(state);
      await record(state, { state: 'commit_ack_dropped', droppedAt: candidate.droppedAt });
    },
    async matches(identity) {
      if (manifest.taskId !== 'REP-06') return false;
      const state = match(identity); if (!state) return false;
      const row = await queueIdentity(identity); return !!row && row.threadId === state.threadId && row.userId === state.userId && live(state);
    },
    async response(identity, signal) {
      assert.equal(manifest.taskId, 'REP-06');
      return serial(identity.workspaceId, async () => {
        const state = match(identity); assert.ok(state && !signal.aborted, 'Freshness fault window unavailable');
        const row = await queueIdentity(identity); assert.ok(row && row.threadId === state.threadId && row.userId === state.userId && live(state));
        const trial = manifest.trials.find(t => t.workspaceId === state.workspaceId), mutation = trial.mutation;
        assert.ok(identity.evidence.some(ref => ref.id === `item:${mutation.itemId}`), 'Writer did not actually read the selected mutable source');
        const item = await currentItem(state.workspaceId, mutation.itemId);
        assert.equal(item.version, mutation.version); assert.equal(fingerprint(item.content), mutation.contentHash); assert.equal(item.content.kind, 'text');
        assert.equal(item.provenance.origin, 'tool'); signal.throwIfAborted(); assert.ok(live(state));
        await record(state, { ...row, state: 'owner_patch_started', itemId: mutation.itemId, beforeVersion: item.version,
          requestSha256: identity.requestSha256, providerResponseSha256: identity.providerResponseSha256, providerCompletedAt: identity.providerCompletedAt });
        // One ordinary owner request, no internal API and no retry on unknown.
        try {
          const saved = await patchItem(state, item, mutation.replacementText, signal);
          assert.equal(saved.id, mutation.itemId); assert.equal(saved.version, mutation.version + 1);
          const observed = await currentItem(state.workspaceId, mutation.itemId);
          assert.equal(observed.version, saved.version); assert.equal(observed.content.text, mutation.replacementText); assert.equal(observed.provenance.origin, 'user');
          signal.throwIfAborted(); assert.ok(live(state));
          await record(state, { state: 'source_changed_response_released', afterVersion: observed.version, changedAt: new Date(now()).toISOString(), releasedAt: new Date(now()).toISOString() });
          return { released: true, requestSha256: identity.requestSha256 };
        } catch (error) { await record(state, { state: 'owner_patch_failed_or_unknown', failedAt: new Date(now()).toISOString() }); throw error; }
      });
    },
    receipt(workspaceId) { const state = states.get(workspaceId); return state ? publicState(state) : null; },
  };
}
export const appendReportFaultReceipt = (path, metadata) => async receipt => appendFile(path, JSON.stringify({ ...metadata, ...receipt }) + '\n', { encoding: 'utf8', flag: 'a' });
