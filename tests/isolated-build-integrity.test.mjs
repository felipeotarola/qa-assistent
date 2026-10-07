import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  authoredFingerprint, dependencyInventory, inspectIsolatedBuild, isolatedModuleFenceSource,
  prepareDependencyFacade, prepareDependencySnapshot, resolveIsolatedCli,
  verifyBuildReceipt, verifyDependencyFacade, verifyDependencySnapshot,
  verifyGeneratedDatabaseModule, withArtifactLocks,
} from './helpers/isolated-build-integrity.mjs';

const databaseUrl = 'postgres://fixture:fixture@127.0.0.1:54321/syna_test_autonomy_integrity';
const moduleSource = url => `import { drizzle } from 'drizzle-orm/postgres-js';
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
const linkDirectory = (target, link) => symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
const write = async (path, content) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'syna-dependency-integrity-'));
  t.after(async () => {
    const parent = relative(resolve(tmpdir()), await realpath(root));
    assert.ok(parent.startsWith('syna-dependency-integrity-') && !parent.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  const repository = resolve(root, 'repository'), ownedRoot = resolve(repository, '.data/owned');
  await write(resolve(repository, 'pnpm-lock.yaml'), 'lockfileVersion: fixture\n');
  await write(resolve(repository, 'package.json'), '{"type":"module"}');
  for (const name of ['nuxt', 'eve', 'support']) {
    const packageRoot = resolve(repository, 'node_modules/.pnpm', `${name}@fixture/node_modules`, name);
    await write(resolve(packageRoot, 'package.json'), JSON.stringify({ name, type: 'module', main: './index.js' }));
    await write(resolve(packageRoot, 'index.js'), 'export const privateDependency = true;\n');
    await write(resolve(packageRoot, name === 'eve' ? 'bin/eve.js' : 'bin/nuxt.mjs'), 'export {};\n');
    await linkDirectory(packageRoot, resolve(repository, 'node_modules', name));
  }
  await write(resolve(repository, 'node_modules/@nuxthub/db/db.mjs'), 'shared generated state must not be copied');
  await write(resolve(repository, 'node_modules/.cache/nuxt/shared.json'), 'shared cache must not be copied');
  return { root, repository, ownedRoot, serviceRoot: resolve(ownedRoot, 'web') };
}

async function prepared(t) {
  const f = await fixture(t);
  f.snapshot = await prepareDependencySnapshot(f.repository, f.ownedRoot);
  await prepareDependencyFacade(f.snapshot.root, f.serviceRoot, f.ownedRoot);
  await write(resolve(f.serviceRoot, 'package.json'), '{"type":"module"}');
  return f;
}

test('bounded concurrent dependency reads preserve canonical hashes and detect mutation or escaped links', async t => {
  const f = await fixture(t);
  const root = resolve(f.repository, 'node_modules');
  for (let index = 0; index < 40; index++) await write(resolve(root, 'nested', `part-${index % 4}`, `${index}.mjs`), `export const value = ${index};\n`);
  const serial = await dependencyInventory(root, { readConcurrency: 1 });
  for (const readConcurrency of [8, 16]) assert.deepEqual(await dependencyInventory(root, { readConcurrency }), serial);
  await write(resolve(root, 'nested/part-0/0.mjs'), 'changed bytes');
  const changed = await dependencyInventory(root, { readConcurrency: 16 });
  assert.notEqual(changed.sha256, serial.sha256);
  assert.deepEqual(changed.entries.map(entry => entry.name), serial.entries.map(entry => entry.name));
  const outside = resolve(f.root, 'outside'); await mkdir(outside);
  await linkDirectory(outside, resolve(root, 'escaped'));
  await assert.rejects(dependencyInventory(root, { readConcurrency: 16 }), /escapes/);
  await assert.rejects(dependencyInventory(root, { readConcurrency: 32 }), /concurrency/);
});

async function built(t) {
  const f = await prepared(t);
  await write(resolve(f.serviceRoot, 'node_modules/@nuxthub/db/db.mjs'), moduleSource(databaseUrl));
  await write(resolve(f.serviceRoot, 'node_modules/@nuxthub/db/schema.mjs'), 'export const fixtureSchema = true;');
  await write(resolve(f.serviceRoot, '.output/server/node_modules/@nuxthub/db/db.mjs'), moduleSource(databaseUrl));
  await write(resolve(f.serviceRoot, '.output/server/index.mjs'), 'export {};');
  f.source = { files: ['package.json'], sourceSha256: await authoredFingerprint(f.serviceRoot, ['package.json']) };
  f.inspect = () => inspectIsolatedBuild({ dependencySnapshot: f.snapshot, serviceRoot: f.serviceRoot, ownedRoot: f.ownedRoot, service: 'web', databaseUrl, source: f.source });
  return f;
}

test('private copy remaps dependency links and never hardlinks source bytes', async t => {
  const f = await prepared(t);
  const privateEntry = await realpath(resolve(f.snapshot.root, 'node_modules/support/index.js'));
  assert.ok(privateEntry.startsWith(f.snapshot.root + sep));
  const original = await readFile(privateEntry, 'utf8');
  await write(resolve(f.repository, 'node_modules/support/index.js'), 'source was changed after copy');
  assert.equal(await readFile(privateEntry, 'utf8'), original);
  await verifyDependencySnapshot(f.snapshot, f.ownedRoot);
  assert.ok((await resolveIsolatedCli(f.snapshot, f.serviceRoot, 'web')).startsWith(f.snapshot.root + sep));
  assert.ok((await resolveIsolatedCli(f.snapshot, f.serviceRoot, 'eve')).startsWith(f.snapshot.root + sep));
});

test('source aliases that escape or point at excluded generated state fail closed', async t => {
  const f = await fixture(t);
  await write(resolve(f.root, 'external/package.json'), '{"name":"unsafe"}');
  await linkDirectory(resolve(f.root, 'external'), resolve(f.repository, 'node_modules/unsafe'));
  await assert.rejects(prepareDependencySnapshot(f.repository, f.ownedRoot), /escapes/);
  await unlink(resolve(f.repository, 'node_modules/unsafe'));
  await mkdir(resolve(f.repository, 'node_modules/.pnpm/node_modules/@nuxthub'), { recursive: true });
  await linkDirectory(resolve(f.repository, 'node_modules/@nuxthub/db'), resolve(f.repository, 'node_modules/.pnpm/node_modules/@nuxthub/db'));
  await assert.rejects(prepareDependencySnapshot(f.repository, f.ownedRoot), /generated\/cache/);
});

test('legacy whole-tree junction is removed without modifying source; web and Eve generated files stay private', async t => {
  const f = await fixture(t);
  f.snapshot = await prepareDependencySnapshot(f.repository, f.ownedRoot);
  await mkdir(f.serviceRoot, { recursive: true });
  await linkDirectory(resolve(f.repository, 'node_modules'), resolve(f.serviceRoot, 'node_modules'));
  await prepareDependencyFacade(f.snapshot.root, f.serviceRoot, f.ownedRoot, f.repository);
  const eve = resolve(f.ownedRoot, 'eve');
  await prepareDependencyFacade(f.snapshot.root, eve, f.ownedRoot);
  await write(resolve(f.serviceRoot, 'node_modules/@nuxthub/db/db.mjs'), 'web-only');
  await write(resolve(eve, 'node_modules/@nuxthub/db/db.mjs'), 'eve-only');
  // Simulate an unrelated root Nuxt prepare at the same time: only its own
  // generated module changes; neither private service target points there.
  await write(resolve(f.repository, 'node_modules/@nuxthub/db/db.mjs'), 'concurrent root prepare');
  assert.equal(await readFile(resolve(f.serviceRoot, 'node_modules/@nuxthub/db/db.mjs'), 'utf8'), 'web-only');
  assert.equal(await readFile(resolve(eve, 'node_modules/@nuxthub/db/db.mjs'), 'utf8'), 'eve-only');
  await verifyDependencySnapshot(f.snapshot, f.ownedRoot);
});

test('dependency mutations, generated links and unexpected scoped aliases are rejected', async t => {
  const f = await prepared(t);
  await write(resolve(f.snapshot.root, 'node_modules/support/index.js'), 'changed private dependency');
  await assert.rejects(verifyDependencySnapshot(f.snapshot, f.ownedRoot), /changed/);
  await linkDirectory(resolve(f.repository, 'node_modules/support'), resolve(f.serviceRoot, 'node_modules/@nuxthub/extra'));
  await assert.rejects(verifyDependencyFacade(f.snapshot.root, f.serviceRoot, f.ownedRoot), /scoped/);
});

test('actual postgres call must use exact URL binding; misleading comments/config and target overrides fail', () => {
  assert.equal(verifyGeneratedDatabaseModule(moduleSource(databaseUrl), databaseUrl), sha(moduleSource(databaseUrl)));
  const other = 'postgres://fixture:fixture@127.0.0.1:54321/syna_test_autonomy_other';
  for (const source of [
    `// expected ${databaseUrl}\n${moduleSource(other)}`,
    moduleSource(databaseUrl).replace('max: 1', 'host: "db.remote.invalid"'),
    moduleSource(databaseUrl).replace('max: 1', 'db: "other"'),
    moduleSource(databaseUrl).replace('max: 1', 'pass: "other"'),
    moduleSource(databaseUrl).replace('TimeZone: \'UTC\'', 'TimeZone: \'UTC\', database: \'other\''),
    moduleSource(databaseUrl).replace('TimeZone: \'UTC\'', 'user: \'other\''),
    moduleSource(databaseUrl).replace('max: 1', 'max: computeOptions()'),
    moduleSource(databaseUrl).replace('max: 1', '...overrides'),
    moduleSource(databaseUrl).replace('const url =', 'let url ='),
    moduleSource(databaseUrl).replace('const client = postgres(url,', 'function connect(url) { const client = postgres(url,').replace('export { client };', '}'),
    moduleSource(databaseUrl).replace('const client = postgres(url,', 'function connect(postgres) { const client = postgres(url,').replace('export { client };', '}'),
    moduleSource(databaseUrl).replace(JSON.stringify(databaseUrl), 'process.env.DATABASE_URL'),
    `${moduleSource(databaseUrl)}\nconst alias = postgres; const other = alias({host:'db.remote.invalid',database:'shared'}); export { other };`,
    `${moduleSource(databaseUrl)}\nconst other = await import('postgres');`,
    moduleSource(databaseUrl).replace('export { db, schema };', 'export const db2 = {}'),
    moduleSource(databaseUrl).replace('return getDb()[prop]', 'return anotherClient[prop]'),
  ]) assert.throws(() => verifyGeneratedDatabaseModule(source, databaseUrl));
});

test('compiled module is checked even when source generated module and runtime config are correct', async t => {
  const f = await built(t);
  await f.inspect();
  await write(resolve(f.serviceRoot, '.output/server/node_modules/@nuxthub/db/db.mjs'), moduleSource('postgres://fixture:fixture@127.0.0.1:54321/syna_test_autonomy_wrong'));
  await assert.rejects(f.inspect(), /fixture/);
});

test('receipts cover schema, output, authored files and generated dependencies; old receipts cannot start', async t => {
  const f = await built(t), receipt = await f.inspect();
  verifyBuildReceipt(receipt, await f.inspect());
  assert.throws(() => verifyBuildReceipt(undefined, receipt), /changed/);
  await write(resolve(f.serviceRoot, 'node_modules/@nuxthub/db/schema.mjs'), 'export const differentSchema = true;');
  assert.throws(() => verifyBuildReceipt(receipt, { ...receipt, output: { sha256: 'spoofed' } }), /changed/);
  assert.throws(() => verifyBuildReceipt(receipt, { ...receipt, generated: {} }), /changed/);
  assert.notDeepEqual(await f.inspect(), receipt);
  await write(resolve(f.serviceRoot, 'package.json'), '{"type":"module","changed":true}');
  await assert.rejects(f.inspect(), /Authored/);
});

test('compiled output rejects external links and inlined non-fixture database targets', async t => {
  const f = await built(t);
  await linkDirectory(resolve(f.repository, 'node_modules/support'), resolve(f.serviceRoot, '.output/server/shared'));
  await assert.rejects(f.inspect(), /external dependency/);
  await unlink(resolve(f.serviceRoot, '.output/server/shared'));
  await write(resolve(f.serviceRoot, '.output/server/config.json'), JSON.stringify({ url: 'postgres://fixture:fixture@db.remote.invalid:5432/shared' }));
  await assert.rejects(f.inspect(), /loopback/);
});

test('artifact locks reject competing prepare/build/start; locks are released after errors', async t => {
  const f = await fixture(t);
  await withArtifactLocks(f.ownedRoot, ['web', 'eve'], async () => {
    await assert.rejects(withArtifactLocks(f.ownedRoot, ['dependencies', 'web'], () => assert.fail('must not execute')), /concurrently/);
    await assert.rejects(withArtifactLocks(f.ownedRoot, ['eve'], () => assert.fail('must not execute')), /concurrently/);
  });
  await assert.rejects(withArtifactLocks(f.ownedRoot, ['web'], () => { throw new Error('test barrier'); }), /test barrier/);
  assert.equal(await withArtifactLocks(f.ownedRoot, ['web'], () => 'released'), 'released');
});

test('runtime loader permits private dependencies and builtins, denies lazy ancestor fallback', async t => {
  const f = await prepared(t);
  const fence = resolve(f.serviceRoot, 'tests/helpers/isolation-module-fence.mjs');
  await write(fence, isolatedModuleFenceSource(f.snapshot.root));
  await write(resolve(f.repository, 'node_modules/unlisted/package.json'), '{"name":"unlisted","type":"module","main":"index.js"}');
  await write(resolve(f.repository, 'node_modules/unlisted/index.js'), 'throw new Error("must never execute ancestor module");');
  const allowed = resolve(f.serviceRoot, 'allowed.mjs'), denied = resolve(f.serviceRoot, 'denied.mjs');
  await write(allowed, 'import "node:fs"; import { privateDependency } from "support"; console.log(privateDependency);');
  await write(denied, 'await import("unlisted");');
  const options = { cwd: f.serviceRoot, env: { SystemRoot: process.env.SystemRoot, NODE_OPTIONS: '' }, windowsHide: true };
  assert.equal((await promisify(execFile)(process.execPath, ['--import', pathToFileURL(fence).href, allowed], options)).stdout.trim(), 'true');
  await assert.rejects(promisify(execFile)(process.execPath, ['--import', pathToFileURL(fence).href, denied], options), error => error.stderr.includes('outside its private snapshot') && !error.stderr.includes('must never execute ancestor module'));
});
