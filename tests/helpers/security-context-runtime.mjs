// Strict, private, inert configuration. No app/database/model imports.
import assert from 'node:assert/strict';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { securityContextDigest } from './security-context-provider.mjs';

export const securityContextFiles = ['provider', 'runtime', 'preload', 'audit', 'control'].map(name => `tests/helpers/security-context-${name}.mjs`);
export const securityContextIntegrationFiles = [...securityContextFiles, 'tests/helpers/security-context-startup.mjs'];
export const SECURITY_CONTEXT_SCOPE = 'decoded-provider-request-canaries';
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function validateSecurityContextObservation(value) {
  assert.deepEqual(Object.keys(value ?? {}).sort(), ['version', 'scope', 'helperHashes'].sort());
  assert.equal(value.version, 1); assert.equal(value.scope, SECURITY_CONTEXT_SCOPE);
  assert.deepEqual(Object.keys(value.helperHashes ?? {}).sort(), [...securityContextIntegrationFiles].sort());
  assert.ok(Object.values(value.helperHashes).every(hash));
  return value;
}
export function validateSecurityContextConfig(value, { cwd, runtime, now = Date.now(), allowExpired = false }) {
  assert.deepEqual(Object.keys(value).sort(), ['kind', 'version', 'service', 'serviceRoot', 'runtime', 'sourceHash', 'manifestHash', 'nonce', 'issuedAt', 'deadlineAt', 'helperHashes', 'canaries', 'trialPromptHashes'].sort());
  assert.equal(value.kind, 'syna-security-context-observer'); assert.equal(value.version, 1);
  assert.ok(['web', 'eve'].includes(value.service)); assert.equal(value.serviceRoot, resolve(cwd));
  assert.equal(resolve(dirname(value.serviceRoot), value.service), value.serviceRoot);
  assert.equal(value.runtime, runtime); assert.match(runtime, /^autonomy-test:[a-z0-9-]+$/);
  for (const key of ['sourceHash', 'manifestHash', 'nonce']) assert.ok(hash(value[key]));
  const issued = Date.parse(value.issuedAt), end = Date.parse(value.deadlineAt);
  assert.ok(Number.isFinite(issued) && issued <= now && (allowExpired || now - issued <= 7200000));
  assert.ok(Number.isFinite(end) && end > issued && (allowExpired || end > now) && end - issued <= 7200000);
  assert.deepEqual(Object.keys(value.helperHashes).sort(), [...securityContextFiles].sort());
  assert.ok(Object.values(value.helperHashes).every(hash));
  assert.ok(Array.isArray(value.canaries) && value.canaries.length > 0 && value.canaries.length <= 100
    && value.canaries.every(v => /^evidence-owner-marker-[a-f0-9]{16,64}$/.test(v)) && new Set(value.canaries).size === value.canaries.length);
  assert.ok(Array.isArray(value.trialPromptHashes) && value.trialPromptHashes.length > 0 && value.trialPromptHashes.length <= 20
    && value.trialPromptHashes.every(hash) && new Set(value.trialPromptHashes).size === value.trialPromptHashes.length);
  return value;
}
export async function loadSecurityContextConfig(path, context) {
  const actual = await realpath(path); assert.equal(actual, resolve(path));
  assert.equal(dirname(actual), dirname(resolve(context.cwd)));
  const info = await stat(actual); assert.ok(info.isFile() && info.size <= 32768);
  const bytes = await readFile(actual); assert.ok(bytes.length <= 32768);
  const value = validateSecurityContextConfig(JSON.parse(bytes), context), configHash = securityContextDigest(bytes);
  assert.equal(actual, resolve(dirname(value.serviceRoot), `security-context-${configHash}.json`));
  for (const [file, expected] of Object.entries(value.helperHashes)) {
    const path = resolve(value.serviceRoot, file); assert.equal(await realpath(path), path);
    assert.equal(securityContextDigest(await readFile(path)), expected, 'Frozen observer helper changed');
  }
  return { value, configHash };
}
