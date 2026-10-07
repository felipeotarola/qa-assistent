import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolatedAppEnvironment } from './helpers/start-isolated-app.mjs';
import { reportFaultDatabaseUrl, createReportFaultRuntime, verifyReportFaultRuntime } from './helpers/report-fault-startup.mjs';
import { validateReportFaultRuntime, loadReportFaultRuntime, reportFaultRuntimeFiles, runtimeDigest } from './helpers/report-fault-runtime.mjs';
import { loadReportFaultConfig } from './helpers/report-fault-control.mjs';
import { reportFaultAcceptance } from './helpers/report-fault-acceptance.mjs';
import { reportFaultManifest } from './helpers/report-fault-compile.mjs';
import { REPORT_FAULT_PREPARATION } from './helpers/report-fault-contract.mjs';
import { verifyGeneratedDatabaseModule } from './helpers/isolated-build-integrity.mjs';

const sha = 'a'.repeat(64), databaseUrl = 'postgres://local:local@127.0.0.1:54321/syna_test_autonomy_fault';
const fixture = { kind: 'syna-autonomy-isolation', provider: 'native-postgres', version: 1, databaseUrl, runtimeScope: 'autonomy-test:fault', internalApiSecret: 'x'.repeat(48) };
const faults = taskId => ({ config: { upstreamDatabaseUrl: databaseUrl, ...(taskId === 'REP-05' ? { pgPort: 54322 } : {}) }, manifest: { taskId } });
async function temporary(t) {
  const root = resolve('.data/autonomy-isolation', `report-fault-unit-${randomUUID()}`); await mkdir(root, { recursive: true });
  t.after(async () => { const child = relative(resolve('.data/autonomy-isolation'), await realpath(root)); assert.ok(child.startsWith('report-fault-unit-') && !child.includes(sep)); await rm(root, { recursive: true }); });
  return root;
}

test('normal environment has direct compiled target and no ambient fault hook; opt-in is exact and web-only', () => {
  const original = process.env.SYNA_REPORT_FAULT_PRELOAD; process.env.SYNA_REPORT_FAULT_PRELOAD = '1';
  try {
    const normal = isolatedAppEnvironment(fixture, 'web'); assert.equal(normal.DATABASE_URL, databaseUrl); assert.equal(normal.SYNA_REPORT_FAULT_PRELOAD, undefined);
    assert.ok(!normal.NODE_OPTIONS.includes('report-fault-preload'));
    const pg = faults('REP-05'), redirected = isolatedAppEnvironment(fixture, 'web', {}, pg);
    assert.equal(new URL(redirected.DATABASE_URL).port, '54322'); assert.equal(new URL(redirected.DATABASE_URL).pathname, new URL(databaseUrl).pathname);
    const barrier = { ...faults('REP-06'), runtimeConfiguration: { path: 'owned-private-runtime-config' } };
    const web = isolatedAppEnvironment(fixture, 'web', { siteFixture: true }, barrier), eve = isolatedAppEnvironment(fixture, 'eve', {}, barrier);
    assert.equal(web.DATABASE_URL, databaseUrl); assert.equal(web.SYNA_REPORT_FAULT_PRELOAD, '1'); assert.match(web.NODE_OPTIONS, /resolver.mjs/); assert.match(web.NODE_OPTIONS, /isolation-module-fence.mjs/); assert.match(web.NODE_OPTIONS, /report-fault-preload.mjs/);
    assert.equal(eve.SYNA_REPORT_FAULT_PRELOAD, undefined); assert.ok(!eve.NODE_OPTIONS.includes('report-fault-preload'));
    assert.throws(() => isolatedAppEnvironment(fixture, 'web', { healthSmoke: {} }, pg), /Health smoke/);
  } finally { if (original === undefined) delete process.env.SYNA_REPORT_FAULT_PRELOAD; else process.env.SYNA_REPORT_FAULT_PRELOAD = original; }
});
test('fault DSN can change only the explicit loopback port and cannot silently replace DB identity or credentials', () => {
  assert.equal(reportFaultDatabaseUrl(databaseUrl, faults('REP-06')), databaseUrl);
  for (const changed of [databaseUrl.replace('54321', '54320'), databaseUrl.replace('local:local', 'local:other'), databaseUrl.replace('_fault', '_other'), databaseUrl.replace('127.0.0.1', 'external.example')]) {
    const fault = faults('REP-05'); fault.config.upstreamDatabaseUrl = changed;
    assert.throws(() => reportFaultDatabaseUrl(databaseUrl, fault));
  }
  for (const port of [54321, 80, NaN, 65536, '54322']) { const fault = faults('REP-05'); fault.config.pgPort = port; assert.throws(() => reportFaultDatabaseUrl(databaseUrl, fault)); }
});
test('compiled direct DB code cannot be accepted by runtime-only proxy environment and vice versa', () => {
  const module = url => `import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.mjs';
let _db;
function getDb() {
  if (!_db) {
    try {
      const url = ${JSON.stringify(url)};
      if (!url) throw new Error('DATABASE_URL, POSTGRES_URL, or POSTGRESQL_URL required');
      const client = postgres(url, { max: 1, connection: { TimeZone: 'UTC' }, onnotice: () => {} });
      _db = drizzle({ client, schema });
    } catch (e) { throw new Error('[nuxt-hub] ' + e.message); }
  }
  return _db;
}
const db = new Proxy({}, { get(_, prop) { return getDb()[prop]; } });
export { db, schema };`;
  const proxy = reportFaultDatabaseUrl(databaseUrl, faults('REP-05'));
  assert.ok(verifyGeneratedDatabaseModule(module(databaseUrl), databaseUrl)); assert.ok(verifyGeneratedDatabaseModule(module(proxy), proxy));
  assert.throws(() => verifyGeneratedDatabaseModule(module(databaseUrl), proxy)); assert.throws(() => verifyGeneratedDatabaseModule(module(proxy), databaseUrl));
});
test('frozen preload validates hash/runtime/deadline, emits actual child PID receipt, and stays inside its private authored tree', async t => {
  const root = await temporary(t), web = resolve(root, 'web'); await mkdir(resolve(web, 'tests/helpers'), { recursive: true });
  const helperHashes = {};
  for (const file of reportFaultRuntimeFiles) { const bytes = await readFile(file); helperHashes[file] = runtimeDigest(bytes); await writeFile(resolve(web, file), bytes); }
  let receipt;
  const server = createServer(async (req, res) => { assert.equal(req.url, '/preload-ready'); assert.equal(req.headers.authorization, `Bearer ${sha}`); const chunks = []; for await (const chunk of req) chunks.push(chunk); receipt = JSON.parse(Buffer.concat(chunks)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ready: true, nonce: receipt.nonce })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  const fault = { manifest: { taskId: 'REP-06', runtime: fixture.runtimeScope, sourceHash: sha }, config: { controlPort: server.address().port, controlKey: sha, manifestSha256: sha, deadlineAt: new Date(Date.now() + 60000).toISOString() }, helperHashes, configFile: 'private-original-config', binding: { kind: 'provider-response-barrier' } };
  const configuration = await createReportFaultRuntime(fault, root), loaded = await loadReportFaultRuntime(configuration.path, { runtime: fixture.runtimeScope, cwd: web });
  for (const changed of [{ ...loaded, runtime: 'autonomy-test:other' }, { ...loaded, controlOrigin: 'https://external.example' }, { ...loaded, deadlineAt: 'invalid' }, { ...loaded, serviceRoot: resolve(root, 'eve') }]) assert.throws(() => validateReportFaultRuntime(changed, { runtime: fixture.runtimeScope, cwd: web }));
  const main = resolve(web, 'probe.mjs'); await writeFile(main, 'console.log(JSON.stringify({pid:process.pid, ready:true}));');
  const { stdout } = await promisify(execFile)(process.execPath, [main], { cwd: web, windowsHide: true, timeout: 10000,
    env: { PAT_RUNTIME_SCOPE: fixture.runtimeScope, SYNA_REPORT_FAULT_PRELOAD: '1', SYNA_REPORT_FAULT_RUNTIME: configuration.path, NODE_OPTIONS: `--import=${pathToFileURL(resolve(web, 'tests/helpers/report-fault-preload.mjs')).href}` } });
  assert.equal(receipt.pid, JSON.parse(stdout).pid); assert.equal(receipt.nonce, configuration.nonce); assert.deepEqual(receipt.helperHashes, helperHashes); assert.equal(receipt.serviceRoot, web);
  const runtime = { reportFault: fault.binding, reportFaultConfigFile: fault.configFile, reportFaultStartup: { ...configuration, receipt }, web: { pid: receipt.pid } };
  await verifyReportFaultRuntime(fault, runtime, root); runtime.web.pid++; await assert.rejects(verifyReportFaultRuntime(fault, runtime, root)); runtime.web.pid--;
  await writeFile(resolve(web, 'tests/helpers/report-fault-provider.mjs'), '// changed'); await assert.rejects(loadReportFaultRuntime(configuration.path, { runtime: fixture.runtimeScope, cwd: web }), /Frozen preload/);
});
test('audit reads expired private fault configuration without activation; standalone external auth is refused before credentials', async t => {
  const root = await temporary(t), fixtureFile = resolve(root, 'fixture.json'), configFile = resolve(root, 'config.json'), manifestFile = resolve(root, 'manifest.json');
  const prepared = { protocol: REPORT_FAULT_PREPARATION, taskId: 'REP-07', reviewerVersion: '7', runtime: fixture.runtimeScope, realProviderCalls: 0, realBrowserActions: 0, completedAt: new Date().toISOString(),
    trials: [1, 2, 3].map(i => ({ workspaceId: `workspace${i}`, seedHash: sha, selection: [{ type: 'test', id: `run${i}`, label: 'Saved source' }], wrongRun: { itemId: `item${i}`, registeredRunId: `run${i}`, claimedRunId: `other${i}`, contentHash: sha } })) };
  const codeHashes = {}; for (const name of (await readdir('tests/helpers')).filter(name => /^report-fault-.*\.mjs$/.test(name))) codeHashes[`tests/helpers/${name}`] = runtimeDigest(await readFile(`tests/helpers/${name}`));
  const manifest = reportFaultManifest({ preparation: prepared, preparationPath: resolve(root, 'prep.json'), preparationSha256: sha, accountFile: resolve(root, 'account.json'), sourceHash: sha, configFile, receiptFile: resolve('.data/autonomy-isolation', `unused-report-fault-${randomUUID()}.jsonl`), codeHashes });
  const text = JSON.stringify(manifest), currentFixture = { ...fixture, app: { sourceSha256: sha }, auth: { url: 'http://127.0.0.1:54324' } };
  await writeFile(fixtureFile, JSON.stringify(currentFixture)); await writeFile(manifestFile, text);
  const config = { kind: 'syna-report-fault-driver', version: 1, fixtureFile, manifestFile, manifestSha256: runtimeDigest(text), controlKey: sha, appOrigin: 'http://127.0.0.1:58000', controlPort: 58422, upstreamDatabaseUrl: databaseUrl, deadlineAt: new Date(Date.now() - 1000).toISOString() };
  await writeFile(configFile, JSON.stringify(config)); await assert.rejects(loadReportFaultConfig(configFile), /finite and current/);
  const adapter = await reportFaultAcceptance(manifest, '--audit'); const identity = await adapter.freeze({}); assert.equal(identity.kind, 'synthetic-preparation-only');
  await assert.rejects(adapter.arm(manifest.trials[0], 'thread', sha));
  currentFixture.auth.url = 'https://external.example'; await writeFile(fixtureFile, JSON.stringify(currentFixture));
  await assert.rejects(loadReportFaultConfig(configFile, { allowExpired: true }), /loopback/);
});
