import assert from 'node:assert/strict';
import test from 'node:test';
import { isolatedAppEnvironment, validateExtraVariantsConfiguration } from './helpers/start-isolated-app.mjs';
import { hash } from './helpers/browser-variants-protocol.mjs';
const fixture = { databaseUrl: 'postgres://fake:fake@127.0.0.1:5432/syna_test_autonomy_config', runtimeScope: 'autonomy-test:config', internalApiSecret: 'x'.repeat(40) };
const hashes = { serverSha256: hash('server'), oracleSha256: hash('oracle'), resolverSha256: hash('resolver') };
const manifest = { schemaVersion: 1, kind: 'browser-variants-extra', ...hashes, runtimeScope: fixture.runtimeScope, origins: ['http://qa-regression.test', 'http://qa-auth.test'],
  address: '192.0.2.12', port: 80, container: `qa-browser-extra-${hashes.serverSha256.slice(0, 12)}`, directory: `/opt/syna-autonomy/fixtures/browser-extra-${hashes.serverSha256.slice(0, 12)}`,
  oracleNotServed: true, transport: 'isolated-docker-public-origin', browserImage: `sha256:${hash('browser')}`, containerImage: `sha256:${hash('image')}`, containerId: hash('id') };
test('extra resolver requires explicit web-only option and cannot enter credential-free smoke', () => {
  assert.equal(isolatedAppEnvironment(fixture, 'web').SYNA_BROWSER_EXTRA_VARIANTS, undefined);
  const env = isolatedAppEnvironment(fixture, 'web', { extraVariantsFixture: true }); assert.equal(env.SYNA_BROWSER_EXTRA_VARIANTS, 'fixture-v1'); assert.match(env.NODE_OPTIONS, /browser-variants-extra-resolver.mjs/);
  assert.equal(isolatedAppEnvironment(fixture, 'eve', { extraVariantsFixture: true }).SYNA_BROWSER_EXTRA_VARIANTS, undefined);
  assert.throws(() => isolatedAppEnvironment(fixture, 'web', { extraVariantsFixture: true, healthSmoke: { id: 'b10ca82c-119d-4de8-af36-ad477bac52d3', templateOrigin: 'http://127.0.0.1:58099' } }), /health smoke/);
});
test('extra fixture manifest binds frozen resolver, oracle, network and exact isolation runtime before start', () => {
  const input = { fixture, hashes, manifest, snapshotResolverSha256: hashes.resolverSha256 };
  assert.equal(validateExtraVariantsConfiguration(input).containerId, manifest.containerId);
  for (const patch of [{ snapshotResolverSha256: hash('stale') }, { manifest: { ...manifest, runtimeScope: 'prod' } }, { manifest: { ...manifest, address: '127.0.0.1' } }, { hashes: { ...hashes, serverSha256: hash('changed') } }]) assert.throws(() => validateExtraVariantsConfiguration({ ...input, ...patch }));
});
