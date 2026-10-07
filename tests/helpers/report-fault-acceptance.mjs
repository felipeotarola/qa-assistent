import assert from 'node:assert/strict';
import { loadReportFaultConfig } from './report-fault-control.mjs';
import { validateReportFaultPreparation, auditReportFaultCompletion } from './report-fault-contract.mjs';
import { validateEvidenceSeed, fingerprint } from './evidence-acceptance.mjs';
import { reportLogBoundary, readReportFreshnessDiagnostics } from './report-fault-diagnostics.mjs';

/** Optional adapter; the ordinary evidence harness remains the natural-intake
 * driver. No internal queues or service functions are exposed here. */
export async function reportFaultAcceptance(manifest, mode) {
  const loaded = await loadReportFaultConfig(manifest.fault.configFile, { allowExpired: mode === '--audit' });
  assert.equal(fingerprint(loaded.manifest), fingerprint(manifest));
  const logBoundaries = new Map();
  async function control(path, body) {
    assert.ok(loaded); const response = await fetch(`http://127.0.0.1:${loaded.config.controlPort}${path}`, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${loaded.config.controlKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200, 'Report fault driver did not confirm the exact boundary'); return response.json();
  }
  return {
    validatePreparation: (artifact, context) => validateReportFaultPreparation(artifact, { ...context, manifest, trial: manifest.trials.find(t => t.workspaceId === context.workspaceId) }),
    validateSeed(seed, trial) {
      const ordinary = manifest.taskId === 'REP-07' ? { ...seed, runs: seed.runs.filter(run => run.id !== trial.wrongRun.registeredRunId), captures: seed.captures.filter(c => c.run_id !== trial.wrongRun.registeredRunId) } : seed;
      validateEvidenceSeed(manifest.taskId, 'normal', ordinary, manifest.runtime, 'synthetic-golden');
    },
    async freeze(runtime) {
      // Startup integration must attest the actual compiled PG destination or
      // the web-process preload, never merely an environment variable claim.
      const expected = { protocol: manifest.protocol, manifestSha256: loaded.config.manifestSha256, codeHashes: manifest.fault.codeHashes,
        kind: manifest.taskId === 'REP-05' ? 'pg-commit-ack' : manifest.taskId === 'REP-06' ? 'provider-response-barrier' : 'synthetic-preparation-only' };
      if (manifest.taskId === 'REP-07') return expected; // Saved fault data needs no transport or runtime hook.
      assert.deepEqual(runtime.reportFault, expected, 'Runtime needs the separately verified fault integration before this acceptance can run');
      if (mode === '--audit') return { ...expected, liveDriver: 'not_observed_read_only_audit' };
      const ready = await control('/ready'); assert.equal(ready.expired, false); assert.equal(ready.manifestSha256, loaded.config.manifestSha256);
      assert.equal(ready.runtime, manifest.runtime); assert.equal(ready.sourceHash, manifest.sourceHash);
      return expected;
    },
    async arm(trial, threadId, promptSha256) {
      assert.equal(mode, '--execute');
      if (manifest.taskId === 'REP-07') return { state: 'synthetic_preparation_locked', workspaceId: trial.workspaceId, threadId, promptSha256 };
      if (manifest.taskId === 'REP-06') logBoundaries.set(trial.workspaceId, await reportLogBoundary(loaded.fixture.app.root));
      return control('/arm', { workspaceId: trial.workspaceId, threadId, promptSha256 });
    },
    receipt: trial => manifest.taskId === 'REP-07' ? null : control(`/receipt?workspaceId=${encodeURIComponent(trial.workspaceId)}`),
    async audit(trial, before, after, threadId, sql) {
      const receipt = manifest.taskId === 'REP-07' ? null : await control(`/receipt?workspaceId=${encodeURIComponent(trial.workspaceId)}`);
      const freshnessProof = manifest.taskId === 'REP-06' ? await readReportFreshnessDiagnostics(logBoundaries.get(trial.workspaceId), receipt?.reportId) : null;
      const result = auditReportFaultCompletion(manifest, trial, before, after, threadId, receipt, freshnessProof);
      if (manifest.taskId === 'REP-05') {
        const [report] = await sql`select snapshot_id from pat_mission_reports where id=${receipt.reportId}`;
        assert.equal(report?.snapshot_id, receipt.snapshotId, 'Lost receipt recovery changed the queued snapshot');
      }
      // The established harness persists result as attempt.oracle. Keep the
      // proof there too, without changing an active normal harness's bytes.
      return { result: { ...result, ...(freshnessProof ? { freshnessProof } : {}) }, receipt, freshnessProof };
    },
  };
}
