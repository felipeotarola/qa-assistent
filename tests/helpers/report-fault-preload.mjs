// Explicit isolated web-process preload; the ordinary build is inert.
import assert from 'node:assert/strict';
import { reportBarrierFetch } from './report-fault-provider.mjs';
import { loadReportFaultRuntime } from './report-fault-runtime.mjs';

export async function installReportFaultPreload(configFile) {
  assert.equal(process.env.SYNA_REPORT_FAULT_PRELOAD, '1');
  const config = await loadReportFaultRuntime(configFile, { runtime: process.env.PAT_RUNTIME_SCOPE, cwd: process.cwd() });
  const original = globalThis.fetch.bind(globalThis);
  const request = async (path, body, signal) => {
    const response = await original(config.controlOrigin + path, { method: 'POST', headers: { authorization: `Bearer ${config.controlKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(3000), redirect: 'error' });
    assert.equal(response.status, 200, 'Fault driver did not verify this exact boundary'); return response.json();
  };
  globalThis.fetch = reportBarrierFetch(original, { maxHoldMs: config.maxHoldMs,
    match: async identity => Date.now() < Date.parse(config.deadlineAt) && (await request('/provider/match', identity)).allowed === true,
    afterResponse: (identity, signal) => request('/provider/response', identity, signal),
  });
  const receipt = await request('/preload-ready', { pid: process.pid, runtime: config.runtime, sourceHash: config.sourceHash,
    manifestSha256: config.manifestSha256, nonce: config.nonce, helperHashes: config.helperHashes, serviceRoot: config.serviceRoot });
  assert.equal(receipt.ready, true); assert.equal(receipt.nonce, config.nonce);
}
if (process.env.SYNA_REPORT_FAULT_PRELOAD === '1') {
  assert.ok(process.env.SYNA_REPORT_FAULT_RUNTIME, 'An explicit frozen runtime configuration is required');
  await installReportFaultPreload(process.env.SYNA_REPORT_FAULT_RUNTIME);
}
