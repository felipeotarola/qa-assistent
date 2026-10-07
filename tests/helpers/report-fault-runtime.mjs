// Frozen Node-only runtime surface. No app, database, fixture or checkout import.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const reportFaultRuntimeFiles = ['report-fault-runtime.mjs', 'report-fault-preload.mjs', 'report-fault-provider.mjs'].map(name => `tests/helpers/${name}`);
export const runtimeDigest = value => createHash('sha256').update(value).digest('hex');
export function validateReportFaultRuntime(value, { runtime, cwd, now = Date.now(), allowExpired = false }) {
  assert.equal(value.kind, 'syna-report-fault-preload'); assert.equal(value.version, 1);
  assert.equal(value.runtime, runtime); assert.match(runtime, /^autonomy-test:[a-z0-9-]+$/);
  assert.equal(value.serviceRoot, resolve(cwd)); assert.equal(resolve(dirname(value.serviceRoot), 'web'), value.serviceRoot);
  for (const field of ['sourceHash', 'manifestSha256', 'nonce', 'controlKey']) assert.match(value[field], /^[a-f0-9]{64}$/);
  const origin = new URL(value.controlOrigin); assert.equal(origin.protocol, 'http:'); assert.equal(origin.hostname, '127.0.0.1');
  assert.equal(origin.origin, value.controlOrigin); assert.ok(Number(origin.port) > 1024 && Number(origin.port) < 65536);
  assert.equal(value.maxHoldMs, 10000);
  assert.ok(Number.isFinite(Date.parse(value.deadlineAt)) && (allowExpired || Date.parse(value.deadlineAt) > now) && Date.parse(value.deadlineAt) <= now + 4800_000);
  assert.deepEqual(Object.keys(value.helperHashes).sort(), [...reportFaultRuntimeFiles].sort());
  assert.ok(Object.values(value.helperHashes).every(hash => /^[a-f0-9]{64}$/.test(hash)));
  return value;
}
export async function loadReportFaultRuntime(path, context) {
  const actual = await realpath(path); assert.equal(actual, resolve(path));
  assert.equal(dirname(actual), dirname(resolve(context.cwd)), 'Runtime configuration must be in the owned application root');
  const bytes = await readFile(actual); assert.ok(bytes.length < 10000);
  const value = validateReportFaultRuntime(JSON.parse(bytes), context);
  assert.equal(actual, resolve(dirname(value.serviceRoot), `report-fault-runtime-${runtimeDigest(bytes)}.json`));
  for (const [file, expected] of Object.entries(value.helperHashes)) {
    const resolved = resolve(value.serviceRoot, file); assert.equal(await realpath(resolved), resolved);
    assert.equal(runtimeDigest(await readFile(resolved)), expected, 'Frozen preload helper changed');
  }
  return value;
}
