import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { isolatedProcessEnvironment, readIsolationFixture } from './autonomy-isolation.mjs';
import { authoredFingerprint, inspectIsolatedBuild, isolatedModuleFenceSource, prepareDependencyFacade, prepareDependencySnapshot, resolveIsolatedCli, verifyBuildReceipt, verifyDependencyFacade, verifyDependencySnapshot, withArtifactLocks, withArtifactReadLocks } from './isolated-build-integrity.mjs';
import { isolatedServiceCommand, observeWindowsRuntime, requireWindowsRuntimeStopped, verifyRuntimeIdentity } from './isolated-runtime-identity.mjs';
import { selectIsolatedWorkflowStore, verifyIsolatedWorkflowStore } from './isolated-workflow-store.mjs';
import { assertExtraDeployment, hash } from './browser-variants-protocol.mjs';
import { assertEvidenceGapDeployment, EVIDENCE_GAP_LAUNCHER } from './evidence-gap-config.mjs';
import { reportFaultRuntimeFiles } from './report-fault-runtime.mjs';
import { reportFaultStartup, reportFaultDatabaseUrl, reportFaultDriverReady, createReportFaultRuntime, verifyReportFaultRuntime } from './report-fault-startup.mjs';
import { securityContextFiles } from './security-context-runtime.mjs';
import { securityContextStartup, createSecurityContextRuntime, verifySecurityContextRuntime } from './security-context-startup.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceDirectories = ['agent', 'app', 'server', 'shared', 'public', 'infra/execution'];
const sourceFiles = ['nuxt.config.ts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.agent.json', 'eslint.config.mjs', 'infra/codex-worker/access.mjs', 'tests/helpers/autonomy-isolation.mjs', 'tests/fixtures/autonomy-site/resolver.mjs', 'tests/helpers/browser-variants-resolver.mjs', 'tests/helpers/browser-variants-extra-resolver.mjs', 'tests/helpers/evidence-gap-resolver.mjs', ...reportFaultRuntimeFiles, ...securityContextFiles];
const within = (base, path) => { const child = relative(base, path); return child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child); };
const pathFor = fixture => resolve(repository, '.data/autonomy-isolation', `application-${fixture.runtimeScope.split(':')[1]}`);
const verifyFixtureOrigins = fixture => {
  if (fixture.app?.origin !== 'http://127.0.0.1:58000' || fixture.app?.eveOrigin !== 'http://127.0.0.1:58001') throw new Error('Fixture app origins must match the exact managed runtime listeners');
};

export function validateExtraVariantsConfiguration({ fixture, manifest, hashes, snapshotResolverSha256 }) {
  isolatedProcessEnvironment(fixture);
  assertExtraDeployment(manifest, { ...hashes, runtimeScope: fixture.runtimeScope });
  if (snapshotResolverSha256 !== hashes.resolverSha256) throw new Error('Extra fixture resolver is absent or differs from the frozen authored snapshot');
  return { ...hashes, manifestSha256: hash(JSON.stringify(manifest)), containerId: manifest.containerId };
}
async function extraVariantsConfiguration(fixture) {
  const manifest = JSON.parse(await readFile(resolve(repository, '.data/autonomy-isolation/linux/browser-variants-extra-deployment.json'), 'utf8'));
  const hashes = {};
  for (const [key, file] of [['serverSha256', 'tests/fixtures/browser-variants-extra-site.mjs'], ['oracleSha256', 'tests/fixtures/browser-variants-extra-oracle.json'], ['resolverSha256', 'tests/helpers/browser-variants-extra-resolver.mjs']]) hashes[key] = hash(await readFile(resolve(repository, file)));
  const snapshotResolverSha256 = hash(await readFile(resolve(pathFor(fixture), 'web/tests/helpers/browser-variants-extra-resolver.mjs')));
  return validateExtraVariantsConfiguration({ fixture, manifest, hashes, snapshotResolverSha256 });
}

export function validateEvidenceGapConfiguration({ fixture, manifest, hashes, snapshotResolverSha256 }) {
  isolatedProcessEnvironment(fixture);
  if (fixture.browser?.url !== 'http://127.0.0.1:58092') throw new Error('Evidence fixture requires the owned isolated browser');
  assertEvidenceGapDeployment(manifest, { ...hashes, runtimeScope: fixture.runtimeScope });
  if (snapshotResolverSha256 !== hashes.resolverSha256) throw new Error('Evidence fixture resolver is absent or differs from the frozen authored snapshot');
  return { ...hashes, manifestSha256: hash(JSON.stringify(manifest)), containerId: manifest.containerId };
}
async function evidenceGapConfiguration(fixture) {
  const manifest = JSON.parse(await readFile(resolve(repository, '.data/autonomy-isolation/linux/evidence-gap-deployment.json'), 'utf8'));
  const hashes = { launcherSha256: hash(EVIDENCE_GAP_LAUNCHER) };
  for (const [key, file] of [['serverSha256', 'tests/fixtures/evidence-gap-site.mjs'], ['resolverSha256', 'tests/helpers/evidence-gap-resolver.mjs']]) hashes[key] = hash(await readFile(resolve(repository, file)));
  const snapshotResolverSha256 = hash(await readFile(resolve(pathFor(fixture), 'web/tests/helpers/evidence-gap-resolver.mjs')));
  return validateEvidenceGapConfiguration({ fixture, manifest, hashes, snapshotResolverSha256 });
}

async function requireStopped(root, services) {
  const runtime = await readFile(resolve(root, 'runtime.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; return {}; });
  await requireWindowsRuntimeStopped(root, runtime, services);
}

async function physicalDirectory(path) {
  await mkdir(path, { recursive: true });
  if (relative(resolve(path), await realpath(path)) !== '') throw new Error('Authored snapshots must not write through directory links');
}

async function filesUnder(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.env') || ['node_modules', '.data', '.eve', '.output', '.nuxt'].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error('Authored source snapshots may not include symlinks');
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesUnder(resolve(directory, entry.name), path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Refresh only authored files; durable workflow/memory/evidence state survives. */
export async function prepareIsolatedApp(fixture, { preserveAuthored = false, onAuthoredCaptured } = {}) {
  fixture ||= await readIsolationFixture();
  isolatedProcessEnvironment(fixture); // validate the database/runtime before any work
  const root = pathFor(fixture);
  return withArtifactLocks(root, ['dependencies', 'web', 'eve'], async () => {
  await requireStopped(root, ['web', 'eve']);
  const manifestPath = resolve(root, 'source-manifest.json');
  const previous = await readFile(manifestPath, 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; return { files: [] }; });
  const observerFile = 'tests/helpers/observe-http.mjs';
  const fenceFile = 'tests/helpers/isolation-module-fence.mjs';
  const cssConfigFile = '.cssnanorc.json';
  const generatedFiles = [observerFile, fenceFile, cssConfigFile];
  if (preserveAuthored) {
    if (!previous.sourceSha256) throw new Error('No existing authored snapshot to preserve');
    for (const service of ['web', 'eve']) if (await authoredFingerprint(resolve(root, service), previous.files) !== previous.sourceSha256) throw new Error('Existing authored snapshot changed before scaffold refresh');
  }
  const files = preserveAuthored ? previous.files.filter(file => !generatedFiles.includes(file)) : [...sourceFiles];
  if (!preserveAuthored) for (const directory of sourceDirectories) {
    for (const file of await filesUnder(resolve(repository, directory))) files.push(`${directory}/${file}`);
  }
  const contents = new Map();
  for (const file of files) contents.set(file, await readFile(resolve(preserveAuthored ? resolve(root, 'web') : repository, file)));
  // Capture the exact authored bytes before slow dependency verification so
  // coordinated writers can resume as soon as this callback returns. Later
  // copies use these buffers, never re-read the changing checkout.
  if (onAuthoredCaptured) await onAuthoredCaptured({ capturedAt: new Date().toISOString(), files: files.length });
  const dependencySnapshot = await prepareDependencySnapshot(repository, root);
  if (createHash('sha256').update(contents.get('pnpm-lock.yaml')).digest('hex') !== dependencySnapshot.lockfileSha256) throw new Error('Captured lockfile differs from the verified dependency snapshot');
  files.push(observerFile);
  contents.set(observerFile, Buffer.from(`import http from 'node:http';\nimport { appendFileSync } from 'node:fs';\nconst original = http.Server.prototype.emit;\nhttp.Server.prototype.emit = function(event, ...args) {\n  if (event === 'request') {\n    const [request, response] = args;\n    const path = new URL(request.url, 'http://127.0.0.1').pathname;\n    if (path.startsWith('/api/internal/')) response.once('finish', () => appendFileSync(${JSON.stringify(resolve(root, 'scheduled-http.jsonl'))}, JSON.stringify({ timestamp: new Date().toISOString(), method: request.method, path, status: response.statusCode }) + '\\n'));\n  }\n  return original.call(this, event, ...args);\n};\n`));
  files.push(fenceFile);
  contents.set(fenceFile, Buffer.from(isolatedModuleFenceSource(dependencySnapshot.root)));
  // cssnano's default lilconfig search otherwise ascends into the parent
  // repository package.json. Pin its unchanged default inside the snapshot.
  files.push(cssConfigFile);
  contents.set(cssConfigFile, Buffer.from('{"preset":"default"}\n'));
  files.sort();
  const hash = createHash('sha256');
  for (const name of files) hash.update(name).update('\0').update(contents.get(name)).update('\0');
  const manifest = { sourceSha256: hash.digest('hex'), copiedAt: new Date().toISOString(), files, dependencySnapshot };
  for (const name of ['web', 'eve']) {
    const target = resolve(root, name);
    await physicalDirectory(target);
    for (const old of previous.files) {
      if (files.includes(old)) continue;
      const path = resolve(target, old);
      if (!within(target, path) || (!sourceFiles.includes(old) && !generatedFiles.includes(old) && !sourceDirectories.some(directory => old.startsWith(`${directory}/`)))) throw new Error('Invalid previous snapshot path');
      if (relative(dirname(path), await realpath(dirname(path))) !== '') throw new Error('Previous snapshot path has an external parent');
      await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    for (const file of files) {
      const destination = resolve(target, file);
      await physicalDirectory(dirname(destination));
      // Hash and copy the same in-memory bytes, even if authored source changes
      // while the other service's copy is being written.
      await unlink(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await writeFile(destination, contents.get(file), { flag: 'wx' });
    }
    await prepareDependencyFacade(dependencySnapshot.root, target, root, repository);
    if (await authoredFingerprint(target, files) !== manifest.sourceSha256) throw new Error('Snapshot copy does not match the manifest');
    for (const entry of await readdir(target)) if (entry.startsWith('.env')) throw new Error('Environment files are forbidden in isolated snapshots');
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const fixturePath = resolve(repository, '.data/autonomy-isolation/fixture.json');
  const currentFixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  if (currentFixture.runtimeScope !== fixture.runtimeScope) throw new Error('Isolation fixture changed during snapshot');
  currentFixture.app = { origin: 'http://127.0.0.1:58000', eveOrigin: 'http://127.0.0.1:58001', root, sourceSha256: manifest.sourceSha256, runtimePath: resolve(root, 'runtime.json'), sourceManifestPath: manifestPath };
  await writeFile(fixturePath, JSON.stringify(currentFixture, null, 2));
  await writeFile(resolve(root, 'README.md'), `# Isolated Syna runtime\n\nSource SHA256: ${manifest.sourceSha256}\n\nRun from the repository using its Node 24 runtime:\n\n- \`pnpm exec node tests/helpers/start-isolated-app.mjs prepare\` refreshes authored files only.\n- \`pnpm exec node tests/helpers/start-isolated-app.mjs build-eve\` builds the actual Eve service and schedules.\n- \`pnpm exec node tests/helpers/start-isolated-app.mjs build-web\` builds actual Nuxt with loopback Eve routing.\n- \`pnpm exec node tests/helpers/start-isolated-app.mjs start\` starts built Node servers; Eve starts the real cron scheduler.\n- \`pnpm exec node tests/helpers/start-isolated-app.mjs status\` prints local PIDs/origins.\n\nNo package build/dev/migrate script is invoked; no environment file, old workflow store, shared service credential, or existing production data is copied. Child environments are allowlisted. State under each snapshot survives refresh/restart. Local GoTrue, PostgreSQL, browser, and the template-only prewarm service must already be started. The prewarm service cannot execute repo/sandbox jobs. Model credentials are absent unless explicitly passed by the calling test.\n`);
  return { root, ...manifest };
  });
}

export function isolatedAppEnvironment(fixture, service, options = {}, reportFault = null, securityContext = null) {
  if (!['web', 'eve'].includes(service)) throw new Error('Unknown isolated service');
  const cwd = resolve(pathFor(fixture), service);
  const environment = isolatedProcessEnvironment(fixture, options);
  Object.assign(environment, {
    NODE_ENV: 'production',
    APP_URL: 'http://127.0.0.1:58000',
    NUXT_PUBLIC_SITE_URL: 'http://127.0.0.1:58000',
    EVE_NUXT_PRODUCTION_ORIGIN: 'http://127.0.0.1:58001',
    EVE_BASE_URL: 'http://127.0.0.1:58001',
    WORKFLOW_LOCAL_BASE_URL: 'http://127.0.0.1:58001',
    HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1',
    PORT: service === 'web' ? '58000' : '58001',
    NITRO_PORT: service === 'web' ? '58000' : '58001',
    NUXT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
    SYNA_ISOLATED_STORAGE_ROOT: resolve(pathFor(fixture), 'web/.data/autonomy-isolation/evidence'),
    SYNA_ISOLATED_MEMORY_ROOT: resolve(cwd, '.data/autonomy-isolation/memory'),
    NODE_OPTIONS: `--import=${pathToFileURL(resolve(cwd, 'tests/helpers/isolation-module-fence.mjs')).href}`,
  });
  if (securityContext) {
    if (!options.securityContextManifestFile || options.healthSmoke || reportFault) throw new Error('SEC observation requires explicit application-only startup');
    const entry = securityContext.services?.[service];
    if (!entry || securityContext.manifestFile !== resolve(options.securityContextManifestFile)
      || entry.path !== resolve(pathFor(fixture), `security-context-${entry.configHash}.json`)) throw new Error('SEC observer config is outside the exact owned startup');
    environment.SYNA_SECURITY_CONTEXT_PRELOAD = '1';
    environment.SYNA_SECURITY_CONTEXT_CONFIG = entry.path;
    environment.NODE_OPTIONS += ` --import=${pathToFileURL(resolve(cwd, 'tests/helpers/security-context-preload.mjs')).href}`;
  }
  if (reportFault) {
    if (options.healthSmoke) throw new Error('Health smoke cannot activate fault transports');
    const databaseUrl = reportFaultDatabaseUrl(fixture.databaseUrl, reportFault);
    Object.assign(environment, { DATABASE_URL: databaseUrl, POSTGRES_URL: databaseUrl, POSTGRESQL_URL: databaseUrl });
    if (service === 'web' && reportFault.runtimeConfiguration) {
      environment.SYNA_REPORT_FAULT_PRELOAD = '1';
      environment.SYNA_REPORT_FAULT_RUNTIME = reportFault.runtimeConfiguration.path;
      environment.NODE_OPTIONS += ` --import=${pathToFileURL(resolve(cwd, 'tests/helpers/report-fault-preload.mjs')).href}`;
    }
  }
  if (options.siteFixture === true && service === 'web') {
    environment.SYNA_AUTONOMY_SITE = 'fixture-v1';
    environment.NODE_OPTIONS += ` --import=${pathToFileURL(resolve(cwd, 'tests/fixtures/autonomy-site/resolver.mjs')).href}`;
  }
  if (options.benchmarkFixture === true && service === 'web') {
    environment.SYNA_BROWSER_VARIANTS = 'fixture-v1';
    environment.NODE_OPTIONS += ` --import=${pathToFileURL(resolve(cwd, 'tests/helpers/browser-variants-resolver.mjs')).href}`;
  }
  if (options.extraVariantsFixture === true && service === 'web') {
    environment.SYNA_BROWSER_EXTRA_VARIANTS = 'fixture-v1';
    environment.NODE_OPTIONS += ` --import=${pathToFileURL(resolve(cwd, 'tests/helpers/browser-variants-extra-resolver.mjs')).href}`;
  }
  if (options.evidenceGapFixture === true && service === 'web') {
    if (fixture.browser?.url !== 'http://127.0.0.1:58092') throw new Error('Evidence fixture requires the owned isolated browser');
    environment.SYNA_EVIDENCE_GAP = 'fixture-v1';
    environment.NODE_OPTIONS += ` --import=${pathToFileURL(resolve(cwd, 'tests/helpers/evidence-gap-resolver.mjs')).href}`;
  }
  if (options.healthSmoke) {
    const { id, templateOrigin } = options.healthSmoke;
    const url = new URL(templateOrigin);
    if (!/^[a-f0-9-]{36}$/.test(id) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password
      || options.modelToken || options.autonomy || options.sharedOtto || options.siteFixture || options.benchmarkFixture || options.extraVariantsFixture || options.evidenceGapFixture || options.securityContextManifestFile) throw new Error('Invalid credential-free health smoke configuration');
    Object.assign(environment, {
      PAT_RUNTIME_SCOPE: `autonomy-test:health-${id}`,
      AUTONOMOUS_MISSIONS_ENABLED: 'false', MISSIONS_ENABLED: 'false', MISSION_REPORTS_ENABLED: 'false', MISSION_AUTOMATIC_REPORTS: 'false',
      GRUNDEN_API_TOKEN: '', ENV_VAULT_KEY: '', BROWSER_SERVICE_KEY: '', REPO_RUNNER_KEY: 'health-template-only', REPO_RUNNER_URL: url.origin,
    });
  }
  return environment;
}

export async function buildIsolatedApp(fixture, service, options = {}) {
  isolatedProcessEnvironment(fixture);
  if (!['web', 'eve'].includes(service)) throw new Error('Unknown isolated service');
  const root = pathFor(fixture);
  // A builder must never mutate even a previously unknown dependency cache
  // while the other service is running. Builds/prepare are serialized; a
  // restart without rebuilding can still target one service.
  return withArtifactLocks(root, ['dependencies', 'web', 'eve'], async () => {
  await requireStopped(root, ['web', 'eve']);
  const source = JSON.parse(await readFile(resolve(root, 'source-manifest.json'), 'utf8'));
  const reportFault = options.reportFaultConfigFile ? await reportFaultStartup(options.reportFaultConfigFile, fixture, source, root) : null;
  const cwd = resolve(root, service);
  await verifyDependencySnapshot(source.dependencySnapshot, root);
  await verifyDependencyFacade(source.dependencySnapshot.root, cwd, root);
  if (await authoredFingerprint(cwd, source.files) !== source.sourceSha256) throw new Error('Source copy differs from the frozen manifest');
  const logPath = resolve(root, `${service}-build.log`);
  const cli = await resolveIsolatedCli(source.dependencySnapshot, cwd, service);
  const args = service === 'eve' ? [cli, 'build'] : [cli, 'build', '--preset', 'node-server'];
  const log = openSync(logPath, 'w');
  const execute = arguments_ => new Promise((done, reject) => {
    const child = spawn(process.execPath, arguments_, { cwd, env: isolatedAppEnvironment(fixture, service, {}, reportFault), windowsHide: true, stdio: ['ignore', log, log] });
    child.once('error', reject); child.once('exit', done);
  });
  let code;
  try {
    // The repository tsconfig references generated Nuxt types, even for Eve.
    // EVE_BASE_URL prevents Nuxt prepare from spawning a development agent.
    if (service === 'eve') {
      const prepareCode = await execute([await resolveIsolatedCli(source.dependencySnapshot, cwd, 'web'), 'prepare']);
      if (prepareCode !== 0) throw new Error(`Isolated Eve type preparation failed (${prepareCode}); inspect ${logPath}`);
    }
    code = await execute(args);
  } finally { closeSync(log); }
  if (code !== 0) throw new Error(`Isolated ${service} build failed (${code}); inspect ${logPath}`);
  if (JSON.parse(await readFile(resolve(root, 'source-manifest.json'), 'utf8')).sourceSha256 !== source.sourceSha256) throw new Error('Source snapshot changed during build; rebuild before acceptance');
  const integrity = await inspectIsolatedBuild({ dependencySnapshot: source.dependencySnapshot, serviceRoot: cwd, ownedRoot: root, service, databaseUrl: reportFault?.databaseUrl ?? fixture.databaseUrl, source });
  await writeFile(resolve(root, `${service}-build.json`), JSON.stringify({ sourceSha256: source.sourceSha256, builtAt: new Date().toISOString(), logPath, integrity, reportFaultBuild: reportFault?.buildBinding ?? null }, null, 2));
  return { service, logPath, code, integrity };
  });
}

/** Read-only artifact verification for acceptance before V.submit. This does
 * not query a database, call HTTP, drain queues or start/stop a process. Logs,
 * caches and workflow data outside .output are deliberately not build inputs. */
export async function verifyIsolatedAppArtifacts(fixture, { requireRuntime = false, allowHealthSmoke = false, reportFaultConfigFile } = {}) {
  isolatedProcessEnvironment(fixture);
  verifyFixtureOrigins(fixture);
  const root = pathFor(fixture);
  return withArtifactReadLocks(root, ['dependencies', 'web', 'eve'], async () => {
    const source = JSON.parse(await readFile(resolve(root, 'source-manifest.json'), 'utf8'));
    if (source.sourceSha256 !== fixture.app?.sourceSha256) throw new Error('Isolation fixture does not identify the current source snapshot; reload it after prepare');
    const runtime = requireRuntime ? JSON.parse(await readFile(resolve(root, 'runtime.json'), 'utf8')) : null;
    const faultFile = reportFaultConfigFile ?? runtime?.reportFaultConfigFile;
    const reportFault = faultFile ? await reportFaultStartup(faultFile, fixture, source, root, { allowExpired: true }) : null;
    if (runtime && reportFault) await verifyReportFaultRuntime(reportFault, runtime, root);
    if (runtime && !reportFault && runtime.reportFault) throw new Error('Runtime fault identity has no verified configuration');
    if (runtime && runtime.mode !== 'application' && !(allowHealthSmoke && runtime.mode === 'health-smoke')) throw new Error('Health-smoke runtime cannot be used for application acceptance');
    if (runtime && runtime.sourceSha256 !== source.sourceSha256) throw new Error('Running runtime source differs from the current snapshot');
    const workflowStore = runtime ? await verifyIsolatedWorkflowStore(root, runtime.workflowStore || {}) : null;
    if (workflowStore && (workflowStore.sourceSha256 !== source.sourceSha256
      || workflowStore.purpose !== (runtime.mode === 'health-smoke' ? 'smoke' : 'acceptance'))) throw new Error('Running workflow store does not match its mode/source');
    const services = {};
    for (const service of ['web', 'eve']) {
      const built = JSON.parse(await readFile(resolve(root, `${service}-build.json`), 'utf8'));
      if (built.sourceSha256 !== source.sourceSha256) throw new Error('Service build does not match the current source snapshot');
      if (JSON.stringify(built.reportFaultBuild ?? null) !== JSON.stringify(reportFault?.buildBinding ?? null)) throw new Error('Fault database build must have the exact explicit manifest; runtime overrides are forbidden');
      const integrity = await inspectIsolatedBuild({ dependencySnapshot: source.dependencySnapshot, serviceRoot: resolve(root, service), ownedRoot: root, service, databaseUrl: reportFault?.databaseUrl ?? fixture.databaseUrl, source });
      verifyBuildReceipt(built.integrity, integrity);
      if (runtime) {
        verifyBuildReceipt(runtime[service]?.integrity, integrity);
        if (!Number.isSafeInteger(runtime[service]?.pid) || runtime[service].pid <= 0) throw new Error('Verified service has no positive runtime PID');
        if (runtime[service].cwd !== resolve(root, service)
          || runtime[service].origin !== (service === 'web' ? 'http://127.0.0.1:58000' : 'http://127.0.0.1:58001')) throw new Error('Recorded runtime location differs from the owned service');
        process.kill(runtime[service].pid, 0); // Presence only, no signal.
      }
      services[service] = integrity;
    }
    if (runtime?.extraVariantsFixture && JSON.stringify(runtime.extraVariantsFixture) !== JSON.stringify(await extraVariantsConfiguration(fixture))) throw new Error('Extra fixture configuration changed after the process started');
    if (runtime?.evidenceGapFixture && JSON.stringify(runtime.evidenceGapFixture) !== JSON.stringify(await evidenceGapConfiguration(fixture))) throw new Error('Evidence fixture configuration changed after the process started');
    const processIdentity = runtime ? verifyRuntimeIdentity({ root, runtime, nodeExecutable: source.dependencySnapshot.runtime.executable,
      eveCli: await resolveIsolatedCli(source.dependencySnapshot, resolve(root, 'eve'), 'eve'), observed: await observeWindowsRuntime(runtime), requireRecordedIdentity: true }) : null;
    const securityContext = runtime?.securityContext
      ? await verifySecurityContextRuntime(await securityContextStartup(runtime.securityContext.manifestFile, fixture, source, root), runtime, processIdentity, { allowExpired: true }) : null;
    return { sourceSha256: source.sourceSha256, dependencySha256: source.dependencySnapshot.sourceSha256, services, runtime, processIdentity, workflowStore, securityContext };
  });
}

export async function startIsolatedApp(fixture, options = {}) {
  isolatedProcessEnvironment(fixture, options);
  verifyFixtureOrigins(fixture);
  const root = pathFor(fixture);
  const services = options.services || ['web', 'eve'];
  if (!services.length || services.some(service => !['web', 'eve'].includes(service))) throw new Error('Unknown isolated service');
  return withArtifactLocks(root, ['dependencies', 'web', 'eve'], async () => {
  const runtimePath = resolve(root, 'runtime.json');
  const previous = await readFile(runtimePath, 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; return {}; });
  const modelRequestIntervalMs = options.modelRequestIntervalMs ?? 0;
  if (services.length !== 2 && modelRequestIntervalMs !== (previous.modelRequestIntervalMs ?? 0)) throw new Error('Worker restart must preserve provider pacing for both services');
  const source = JSON.parse(await readFile(resolve(root, 'source-manifest.json'), 'utf8'));
  const reportFault = options.reportFaultConfigFile ? await reportFaultStartup(options.reportFaultConfigFile, fixture, source, root) : null;
  if (services.length !== 2 && (options.securityContextManifestFile || previous.securityContext)) throw new Error('SEC observer requires a fresh two-service measurement window');
  if (options.securityContextManifestFile && [...services].sort().join(',') !== 'eve,web') throw new Error('SEC observer requires both distinct services');
  if (options.securityContextManifestFile && (options.healthSmoke || reportFault)) throw new Error('SEC observer cannot be combined with smoke/fault transport');
  const securityStartup = options.securityContextManifestFile ? await securityContextStartup(options.securityContextManifestFile, fixture, source, root) : null;
  if (securityStartup && modelRequestIntervalMs !== securityStartup.manifest.modelRequestIntervalMs) throw new Error('SEC manifest provider pacing differs from startup');
  if (services.length !== 2 && (previous.reportFaultConfigFile ?? null) !== (reportFault?.configFile ?? null)) throw new Error('Worker restart must preserve the exact fault configuration');
  const runtime = { ...previous, sourceSha256: source.sourceSha256, startedAt: new Date().toISOString(), modelRequestIntervalMs, mode: options.healthSmoke ? 'health-smoke' : 'application' };
  runtime.reportFault = reportFault?.binding ?? null; runtime.reportFaultConfigFile = reportFault?.configFile ?? null;
  runtime.securityContext = null;
  if (services.includes('web')) runtime.reportFaultStartup = null;
  const workflowSelection = { id: options.healthSmoke?.id || options.workflowStoreId,
    purpose: options.healthSmoke ? 'smoke' : 'acceptance', sourceSha256: source.sourceSha256, fresh: !!options.healthSmoke || options.freshWorkflowStore === true };
  if (!workflowSelection.id) throw new Error('Application start requires explicit workflowStoreId; preserve that ID for worker restarts');
  for (const service of services) isolatedAppEnvironment(fixture, service, options, reportFault);
  if (services.includes('web')) runtime.extraVariantsFixture = options.extraVariantsFixture === true ? await extraVariantsConfiguration(fixture) : null;
  if (services.includes('web')) runtime.evidenceGapFixture = options.evidenceGapFixture === true ? await evidenceGapConfiguration(fixture) : null;
  await requireStopped(root, services);
  if (reportFault) await reportFaultDriverReady(reportFault);
  const verified = new Map();
  // Validate every selected service before spawning any process or making even
  // a local health request. Pre-integrity build receipts intentionally fail.
  for (const service of services) {
    const built = JSON.parse(await readFile(resolve(root, `${service}-build.json`), 'utf8'));
    if (built.sourceSha256 !== runtime.sourceSha256) throw new Error('Both services must be built from the current snapshot before starting');
    if (JSON.stringify(built.reportFaultBuild ?? null) !== JSON.stringify(reportFault?.buildBinding ?? null)) throw new Error('Fault database requires a separately verified compiled build, never a runtime-only override');
    const integrity = await inspectIsolatedBuild({ dependencySnapshot: source.dependencySnapshot, serviceRoot: resolve(root, service), ownedRoot: root, service, databaseUrl: reportFault?.databaseUrl ?? fixture.databaseUrl, source });
    verifyBuildReceipt(built.integrity, integrity);
    verified.set(service, integrity);
  }
  if (!workflowSelection.fresh && previous.workflowStore?.id === workflowSelection.id) {
    if (previous.workflowStore.purpose !== workflowSelection.purpose || previous.workflowStore.sourceSha256 !== workflowSelection.sourceSha256) throw new Error('Worker restart must preserve workflow mode/source');
    runtime.workflowStore = await verifyIsolatedWorkflowStore(root, previous.workflowStore);
  } else {
    await requireStopped(root, ['web', 'eve']);
    runtime.workflowStore = await selectIsolatedWorkflowStore(root, workflowSelection);
  }
  if (reportFault?.manifest.taskId === 'REP-06' && services.includes('web')) {
    reportFault.runtimeConfiguration = await createReportFaultRuntime(reportFault, root);
    runtime.reportFaultStartup = reportFault.runtimeConfiguration;
  }
  if (securityStartup) runtime.securityContext = await createSecurityContextRuntime(securityStartup);
  for (const service of services) {
    await verifyIsolatedWorkflowStore(root, runtime.workflowStore);
    const cwd = resolve(root, service);
    const args = isolatedServiceCommand(root, service, service === 'eve' ? await resolveIsolatedCli(source.dependencySnapshot, cwd, service) : undefined);
    const stdout = openSync(resolve(root, `${service}-stdout.log`), 'a');
    const stderr = openSync(resolve(root, `${service}-stderr.log`), 'a');
    const child = spawn(process.execPath, args, { cwd, env: isolatedAppEnvironment(fixture, service, options, reportFault, runtime.securityContext), windowsHide: true, detached: true, stdio: ['ignore', stdout, stderr] });
    child.unref(); closeSync(stdout); closeSync(stderr);
    runtime[service] = { pid: child.pid, cwd, startedAt: new Date().toISOString(), origin: service === 'web' ? 'http://127.0.0.1:58000' : 'http://127.0.0.1:58001', integrity: verified.get(service) };
    await writeFile(runtimePath, JSON.stringify(runtime, null, 2));
  }
  for (const service of services) {
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const identity = verifyRuntimeIdentity({ root, runtime, nodeExecutable: source.dependencySnapshot.runtime.executable,
          eveCli: service === 'eve' ? await resolveIsolatedCli(source.dependencySnapshot, resolve(root, 'eve'), 'eve') : undefined,
          services: [service], observed: await observeWindowsRuntime(runtime, [service]) });
        runtime[service].identity = identity[service];
        await writeFile(runtimePath, JSON.stringify(runtime, null, 2));
        const response = await fetch(runtime[service].origin + (service === 'web' ? '/api/auth/get-session' : '/eve/v1/health'), { signal: AbortSignal.timeout(1500) });
        await response.body?.cancel();
        if (response.ok) { ready = true; break; }
      } catch { /* Wait for this newly spawned local service only. */ }
      await new Promise(done => setTimeout(done, 100));
    }
    if (!ready) throw new Error(`Isolated ${service} did not become ready; inspect ${root}`);
  }
  if (reportFault?.manifest.taskId === 'REP-06') {
    const ready = await reportFaultDriverReady(reportFault);
    if (ready.preloadReady?.pid !== runtime.web.pid || ready.preloadReady?.nonce !== runtime.reportFaultStartup?.nonce) throw new Error('Web process did not attest its frozen preload');
    runtime.reportFaultStartup.receipt = ready.preloadReady;
    await verifyReportFaultRuntime(reportFault, runtime, root);
    await writeFile(runtimePath, JSON.stringify(runtime, null, 2));
  }
  if (securityStartup) {
    // Startup has already verified CIM/executable/argv/listener identities.
    // The Eve CLI and its child may both preload; only the actual listener's
    // ready receipt can be used for later per-trial checkpoints.
    await verifySecurityContextRuntime(securityStartup, runtime, Object.fromEntries(services.map(service => [service, runtime[service].identity])));
    await writeFile(runtimePath, JSON.stringify(runtime, null, 2));
  }
  return runtime;
  });
}

/** Stop only recorded Windows runtime trees after checking their command lines. */
export async function stopIsolatedApp(fixture, services = ['web', 'eve']) {
  isolatedProcessEnvironment(fixture);
  if (process.platform !== 'win32') throw new Error('This native isolation fixture currently supports verified Windows process cleanup only');
  if (!services.length || services.some(service => !['web', 'eve'].includes(service))) throw new Error('Unknown isolated service');
  const root = pathFor(fixture);
  const script = resolve(root, 'stop-runtime.ps1');
  await writeFile(script, String.raw`param([Parameter(Mandatory=$true)][string]$RuntimePath, [string]$Services='web,eve')
$ErrorActionPreference = 'Stop'
$runtimeRoot = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($RuntimePath))
if ($runtimeRoot -ne [IO.Path]::GetFullPath($PSScriptRoot)) { throw 'Runtime path outside owned isolation directory' }
$state = Get-Content -LiteralPath $RuntimePath -Raw | ConvertFrom-Json
$processes = @(Get-CimInstance Win32_Process)
$targets = [Collections.Generic.List[object]]::new()
foreach ($service in $Services.Split(',')) {
  if ($service -notin @('web','eve')) { throw 'Unknown service' }
  $entry = $state.$service
  if (-not $entry.pid) { continue }
  $owned = $processes | Where-Object { $_.ProcessId -eq $entry.pid } | Select-Object -First 1
  if (-not $owned) { $entry.pid = $null; continue }
  $expected = Join-Path $runtimeRoot ($service + '\.output\server\index.mjs')
  $isOwned = $owned.CommandLine.Contains($expected)
  if ($service -eq 'eve') { $isOwned = $owned.CommandLine -match 'eve[.]js start --host 127[.]0[.]0[.]1 --port 58001$' }
  if (-not $isOwned) { throw ('Recorded PID belongs to another command: ' + $entry.pid) }
  if ($entry.startedAt -and ([datetime]$owned.CreationDate).ToUniversalTime() -gt ([datetime]$entry.startedAt).ToUniversalTime().AddSeconds(10)) { throw 'Recorded PID was reused' }
  $tree = [Collections.Generic.List[object]]::new(); $tree.Add($owned)
  for ($index=0; $index -lt $tree.Count; $index++) {
    foreach ($child in @($processes | Where-Object { $_.ParentProcessId -eq $tree[$index].ProcessId })) {
      if ($child.Name -eq 'conhost.exe') { continue }
      if (-not $child.CommandLine.Contains($runtimeRoot)) { throw 'Runtime has a child outside the isolated tree' }
      $tree.Add($child)
    }
  }
  for ($index=$tree.Count-1; $index -ge 0; $index--) { $targets.Add($tree[$index]) }
  $entry.pid = $null
}
foreach ($target in $targets) { Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue }
$state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $RuntimePath -Encoding UTF8
@{ stoppedPids=@($targets | ForEach-Object { $_.ProcessId }) } | ConvertTo-Json -Compress
`);
  const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-RuntimePath', resolve(root, 'runtime.json'), '-Services', services.join(',')], { windowsHide: true });
  // Windows PowerShell writes UTF-8 with BOM; keep the fixture portable JSON.
  const runtimePath = resolve(root, 'runtime.json');
  const runtime = JSON.parse((await readFile(runtimePath, 'utf8')).replace(/^\uFEFF/, ''));
  await writeFile(runtimePath, JSON.stringify(runtime, null, 2));
  return JSON.parse(result.stdout);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await readIsolationFixture();
  const command = process.argv[2];
  if (command === 'prepare') console.log(JSON.stringify(await prepareIsolatedApp(fixture, { onAuthoredCaptured: value => console.log(JSON.stringify({ event: 'authored-captured', ...value })) }), (key, value) => key === 'files' ? value.length : value));
  else if (command === 'refresh-scaffolding') console.log(JSON.stringify(await prepareIsolatedApp(fixture, { preserveAuthored: true }), (key, value) => key === 'files' ? value.length : value));
  else if (command === 'build-eve' || command === 'build-web') console.log(JSON.stringify(await buildIsolatedApp(fixture, command.slice(6))));
  else if (command === 'start') console.log(JSON.stringify(await startIsolatedApp(fixture)));
  else if (command === 'verify') console.log(JSON.stringify(await verifyIsolatedAppArtifacts(fixture)));
  else if (command === 'stop') console.log(JSON.stringify(await stopIsolatedApp(fixture)));
  else if (command === 'status') console.log(await readFile(resolve(pathFor(fixture), 'runtime.json'), 'utf8'));
  else throw new Error('Use prepare, refresh-scaffolding, build-eve, build-web, verify, start, stop, or status.');
}
