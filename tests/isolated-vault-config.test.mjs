import assert from 'node:assert/strict';
import test from 'node:test';
import { isolatedProcessEnvironment } from './helpers/autonomy-isolation.mjs';
const fixture = () => ({ databaseUrl: 'postgres://test:test@127.0.0.1:5432/syna_test_autonomy_config', runtimeScope: 'autonomy-test:config', internalApiSecret: 'x'.repeat(40) });
test('isolated provider pacing is explicit and bounded, never inherited from ambient configuration', () => {
  const old = process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS;
  try {
    process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS = '18000';
    assert.equal(isolatedProcessEnvironment(fixture()).GRUNDEN_MIN_REQUEST_INTERVAL_MS, '0');
    assert.equal(isolatedProcessEnvironment(fixture(), { modelRequestIntervalMs: 6000 }).GRUNDEN_MIN_REQUEST_INTERVAL_MS, '6000');
    for (const interval of [-1, 30001, NaN, Infinity, 1.5, '6000']) assert.throws(() => isolatedProcessEnvironment(fixture(), { modelRequestIntervalMs: interval }));
  } finally { if (old === undefined) delete process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS; else process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS = old; }
});
test('isolated Vault uses only its explicit private fixture key, never ambient encryption configuration', () => {
  const old = process.env.ENV_VAULT_KEY;
  try {
    process.env.ENV_VAULT_KEY = 'shared-key-that-must-not-enter-the-test';
    assert.equal(isolatedProcessEnvironment(fixture()).ENV_VAULT_KEY, '');
    assert.equal(isolatedProcessEnvironment({ ...fixture(), vault: { key: 'ab'.repeat(32) } }).ENV_VAULT_KEY, 'ab'.repeat(32));
    for (const key of ['', 'a'.repeat(63), 'g'.repeat(64), process.env.ENV_VAULT_KEY]) assert.throws(() => isolatedProcessEnvironment({ ...fixture(), vault: { key } }), /own 32-byte/);
  } finally { if (old === undefined) delete process.env.ENV_VAULT_KEY; else process.env.ENV_VAULT_KEY = old; }
});
