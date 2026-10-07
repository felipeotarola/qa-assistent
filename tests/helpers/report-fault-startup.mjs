import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadReportFaultConfig } from './report-fault-control.mjs';
import { assertIsolatedDatabaseUrl } from './autonomy-isolation.mjs';
import { reportFaultRuntimeFiles, runtimeDigest, loadReportFaultRuntime } from './report-fault-runtime.mjs';

export function reportFaultDatabaseUrl(fixtureUrl, loaded) {
  const direct = new URL(assertIsolatedDatabaseUrl(fixtureUrl));
  assert.equal(assertIsolatedDatabaseUrl(loaded.config.upstreamDatabaseUrl), direct.toString(), 'Fault upstream must be the exact bound fixture database');
  if (loaded.manifest.taskId !== 'REP-05') return direct.toString();
  assert.ok(Number.isInteger(loaded.config.pgPort) && loaded.config.pgPort > 1024 && loaded.config.pgPort < 65536);
  assert.notEqual(String(loaded.config.pgPort), direct.port);
  assert.equal(direct.hostname, '127.0.0.1'); direct.port = String(loaded.config.pgPort);
  return assertIsolatedDatabaseUrl(direct.toString());
}
export async function reportFaultStartup(configFile, fixture, source, root, { allowExpired = false } = {}) {
  const loaded = await loadReportFaultConfig(configFile, { allowExpired });
  assert.equal(loaded.fixture.runtimeScope, fixture.runtimeScope); assert.equal(loaded.fixture.databaseUrl, fixture.databaseUrl);
  assert.equal(loaded.manifest.sourceHash, source.sourceSha256); assert.equal(loaded.manifest.runtime, fixture.runtimeScope);
  assert.ok(['REP-05', 'REP-06'].includes(loaded.manifest.taskId), 'Saved wrong-run input needs no runtime hook');
  const helperHashes = {};
  for (const file of reportFaultRuntimeFiles) {
    assert.ok(source.files.includes(file), 'Prepare a new snapshot that freezes the fault preload before building');
    const hash = runtimeDigest(await readFile(resolve(root, 'web', file)));
    assert.equal(hash, loaded.manifest.fault.codeHashes[file]);
    assert.equal(runtimeDigest(await readFile(resolve(root, 'eve', file))), hash);
    helperHashes[file] = hash;
  }
  const binding = { protocol: loaded.manifest.protocol, manifestSha256: loaded.config.manifestSha256, codeHashes: loaded.manifest.fault.codeHashes,
    kind: loaded.manifest.taskId === 'REP-05' ? 'pg-commit-ack' : 'provider-response-barrier' };
  const databaseUrl = reportFaultDatabaseUrl(fixture.databaseUrl, loaded);
  return { ...loaded, helperHashes, binding, databaseUrl, configFile: resolve(configFile),
    buildBinding: loaded.manifest.taskId === 'REP-05' ? { protocol: binding.protocol, manifestSha256: binding.manifestSha256, databaseUrlSha256: runtimeDigest(databaseUrl) } : null };
}
export async function reportFaultDriverReady(fault) {
  const response = await fetch(`http://127.0.0.1:${fault.config.controlPort}/ready`, { headers: { authorization: `Bearer ${fault.config.controlKey}` }, redirect: 'error', signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200); const ready = await response.json();
  assert.equal(ready.expired, false); assert.equal(ready.runtime, fault.manifest.runtime); assert.equal(ready.sourceHash, fault.manifest.sourceHash);
  assert.equal(ready.manifestSha256, fault.config.manifestSha256); assert.equal(ready.pgPort, fault.config.pgPort ?? null);
  return ready;
}
export async function createReportFaultRuntime(fault, root) {
  assert.equal(fault.manifest.taskId, 'REP-06');
  const config = { kind: 'syna-report-fault-preload', version: 1, serviceRoot: resolve(root, 'web'), runtime: fault.manifest.runtime,
    sourceHash: fault.manifest.sourceHash, manifestSha256: fault.config.manifestSha256, nonce: randomBytes(32).toString('hex'),
    controlOrigin: `http://127.0.0.1:${fault.config.controlPort}`, controlKey: fault.config.controlKey,
    deadlineAt: fault.config.deadlineAt, maxHoldMs: 10000, helperHashes: fault.helperHashes };
  const bytes = JSON.stringify(config), path = resolve(root, `report-fault-runtime-${runtimeDigest(bytes)}.json`);
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  await loadReportFaultRuntime(path, { runtime: config.runtime, cwd: config.serviceRoot });
  return { path, nonce: config.nonce };
}
export async function verifyReportFaultRuntime(fault, runtime, root) {
  assert.deepEqual(runtime.reportFault, fault.binding); assert.equal(runtime.reportFaultConfigFile, fault.configFile);
  if (fault.manifest.taskId === 'REP-06') {
    const value = await loadReportFaultRuntime(runtime.reportFaultStartup.path, { runtime: fault.manifest.runtime, cwd: resolve(root, 'web'), allowExpired: true });
    assert.equal(value.manifestSha256, fault.config.manifestSha256); assert.equal(value.sourceHash, fault.manifest.sourceHash);
    assert.equal(value.nonce, runtime.reportFaultStartup.receipt.nonce); assert.equal(runtime.reportFaultStartup.receipt.pid, runtime.web.pid);
    assert.deepEqual(runtime.reportFaultStartup.receipt.helperHashes, fault.helperHashes);
  }
}
