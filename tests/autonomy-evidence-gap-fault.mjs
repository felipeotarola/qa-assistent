// External fault driver only. It never submits a model message, calls a queue,
// writes SQL, restarts a worker or provisions fixtures. Opt-in --arm requires
// the runtime owner's separate fault window. --restore only restores originals.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import postgres from 'postgres';
import { readIsolationFixture, isolatedProcessEnvironment } from './helpers/autonomy-isolation.mjs';
import { isolatedAppEnvironment, verifyIsolatedAppArtifacts } from './helpers/start-isolated-app.mjs';
import { observeEvidence } from './helpers/evidence-observer.mjs';
import { utcObservationTypes } from './helpers/utc-postgres-observation.mjs';
import { sha256, fingerprint, validateEvidenceManifest } from './helpers/evidence-acceptance.mjs';
import { GAP_FAULT_PROTOCOL, validateGapFaultManifest, gapFaultClock, gapTrialClock, gapDeadlineOpen, selectGapCaptures, gapReadProof, createGapFileStore } from './helpers/evidence-gap-fault.mjs';

const arg = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const mode = ['--validate', '--arm', '--restore'].filter(m => process.argv.includes(m)); assert.equal(mode.length, 1, 'Choose --validate, --arm, or --restore');
const root = resolve('.data/autonomy-isolation');
async function privatePath(path, existing = true) {
  const candidate = resolve(path), actual = existing ? await realpath(candidate) : candidate, sub = relative(root, actual);
  assert.ok(sub && !sub.startsWith(`..${sep}`) && sub !== '..' && !isAbsolute(sub) && actual === candidate, 'Fault files must stay under canonical owned isolation root');
  if (existing) assert.ok((await stat(actual)).isFile() && (await stat(actual)).size <= 32 * 1024 * 1024);
  return actual;
}
if (mode[0] === '--restore') {
  const path = await privatePath(arg('receipt')), receipt = JSON.parse(await readFile(path));
  assert.equal(receipt.protocol, GAP_FAULT_PROTOCOL);
  const fixture = await readIsolationFixture(); isolatedProcessEnvironment(fixture); const environment = isolatedAppEnvironment(fixture, 'web');
  assert.equal(receipt.runtime, fixture.runtimeScope);
  for (const trial of receipt.trials) {
    const journal = await privatePath(resolve(trial.journalRoot, 'journal.jsonl'));
    const store = await createGapFileStore({ storageRoot: environment.SYNA_ISOLATED_STORAGE_ROOT, journalRoot: resolve(journal, '..'), scope: trial.scope, recover: true });
    try { await store.restore(); } finally { await store.close(); }
  }
  receipt.restoredByRecoveryAt = new Date().toISOString(); await writeFile(path, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ result: 'restored', receipt: path, databaseWrites: 0, modelCalls: 0 }));
} else {
  const path = await privatePath(arg('manifest')), manifestBytes = await readFile(path), m = validateGapFaultManifest(JSON.parse(manifestBytes));
  const acceptedBytes = await readFile(await privatePath(m.acceptanceManifest)); assert.equal(sha256(acceptedBytes), m.acceptanceManifestSha256);
  const accepted = validateEvidenceManifest(JSON.parse(acceptedBytes), { execute: true });
  assert.equal(accepted.taskId, 'GAP-13'); assert.equal(accepted.variant, m.variant); assert.equal(accepted.sourceHash, m.sourceHash); assert.equal(accepted.runtime, m.runtime);
  assert.equal(accepted.observationSeconds, m.perTrialSeconds, 'Per-trial physical budget differs from acceptance observation budget');
  assert.deepEqual(accepted.trials.map(t => t.workspaceId), m.trials.map(t => t.workspaceId));
  const driverSha256 = sha256(await readFile('tests/autonomy-evidence-gap-fault.mjs')), helperSha256 = sha256(await readFile('tests/helpers/evidence-gap-fault.mjs'));
  assert.equal(m.helperSha256, helperSha256, 'Imported physical-fault helper changed after locking the manifest');
  assert.equal(accepted.fault?.driverSha256, driverSha256); assert.equal(accepted.fault.fixtureSha256, m.fixture.sha256);
  const fixturePath = resolve(m.fixture.path), fixtureSub = relative(resolve('tests/fixtures'), fixturePath);
  assert.ok(fixtureSub && !fixtureSub.startsWith(`..${sep}`) && !isAbsolute(fixtureSub)); assert.equal(sha256(await readFile(fixturePath)), m.fixture.sha256);
  assert.ok(accepted.trials.every(t => new URL(t.url).origin === m.fixture.origin));
  const output = await privatePath(accepted.fault.receiptFile, false);
  if (mode[0] === '--validate') console.log(JSON.stringify({ protocol: GAP_FAULT_PROTOCOL, result: 'validated', driverSha256, helperSha256, modelCalls: 0, networkRequests: 0 }));
  else {
    assert.ok(process.argv.includes('--exclusive-fault-window'), 'Runtime owner must authorize a separate physical-fault window');
    const fixture = await readIsolationFixture(); isolatedProcessEnvironment(fixture); const environment = isolatedAppEnvironment(fixture, 'web');
    assert.equal(fixture.runtimeScope, m.runtime); assert.equal(fixture.app.sourceSha256, m.sourceHash);
    const build = await verifyIsolatedAppArtifacts(fixture, { requireRuntime: true }); assert.equal(build.sourceSha256, m.sourceHash);
    const sql = postgres(fixture.databaseUrl, { max: 1, prepare: false, types: utcObservationTypes, connection: { TimeZone: 'UTC', default_transaction_read_only: 'on' } });
    const clock = gapFaultClock(m, new Date().toISOString());
    const receipt = { protocol: GAP_FAULT_PROTOCOL, sourceHash: m.sourceHash, runtime: m.runtime, variant: m.variant, driverSha256, helperSha256,
      fixtureSha256: m.fixture.sha256, manifestSha256: sha256(manifestBytes), ...clock, result: 'preparing',
      clockPolicy: 'Global wall-clock from arm; per-trial from persisted mission.created_at clipped to global deadline. Acceptance separately observes from intake acknowledgement.',
      noDatabaseMutation: true, modelCalls: 0, faultBoundary: 'saved-evidence file read; not a failed website operation', trials: [], receipts: [], gate: false };
    await writeFile(output, JSON.stringify(receipt, null, 2), { flag: 'wx' });
    const persist = () => writeFile(output, JSON.stringify(receipt, null, 2)); const stores = [];
    let stopped = false; const stop = () => { stopped = true; }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      assert.equal((await sql`show transaction_read_only`)[0].transaction_read_only, 'on');
      for (const t of m.trials) {
        assert.equal((await sql`select user_id from pat_workspaces where id=${t.workspaceId}`)[0]?.user_id, t.userId);
        const baseline = await observeEvidence(sql, t.workspaceId, m.runtime);
        assert.equal(baseline.missions.length + baseline.runs.length + baseline.items.length + baseline.claims.length, 0, 'Fault needs a fresh empty workspace before prompt');
        const scope = { workspaceId: t.workspaceId, userId: t.userId, sourceHash: m.sourceHash }, journalRoot = resolve(root, `evidence-gap-journal-${randomUUID()}`);
        const slot = { t, caseKey: null, closed: false, restored: false, clock: null };
        const store = await createGapFileStore({ storageRoot: environment.SYNA_ISOLATED_STORAGE_ROOT, journalRoot, scope, assertBeforeFault: () => {
          assert.ok(gapDeadlineOpen(clock) && slot.clock && gapDeadlineOpen(slot.clock), 'Fixed physical fault deadline elapsed');
        } });
        slot.store = store; stores.push(slot); receipt.trials.push({ scope, journalRoot, baselineHash: fingerprint(baseline) });
      }
      assert.ok(gapDeadlineOpen(clock), 'Arm preparation exhausted the fixed global fault window');
      receipt.readyAt = new Date().toISOString(); receipt.result = 'armed'; await persist();
      console.log(JSON.stringify({ result: 'armed', receipt: output, next: 'Start the prelocked ordinary acceptance once; do not drain or drive continuations.' }));
      while (!stopped && gapDeadlineOpen(clock) && !stores.every(s => s.closed || s.expired)) {
        for (const slot of stores.filter(s => !s.closed && !s.expired)) {
          if (!gapDeadlineOpen(clock)) break;
          const state = await observeEvidence(sql, slot.t.workspaceId, m.runtime);
          state.missions = [...await sql`select id,workspace_id,user_id,runtime,controller_version,thread_id,plan_revision,lifecycle,created_at from pat_missions where workspace_id=${slot.t.workspaceId} and user_id=${slot.t.userId} and runtime=${m.runtime}`];
          state.runs = [...await sql`select id,workspace_id,item_id,case_id,snapshot,target,runtime,thread_id,started_at,mission_attempt_id from pat_test_runs where workspace_id=${slot.t.workspaceId} and runtime=${m.runtime}`];
          state.captures = [...await sql`select c.id,c.run_id,c.item_id,c.url,c.error,c.created_at,i.blob_path,i.version,i.deleted_at,i.provenance from pat_test_captures c join pat_test_runs r on r.id=c.run_id join pat_workspace_items i on i.id=c.item_id where r.workspace_id=${slot.t.workspaceId} and r.runtime=${m.runtime}`];
          // Browser jobs are bound by the immutable dispatch ID; executor_resource_id may be null.
          // Keep this fault-only authority projection separate from historical observer fingerprints.
          state.gapBrowserBindings = [...await sql`select a.id,a.mission_id,a.task_id,a.dispatch_id,a.executor_resource_id,a.runtime,a.kind,m.thread_id,m.workspace_id,m.user_id,b.id as job_id,b.thread_id as job_thread_id,b.runtime as job_runtime,b.session_id,t.workspace_id as job_workspace_id,t.user_id as job_user_id from pat_mission_attempts a join pat_missions m on m.id=a.mission_id join pat_browser_jobs b on b.id=a.dispatch_id join pat_threads t on t.id=b.thread_id where m.workspace_id=${slot.t.workspaceId} and m.user_id=${slot.t.userId} and m.runtime=${m.runtime} and a.kind='browser_tests'`];
          if (state.missions.length === 1) slot.clock = gapTrialClock(clock, state.missions[0], slot.clock);
          const saved = receipt.trials.find(t => t.scope.workspaceId === slot.t.workspaceId);
          if (slot.clock) saved.clock = slot.clock;
          slot.expired = !gapDeadlineOpen(clock) || !!slot.clock && !gapDeadlineOpen(slot.clock);
          if (slot.expired) { await slot.store.restore(); slot.restored = true; saved.expiredAt = new Date().toISOString(); }
          if (!slot.restored && !slot.expired) {
            const selected = selectGapCaptures(state, m, slot.t, receipt.armedAt, slot.caseKey); slot.caseKey = selected.caseKey;
            for (const capture of selected.captures) {
              // Recheck after every awaited file operation; no new fault starts
              // once either inherited deadline has elapsed.
              if (!gapDeadlineOpen(clock) || slot.clock && !gapDeadlineOpen(slot.clock)) break;
              await slot.store.quarantine(capture, state.runs.find(r => r.id === capture.run_id));
            }
          }
          const planned = slot.store.rows().filter(r => r.kind === 'planned'), proof = gapReadProof(state, planned);
          const complements = state.tasks.filter(t => t.spec?.complement && planned.some(r => r.runId === t.spec.complement.runId));
          slot.closed = state.missions.length === 1 && state.missions[0].lifecycle === 'closed';
          if (slot.closed || m.variant === 'resolvable' && complements.length) { await slot.store.restore(); slot.restored = true; }
          Object.assign(saved, { caseKey: slot.caseKey, proof, closed: slot.closed, restored: slot.restored });
          receipt.receipts = stores.flatMap(s => s.store.rows().filter(r => r.kind === 'planned').map(r => ({ workspaceId: s.t.workspaceId, threadId: r.threadId,
            runId: r.runId, actionId: r.actionId, itemId: r.itemId, sha256: r.sha256, bytes: r.bytes, originalRunIdentityHash: r.originalRunIdentityHash,
            physicalBoundary: true, noDatabaseMutation: true, restoredAt: s.store.rows().find(x => x.kind === 'restored' && x.itemId === r.itemId)?.at ?? null })));
          await persist();
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      receipt.result = stores.every(s => s.closed && !s.expired) && receipt.trials.every(t => t.proof?.some(p => p.observedReadMiss)) ? 'physical_read_miss_observed' : 'incomplete';
      if (!gapDeadlineOpen(clock)) receipt.deadlineExceededAt = new Date().toISOString();
    } catch (error) { receipt.result = 'failed'; receipt.error = String(error.message).slice(0, 500); process.exitCode = 1; }
    finally {
      for (const slot of stores) {
        try { await slot.store.restore(); receipt.trials.find(t => t.scope.workspaceId === slot.t.workspaceId).restored = true; }
        catch { receipt.result = 'restore_failed'; receipt.restoreRequired = true; process.exitCode = 1; }
        finally { await slot.store.close(); }
      }
      for (const row of receipt.receipts) row.restoredAt = stores.find(s => s.t.workspaceId === row.workspaceId)?.store.rows().find(r => r.kind === 'restored' && r.itemId === row.itemId)?.at ?? null;
      receipt.finishedAt = new Date().toISOString(); await persist(); await sql.end(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    }
    console.log(JSON.stringify({ result: receipt.result, receipt: output, gate: false, modelCalls: 0, limitation: 'Actual typed-gap/continuation and prose oracles run separately.' }));
  }
}
