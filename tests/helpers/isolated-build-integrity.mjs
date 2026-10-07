import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { assertIsolatedDatabaseUrl } from './autonomy-isolation.mjs';

const generatedPackages = ['@nuxthub/db', '@nuxthub/kv', '@nuxthub/blob'];
const privateDirectories = ['.cache', '.nitro', '.hub', '.vite', ...generatedPackages];
const inside = (base, path) => { const child = relative(base, path); return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child); };
const digest = value => createHash('sha256').update(value).digest('hex');
const maybeStat = path => lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
const excludedDependencyEntries = new Set(['.bin', '.cache', '.nitro', '.hub', '.vite', '.modules.yaml', '.package-map.json', '.pnpm-workspace-state-v1.json', 'node', ...generatedPackages]);

async function ownedDirectory(path, ownedRoot, create = false) {
  const root = resolve(ownedRoot), target = resolve(path);
  if (!inside(root, target)) throw new Error('Isolated dependency path is outside its owned root');
  if (create) await mkdir(target, { recursive: true });
  const entry = await lstat(target);
  if (!entry.isDirectory() || entry.isSymbolicLink() || relative(target, await realpath(target)) !== '') throw new Error('Isolated generated directories must be physical owned directories');
  return target;
}

/** Inventory physical bytes without following junctions. The only omitted
 * external executable alias is top-level `node`: we launch process.execPath
 * explicitly and record that separately. Every remaining link must stay inside
 * this dependency tree, and is reconstructed against the private copy. */
export async function dependencyInventory(root, { readConcurrency = 16 } = {}) {
  if (!Number.isInteger(readConcurrency) || readConcurrency < 1 || readConcurrency > 16) throw new Error('Dependency read concurrency must be between 1 and 16');
  let active = 0;
  const waiting = [];
  async function read(operation) {
    if (active >= readConcurrency) await new Promise(done => waiting.push(done));
    else active++;
    try { return await operation(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  }
  async function visit(directory) {
    const children = (await read(() => readdir(directory, { withFileTypes: true }))).sort((a, b) => a.name.localeCompare(b.name));
    // Promise.all preserves canonical depth-first order despite out-of-order
    // reads. Only independent read-only I/O runs concurrently; writes and the
    // before/after mutation checks remain sequential.
    return (await Promise.all(children.map(async entry => {
      const path = resolve(directory, entry.name), name = relative(root, path).replaceAll('\\', '/');
      if (excludedDependencyEntries.has(name)) return [];
      if (entry.isSymbolicLink()) {
        const target = await read(() => realpath(path));
        if (!inside(root, target)) throw new Error('Installed dependency link escapes its source tree');
        const destination = relative(root, target).replaceAll('\\', '/');
        if (excludedDependencyEntries.has(destination) || [...excludedDependencyEntries].some(prefix => destination.startsWith(prefix + '/'))) throw new Error('Installed package points to generated/cache state');
        return [{ name, kind: 'link', target: destination, directory: (await read(() => stat(path))).isDirectory() }];
      } else if (entry.isDirectory()) return [{ name, kind: 'directory' }, ...await visit(path)];
      else if (entry.isFile()) return [{ name, kind: 'file', sha256: digest(await read(() => readFile(path))) }];
      else throw new Error('Unexpected installed dependency entry');
    }))).flat();
  }
  const entries = await visit(root);
  return { entries, sha256: digest(JSON.stringify(entries)) };
}

export async function runtimeBinaryIdentity() {
  return { executable: await realpath(process.execPath), nodeVersion: process.version, sha256: digest(await readFile(process.execPath)) };
}

/** A copied preload guards lazy imports too. Without it a missing bare import
 * could climb from .data/... back into the repository's node_modules. This is
 * test-process policy, not a production loader or network policy. */
export function isolatedModuleFenceSource(dependencyRoot) {
  return `import { registerHooks } from 'node:module';
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const serviceRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const dependencyRoot = realpathSync(${JSON.stringify(resolve(dependencyRoot))});
const inside = (root, path) => { const value = relative(root, path); return value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value); };
registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  if (result.url.startsWith('node:')) return result;
  if (!result.url.startsWith('file:')) throw new Error('Isolated runtime refused a non-file module');
  const path = realpathSync(fileURLToPath(result.url));
  if (!inside(serviceRoot, path) && !inside(dependencyRoot, path)) {
    const error = new Error('Isolated runtime refused a module outside its private snapshot: ' + path);
    mkdirSync(resolve(serviceRoot, '.data'), { recursive: true });
    appendFileSync(resolve(serviceRoot, '.data/module-resolution-denied.jsonl'), JSON.stringify({ target: path, parent: context.parentURL, stack: error.stack }) + '\\n');
    throw error;
  }
  return result;
} });
`;
}

export async function prepareDependencySnapshot(repository, ownedRoot) {
  await ownedDirectory(ownedRoot, ownedRoot, true);
  const sourceRoot = resolve(repository, 'node_modules');
  if (relative(sourceRoot, await realpath(sourceRoot)) !== '') throw new Error('Dependency source root must be physical');
  const lockfileSha256 = digest(await readFile(resolve(repository, 'pnpm-lock.yaml')));
  const before = await dependencyInventory(sourceRoot);
  const pointer = resolve(ownedRoot, 'dependency-snapshot.json');
  const previous = await readFile(pointer, 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (previous?.sourceSha256 === before.sha256 && previous.lockfileSha256 === lockfileSha256) {
    await verifyDependencySnapshot(previous, ownedRoot);
    return previous;
  }
  const root = resolve(ownedRoot, `dependencies-${randomUUID()}`), target = resolve(root, 'node_modules');
  await ownedDirectory(target, ownedRoot, true);
  for (const entry of before.entries) {
    const path = resolve(target, entry.name);
    if (!inside(target, path)) throw new Error('Invalid dependency inventory path');
    if (entry.kind === 'directory') { await mkdir(path, { recursive: true }); continue; }
    if (entry.kind === 'link') continue;
    await mkdir(dirname(path), { recursive: true });
    const bytes = await readFile(resolve(sourceRoot, entry.name));
    if (digest(bytes) !== entry.sha256) throw new Error('Installed dependency changed during copy');
    await writeFile(path, bytes, { flag: 'wx' }); // Physical bytes, never a hardlink.
  }
  for (const entry of before.entries.filter(entry => entry.kind === 'link')) {
    const path = resolve(target, entry.name), destination = resolve(target, entry.target);
    if (!inside(target, destination)) throw new Error('Dependency snapshot link escapes');
    await mkdir(dirname(path), { recursive: true });
    await symlink(destination, path, entry.directory ? process.platform === 'win32' ? 'junction' : 'dir' : 'file');
  }
  const after = await dependencyInventory(sourceRoot);
  if (after.sha256 !== before.sha256 || digest(await readFile(resolve(repository, 'pnpm-lock.yaml'))) !== lockfileSha256) throw new Error('Installed dependencies or lockfile changed during isolation');
  const snapshot = { version: 1, root, sourceSha256: before.sha256, lockfileSha256, createdAt: new Date().toISOString(), runtime: await runtimeBinaryIdentity(), excluded: [...excludedDependencyEntries] };
  await verifyDependencySnapshot(snapshot, ownedRoot);
  await writeFile(resolve(root, 'manifest.json'), JSON.stringify({ ...snapshot, entries: before.entries }, null, 2));
  await writeFile(pointer, JSON.stringify(snapshot, null, 2));
  return snapshot;
}

export async function verifyDependencySnapshot(snapshot, ownedRoot) {
  if (snapshot?.version !== 1 || !/^[a-f0-9]{64}$/.test(snapshot.sourceSha256) || !/^[a-f0-9]{64}$/.test(snapshot.lockfileSha256)) throw new Error('Invalid dependency snapshot receipt');
  await ownedDirectory(snapshot.root, ownedRoot);
  const root = await ownedDirectory(resolve(snapshot.root, 'node_modules'), ownedRoot);
  // A fresh snapshot must contain no ignored/shared generated entries at all.
  for (const name of excludedDependencyEntries) if (await maybeStat(resolve(root, name))) throw new Error('Private dependency snapshot contains mutable generated state');
  if ((await dependencyInventory(root)).sha256 !== snapshot.sourceSha256) throw new Error('Private dependency snapshot changed');
  if (JSON.stringify(await runtimeBinaryIdentity()) !== JSON.stringify(snapshot.runtime)) throw new Error('Managed Node runtime changed since dependency snapshot');
  return snapshot.sourceSha256;
}

export class IsolatedArtifactsBusyError extends Error {
  constructor(waitedMs = 0) {
    super('Isolated artifacts are busy; do not run mutating operations concurrently');
    this.name = 'IsolatedArtifactsBusyError'; this.code = 'ERR_ISOLATED_ARTIFACTS_BUSY';
    this.safe = true; this.retryable = true; this.waitedMs = Math.max(0, Math.round(waitedMs));
  }
}

export async function withArtifactLocks(ownedRoot, services, action) {
  await ownedDirectory(ownedRoot, ownedRoot, true);
  const locks = [];
  try {
    for (const service of [...new Set(services)].sort()) {
      if (!['web', 'eve', 'dependencies'].includes(service)) throw new Error('Unknown artifact lock');
      const path = resolve(ownedRoot, `artifact-${service}.lock`), handle = await open(path, 'wx').catch(error => { if (error.code === 'EEXIST') throw new IsolatedArtifactsBusyError(); throw error; });
      locks.push({ path, handle }); await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    }
    return await action();
  } finally { for (const lock of locks.reverse()) { await lock.handle.close(); await unlink(lock.path); } }
}

/** Future read-only verifiers may wait for a competing verifier/builder. The
 * monotonic deadline never moves, partial locks are released before waiting,
 * and existing lock files are never removed or adopted. Mutations stay fail-fast. */
export async function withArtifactReadLocks(ownedRoot, services, action, { waitMs = 30000, pollMs = 100, signal } = {}) {
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60000 || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > 1000) throw new Error('Invalid artifact verification wait bound');
  const started = performance.now(), deadline = started + waitMs;
  let wasBusy = false;
  while (true) {
    signal?.throwIfAborted();
    if (wasBusy && performance.now() >= deadline) throw new IsolatedArtifactsBusyError(performance.now() - started);
    let entered = false;
    try { return await withArtifactLocks(ownedRoot, services, async () => {
      entered = true; signal?.throwIfAborted();
      if (wasBusy && performance.now() >= deadline) throw new IsolatedArtifactsBusyError(performance.now() - started);
      return action();
    }); }
    catch (error) {
      if (entered || !(error instanceof IsolatedArtifactsBusyError)) throw error;
      wasBusy = true;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new IsolatedArtifactsBusyError(performance.now() - started);
      await new Promise((done, reject) => {
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); done(); }, Math.min(pollMs, remaining));
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      });
    }
  }
}

async function installedPackages(repository) {
  const root = resolve(repository, 'node_modules'), packages = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const names = entry.name.startsWith('@') ? (await readdir(resolve(root, entry.name))).map(name => `${entry.name}/${name}`) : [entry.name];
    for (const name of names) {
      if (generatedPackages.includes(name)) continue;
      const path = resolve(root, name), metadata = await lstat(path);
      // Generated package directories must never silently become shared deps.
      if (!metadata.isSymbolicLink()) throw new Error(`Unexpected mutable installed package: ${name}`);
      const target = await realpath(path);
      const pkg = JSON.parse(await readFile(resolve(target, 'package.json'), 'utf8'));
      if (pkg.name !== name) throw new Error(`Installed package identity mismatch: ${name}`);
      packages.push({ name, target });
    }
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/** Only immutable installed package leaves are shared. Nuxt writes generated
 * @nuxthub packages and caches under its own root, never through a whole-tree
 * junction. Existing shared generated files are neither copied nor modified. */
export async function prepareDependencyFacade(dependencyRoot, serviceRoot, ownedRoot, legacyRepository) {
  await ownedDirectory(dependencyRoot, ownedRoot);
  await ownedDirectory(serviceRoot, ownedRoot, true);
  const target = resolve(serviceRoot, 'node_modules'), original = await maybeStat(target);
  if (original?.isSymbolicLink()) {
    if (!legacyRepository || await realpath(target) !== await realpath(resolve(legacyRepository, 'node_modules'))) throw new Error('Unexpected legacy dependency junction');
    await unlink(target); // Remove this link only, never traverse/delete its target.
  } else if (original && !original.isDirectory()) throw new Error('Unexpected dependency facade entry');
  await ownedDirectory(target, ownedRoot, true);
  for (const name of privateDirectories) {
    if (name.startsWith('@')) await ownedDirectory(resolve(target, name.split('/')[0]), ownedRoot, true);
    await ownedDirectory(resolve(target, name), ownedRoot, true);
  }
  const packages = await installedPackages(dependencyRoot);
  for (const pkg of packages) {
    const link = resolve(target, pkg.name);
    await ownedDirectory(dirname(link), ownedRoot, true);
    const existing = await maybeStat(link);
    if (existing) {
      if (!existing.isSymbolicLink()) throw new Error(`Unexpected isolated dependency: ${pkg.name}`);
      const oldTarget = await realpath(link);
      if (oldTarget !== pkg.target) {
        if (!inside(ownedRoot, oldTarget) || !relative(ownedRoot, oldTarget).replaceAll('\\', '/').match(/^dependencies-[a-f0-9-]+\/node_modules\//)) throw new Error('Existing dependency link is not an owned snapshot');
        await unlink(link);
        await symlink(pkg.target, link, process.platform === 'win32' ? 'junction' : 'dir');
      }
    } else await symlink(pkg.target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  await writeFile(resolve(target, '.isolated-facade.json'), JSON.stringify({ version: 1, packages }, null, 2));
  return verifyDependencyFacade(dependencyRoot, serviceRoot, ownedRoot);
}

export async function verifyDependencyFacade(dependencyRoot, serviceRoot, ownedRoot) {
  await ownedDirectory(dependencyRoot, ownedRoot);
  await ownedDirectory(serviceRoot, ownedRoot);
  const target = await ownedDirectory(resolve(serviceRoot, 'node_modules'), ownedRoot);
  for (const name of privateDirectories) await ownedDirectory(resolve(target, name), ownedRoot);
  const expected = await installedPackages(dependencyRoot);
  const saved = JSON.parse(await readFile(resolve(target, '.isolated-facade.json'), 'utf8'));
  if (saved.version !== 1 || JSON.stringify(saved.packages) !== JSON.stringify(expected)) throw new Error('Dependency facade changed; prepare a new isolated snapshot');
  for (const pkg of expected) {
    const path = resolve(target, pkg.name);
    if (!(await lstat(path)).isSymbolicLink() || await realpath(path) !== pkg.target) throw new Error(`Dependency resolution changed: ${pkg.name}`);
  }
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name.startsWith('@')) {
      await ownedDirectory(resolve(target, entry.name), ownedRoot);
      for (const child of await readdir(resolve(target, entry.name))) {
        const name = `${entry.name}/${child}`;
        if (!generatedPackages.includes(name) && !expected.some(pkg => pkg.name === name)) throw new Error('Unexpected scoped dependency entry');
      }
    } else if (entry.name.startsWith('.')) {
      if (entry.name === '.isolated-facade.json') continue;
      if (!privateDirectories.includes(entry.name)) throw new Error('Unexpected hidden dependency state');
      await ownedDirectory(resolve(target, entry.name), ownedRoot);
    } else if (!expected.some(pkg => pkg.name === entry.name)) throw new Error(`Unexpected dependency entry: ${entry.name}`);
  }
  return digest(JSON.stringify(expected));
}

/** Resolution begins at the service root, never at this helper's root project.
 * The returned executable is inside the physically copied dependency tree. */
export async function resolveIsolatedCli(dependencySnapshot, serviceRoot, service) {
  if (!['web', 'eve'].includes(service)) throw new Error('Unknown isolated CLI');
  const require = createRequire(resolve(serviceRoot, 'package.json'));
  const name = service === 'eve' ? 'eve' : 'nuxt';
  const packagePath = await realpath(require.resolve(`${name}/package.json`));
  if (!inside(resolve(dependencySnapshot.root, 'node_modules'), packagePath)) throw new Error('CLI resolved outside the private dependency snapshot');
  const path = await realpath(resolve(dirname(packagePath), service === 'eve' ? 'bin/eve.js' : 'bin/nuxt.mjs'));
  if (!inside(resolve(dependencySnapshot.root, 'node_modules'), path)) throw new Error('CLI executable escapes the private dependency snapshot');
  return path;
}

/** Parse generated code without executing it. A comment/config URL is not proof
 * of the URL actually passed to postgres(), and target overrides are forbidden. */
export function verifyGeneratedDatabaseModule(source, expectedDatabaseUrl) {
  const expected = assertIsolatedDatabaseUrl(expectedDatabaseUrl);
  const ast = ts.createSourceFile('db.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error('Generated database module cannot be parsed');
  const urlDeclarations = [], postgresCalls = [], postgresImports = [];
  const numericOptions = new Set(['max', 'idle_timeout', 'connect_timeout', 'max_lifetime']);
  function validateOptions(node) {
    if (!ts.isObjectLiteralExpression(node)) throw new Error('Generated database connection options are not a static object');
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) { validateOptions(property.expression); continue; }
      if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) throw new Error('Generated database option cannot be verified');
      const name = property.name.text, value = property.initializer;
      if (numericOptions.has(name) && ts.isNumericLiteral(value) && Number.isFinite(Number(value.text))) continue;
      if (name === 'prepare' && [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(value.kind)) continue;
      if (name === 'onnotice' && ts.isArrowFunction(value) && value.parameters.length === 0 && ts.isBlock(value.body) && value.body.statements.length === 0) continue;
      if (name === 'connection' && ts.isObjectLiteralExpression(value) && value.properties.length === 1) {
        const timezone = value.properties[0];
        if (ts.isPropertyAssignment(timezone) && !ts.isComputedPropertyName(timezone.name) && timezone.name.text === 'TimeZone'
          && ts.isStringLiteral(timezone.initializer) && timezone.initializer.text === 'UTC') continue;
      }
      // postgres-js supports aliases and nested startup overrides (db/pass and
      // connection.database/user). A denylist is insufficient here. Only this
      // application's static, non-routing generated options are accepted.
      throw new Error('Generated database connection option is outside the isolated allowlist');
    }
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'postgres') postgresImports.push(node.importClause?.name?.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'url') urlDeclarations.push(node);
    if ((ts.isParameter(node) || ts.isVariableDeclaration(node)) && ts.isIdentifier(node.name) && node.name.text === 'postgres') throw new Error('Generated postgres import is shadowed');
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'postgres') postgresCalls.push(node);
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /^postgres(?:ql)?:\/\//.test(node.text)) {
      if (assertIsolatedDatabaseUrl(node.text) !== expected) throw new Error('Generated database target does not match the isolated fixture');
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (postgresImports.length !== 1 || postgresImports[0] !== 'postgres' || postgresCalls.length !== 1 || urlDeclarations.length !== 1) throw new Error('Unexpected generated database client shape');
  const declaration = urlDeclarations[0], value = declaration.initializer;
  if (!value || !ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)
    || assertIsolatedDatabaseUrl(value.text) !== expected
    || !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) throw new Error('Generated database URL must be the exact immutable fixture target');
  const [url, options, ...extra] = postgresCalls[0].arguments;
  if (!url || !ts.isIdentifier(url) || url.text !== 'url' || !options || extra.length) throw new Error('Unverified generated database call');
  const clientDeclaration = postgresCalls[0].parent;
  if (!ts.isVariableDeclaration(clientDeclaration) || clientDeclaration.initializer !== postgresCalls[0]
    || !ts.isVariableStatement(declaration.parent.parent) || !ts.isVariableStatement(clientDeclaration.parent.parent)
    || declaration.parent.parent.parent !== clientDeclaration.parent.parent.parent) throw new Error('Generated database call does not use the verified URL binding');
  validateOptions(options);
  // Match the whole installed NuxtHub lazy-client template, not merely one
  // convincing postgres() call. Extra aliases, imports, exports or executable
  // statements can otherwise connect elsewhere without a PostgreSQL URL literal.
  // Template changes deliberately require an explicit guard update/review.
  const expectedSource = `import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.mjs';
let _db;
function getDb() {
  if (!_db) {
    try {
      const url = ${JSON.stringify(expected)};
      if (!url) throw new Error('DATABASE_URL, POSTGRES_URL, or POSTGRESQL_URL required');
      const client = postgres(url, ${options.getText(ast)});
      _db = drizzle({ client, schema });
    } catch (e) { throw new Error('[nuxt-hub] ' + e.message); }
  }
  return _db;
}
const db = new Proxy({}, { get(_, prop) { return getDb()[prop]; } });
export { db, schema };`;
  const canonical = tree => {
    const result = ts.transform(tree, [context => {
      const visit = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? ts.factory.createStringLiteral(node.text)
        : ts.visitEachChild(node, visit, context);
      return root => ts.visitNode(root, visit);
    }]);
    try { return ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed }).printFile(result.transformed[0]); }
    finally { result.dispose(); }
  };
  if (canonical(ast) !== canonical(ts.createSourceFile('expected.mjs', expectedSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS))) throw new Error('Generated database module differs from the verified NuxtHub client template');
  return digest(source);
}

async function treeFingerprint(root, ownedRoot, expectedDatabaseUrl) {
  await ownedDirectory(root, ownedRoot);
  const hash = createHash('sha256'); let fileCount = 0;
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name), name = relative(root, path).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) {
        const target = await realpath(path);
        if (!inside(root, target)) throw new Error('Compiled output contains an external dependency link');
        hash.update(`link\0${name}\0${relative(root, target).replaceAll('\\', '/')}\0`); continue;
      }
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile()) throw new Error('Unexpected entry in compiled output');
      const bytes = await readFile(path);
      hash.update(`file\0${name}\0`).update(bytes).update('\0'); fileCount++;
      if (/\.(?:[cm]?js|json|map)$/.test(name)) {
        // Also inspect literals in bundled runtimeConfig/inlined code: every
        // PostgreSQL URL present must name this exact isolated fixture.
        for (const [value] of bytes.toString('utf8').matchAll(/postgres(?:ql)?:\/\/[^'"\s`\\]+/g)) {
          if (assertIsolatedDatabaseUrl(value) !== expectedDatabaseUrl) throw new Error('Compiled artifact contains a non-isolated database target');
        }
      }
    }
  }
  await visit(root);
  return { sha256: hash.digest('hex'), fileCount };
}

export async function authoredFingerprint(serviceRoot, files) {
  const hash = createHash('sha256');
  for (const name of [...files].sort()) {
    const path = resolve(serviceRoot, name);
    if (!inside(serviceRoot, path) || !(await lstat(path)).isFile() || relative(path, await realpath(path)) !== '') throw new Error('Authored snapshot contains an unowned file');
    hash.update(name).update('\0').update(await readFile(path)).update('\0');
  }
  return hash.digest('hex');
}

export async function inspectIsolatedBuild({ dependencySnapshot, serviceRoot, ownedRoot, service, databaseUrl, source }) {
  const expected = assertIsolatedDatabaseUrl(databaseUrl);
  const dependencySha256 = await verifyDependencySnapshot(dependencySnapshot, ownedRoot);
  const facadeSha256 = await verifyDependencyFacade(dependencySnapshot.root, serviceRoot, ownedRoot);
  if (await authoredFingerprint(serviceRoot, source.files) !== source.sourceSha256) throw new Error('Authored snapshot differs from its frozen source manifest');
  const generated = {};
  for (const name of generatedPackages) generated[name] = await treeFingerprint(resolve(serviceRoot, 'node_modules', name), ownedRoot, expected);
  const databaseSha256 = verifyGeneratedDatabaseModule(await readFile(resolve(serviceRoot, 'node_modules/@nuxthub/db/db.mjs'), 'utf8'), expected);
  if (service === 'web') verifyGeneratedDatabaseModule(await readFile(resolve(serviceRoot, '.output/server/node_modules/@nuxthub/db/db.mjs'), 'utf8'), expected);
  if (!['web', 'eve'].includes(service)) throw new Error('Unknown isolated service');
  const output = await treeFingerprint(resolve(serviceRoot, '.output'), ownedRoot, expected);
  if (!(await lstat(resolve(serviceRoot, '.output/server/index.mjs'))).isFile()) throw new Error('Built service entry point is missing');
  return { version: 1, dependencySha256, facadeSha256, databaseSha256, generated, output };
}

export function verifyBuildReceipt(receipt, observed) {
  if (!receipt || receipt.version !== 1 || JSON.stringify(receipt) !== JSON.stringify(observed)) throw new Error('Isolated compiled output or generated dependencies changed since build verification');
}
