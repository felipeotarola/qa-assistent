import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { isolatedAppEnvironment, validateEvidenceGapConfiguration } from './helpers/start-isolated-app.mjs';
import { EVIDENCE_GAP_LAUNCHER, gapConfigHash as hash } from './helpers/evidence-gap-config.mjs';

const fixture = { databaseUrl: 'postgres://fake:fake@127.0.0.1:5432/syna_test_autonomy_config', runtimeScope: 'autonomy-test:config', internalApiSecret: 'x'.repeat(40), browser: { url: 'http://127.0.0.1:58092', key: 'synthetic' } };
const hashes = { serverSha256: hash('server'), launcherSha256: hash(EVIDENCE_GAP_LAUNCHER), resolverSha256: hash('resolver') };
const manifest = { schemaVersion: 1, kind: 'evidence-gap', ...hashes, runtimeScope: fixture.runtimeScope,
  origin: 'http://qa-evidence.test', address: '192.0.2.13', port: 80,
  container: `qa-evidence-gap-${hashes.serverSha256.slice(0, 12)}`, directory: `/opt/syna-autonomy/fixtures/evidence-gap-${hashes.serverSha256.slice(0, 12)}`,
  oracleNotServed: true, transport: 'isolated-docker-public-origin', browserImage: `sha256:${hash('browser')}`, containerImage: `sha256:${hash('image')}`, containerId: hash('id') };

test('GAP resolver is explicit, web-only, and unavailable in health smoke or another browser environment', () => {
  assert.equal(isolatedAppEnvironment(fixture, 'web').SYNA_EVIDENCE_GAP, undefined);
  const env = isolatedAppEnvironment(fixture, 'web', { evidenceGapFixture: true });
  assert.equal(env.SYNA_EVIDENCE_GAP, 'fixture-v1'); assert.match(env.NODE_OPTIONS, /evidence-gap-resolver.mjs/);
  assert.equal(isolatedAppEnvironment(fixture, 'eve', { evidenceGapFixture: true }).SYNA_EVIDENCE_GAP, undefined);
  assert.throws(() => isolatedAppEnvironment(fixture, 'web', { evidenceGapFixture: true, healthSmoke: { id: 'b10ca82c-119d-4de8-af36-ad477bac52d3', templateOrigin: 'http://127.0.0.1:58099' } }), /health smoke/);
  assert.throws(() => isolatedAppEnvironment({ ...fixture, browser: { url: 'http://127.0.0.1:58080' } }, 'web', { evidenceGapFixture: true }), /owned isolated browser/);
});

test('GAP start configuration binds exact deployment, immutable launcher and frozen resolver bytes', () => {
  const input = { fixture, hashes, manifest, snapshotResolverSha256: hashes.resolverSha256 };
  assert.deepEqual(validateEvidenceGapConfiguration(input), { ...hashes, manifestSha256: hash(JSON.stringify(manifest)), containerId: manifest.containerId });
  const patches = [
    { snapshotResolverSha256: hash('stale') },
    ...[{ runtimeScope: 'prod' }, { origin: 'http://qa-other.test' }, { address: '127.0.0.1' }, { port: 81 }, { transport: 'direct' },
      { oracleNotServed: false }, { container: 'other' }, { directory: '/other' }, { browserImage: 'latest' }, { containerImage: 'latest' }, { containerId: 'unknown' },
      { serverSha256: hash('changed') }, { launcherSha256: hash('changed') }, { resolverSha256: hash('changed') }].map(patch => ({ manifest: { ...manifest, ...patch } })),
    { hashes: { ...hashes, launcherSha256: hash('other launcher') }, manifest: { ...manifest, launcherSha256: hash('other launcher') } },
    { fixture: { ...fixture, databaseUrl: 'postgres://fake:fake@remote.invalid/production' } },
    { fixture: { ...fixture, browser: { url: 'http://127.0.0.1:58080' } } },
  ];
  for (const patch of patches) assert.throws(() => validateEvidenceGapConfiguration({ ...input, ...patch }));
});

test('GAP DNS preload resolves only the exact fixture name, with callback and promise semantics', () => {
  const resolver = new URL('./helpers/evidence-gap-resolver.mjs', import.meta.url).href;
  const script = `import assert from 'node:assert/strict'; import dns from 'node:dns'; import promises from 'node:dns/promises';
    dns.lookup=(_h,options,cb)=>{ if(typeof options==='function')cb=options; cb(null,'original',4); };
    promises.lookup=async()=>({address:'original',family:4});
    await import(${JSON.stringify(resolver)});
    for(const name of ['qa-evidence.test','QA-EVIDENCE.TEST.']) assert.deepEqual(await promises.lookup(name),{address:'192.0.2.13',family:4});
    assert.deepEqual(await promises.lookup('qa-evidence.test',{all:true}),[{address:'192.0.2.13',family:4}]);
    await assert.rejects(promises.lookup('qa-evidence.test',6),{code:'ENOTFOUND'});
    for(const name of ['qa-evidence.test.evil','child.qa-evidence.test','qa-benchmark.test','localhost']) assert.equal((await promises.lookup(name)).address,'original');
    assert.equal(await new Promise((resolve,reject)=>dns.lookup('qa-evidence.test',(e,address,family)=>e?reject(e):resolve(address+':'+family))),'192.0.2.13:4');
    assert.deepEqual(await new Promise((resolve,reject)=>dns.lookup('qa-evidence.test',{all:true},(e,addresses)=>e?reject(e):resolve(addresses))),[{address:'192.0.2.13',family:4}]);
    await assert.rejects(new Promise((resolve,reject)=>dns.lookup('qa-evidence.test',6,e=>e?reject(e):resolve())),{code:'ENOTFOUND'});
    console.log('exact-isolated-resolver');`;
  const env = { SYSTEMROOT: process.env.SYSTEMROOT, PATH: process.env.PATH, SYNA_EVIDENCE_GAP: 'fixture-v1', PAT_RUNTIME_SCOPE: 'autonomy-test:pure', BROWSER_SERVICE_URL: 'http://127.0.0.1:58092', DATABASE_URL: 'postgres://fake:fake@127.0.0.1:50000/syna_test_autonomy_pure' };
  const run = patch => spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, ...patch }, encoding: 'utf8', windowsHide: true });
  const result = run({}); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /exact-isolated-resolver/);
  for (const patch of [{ VERCEL: '1' }, { PAT_RUNTIME_SCOPE: 'prod' }, { SYNA_EVIDENCE_GAP: '' }, { BROWSER_SERVICE_URL: 'http://127.0.0.1:58080' }, { DATABASE_URL: 'postgres://fake:fake@remote.invalid/production' }]) assert.notEqual(run(patch).status, 0);
});
