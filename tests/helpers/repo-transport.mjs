// Explicit test-only transport provisioning. --plan has local filesystem/Git
// effects only; --audit is read-only; --provision is a separately authorized
// WSL mutation and refuses a running repository worker or existing resources.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { repoHash, validateRepoManifest } from './repo-benchmark-contract.mjs';
import { validateTransportPlan } from './repo-transport-linux.mjs';
import { readIsolationFixture } from './autonomy-isolation.mjs';
import { observeRepoWorker } from './repo-worker-integrity.mjs';

const execute = promisify(execFile), root = resolve('.data/autonomy-isolation/repo-fixtures');
const serverFile = resolve('tests/fixtures/repo-benchmark/git-server.mjs'), provisionerFile = resolve('tests/helpers/repo-transport-linux.mjs');
const platform = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:path|pathext|systemroot|windir|comspec|temp|tmp)$/i.test(key)));

async function fixture() {
  const data = JSON.parse(await readFile('.data/autonomy-isolation/linux/fixture.json', 'utf8'));
  assert.match(data.name, /^SynaAutonomy-[a-f0-9]{12}$/); assert.equal(resolve(data.path), resolve('.data/autonomy-isolation/linux', data.name));
  return data;
}

async function ownedFile(path) {
  const file = resolve(path); assert.ok(file.startsWith(root + sep));
  assert.equal(await realpath(file), file, 'Fixture aliases are not accepted');
  return file;
}

async function manifestAt(path) {
  const file = await ownedFile(path), bytes = await readFile(file), manifest = validateRepoManifest(JSON.parse(bytes));
  assert.equal(manifest.oracleSha256, repoHash(await readFile('tests/fixtures/repo-benchmark/oracle.json')));
  return { file, bytes, manifest };
}

export async function createTransportPlan(manifestPath) {
  const { file, bytes, manifest } = await manifestAt(manifestPath), linux = await fixture();
  assert.equal(manifest.transport.kind, 'unbound');
  const id = randomUUID(), output = resolve(dirname(file), 'transport-' + id); await mkdir(output);
  await writeFile(resolve(output, 'empty-gitconfig'), '', { flag: 'wx' });
  const env = { ...platform, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: resolve(output, 'empty-gitconfig'), GIT_TERMINAL_PROMPT: '0' };
  const git = async (cwd, args) => (await execute('git', ['-c', 'core.hooksPath=' + resolve(output, 'absent-hooks'), ...args], { env, cwd, windowsHide: true, timeout: 15000, encoding: 'utf8' })).stdout.trim();
  const repositories = [];
  for (const repo of manifest.repositories) {
    assert.equal(repo.url, `https://github.com/syna-autonomy-fixture/${repo.fixture}`);
    const source = await ownedFile(repo.localPath); assert.equal(dirname(source), dirname(file));
    assert.equal(await git(source, ['rev-parse', 'HEAD']), repo.commit); assert.equal(await git(source, ['rev-parse', 'HEAD^{tree}']), repo.tree);
    assert.equal(await git(source, ['status', '--porcelain']), '');
    assert.equal(await git(source, ['config', '--local', '--get', 'core.repositoryformatversion']), '0');
    const bundle = resolve(output, repo.fixture + '.bundle');
    await git(source, ['bundle', 'create', bundle, 'HEAD']);
    const bundleBytes = await readFile(bundle); assert.ok(bundleBytes.length <= 512 * 1024);
    repositories.push({ name: repo.fixture, url: repo.url, commit: repo.commit, tree: repo.tree, transportUrl: `http://198.51.100.10:18080/${repo.fixture}`, bundleSha256: repoHash(bundleBytes) });
  }
  const server = await readFile(serverFile), provisioner = await readFile(provisionerFile);
  const plan = validateTransportPlan({ version: 1, kind: 'syna-repo-transport-plan', id, distro: linux.name, root: '/var/lib/syna-autonomy/repo-fixtures/' + id,
    host: '198.51.100.10', port: 18080, baseImage: linux.images.runner, baseTag: '127.0.0.1:9/syna-repo-fixture-base:' + id, imageTag: 'syna-repo-fixture:' + id, repositories,
    manifestSha256: repoHash(bytes), serverSha256: repoHash(server), provisionerSha256: repoHash(provisioner), oracleIncluded: false, productionDnsChanged: false });
  await writeFile(resolve(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  await writeFile(resolve(output, 'git-server.mjs'), server, { flag: 'wx' }); await writeFile(resolve(output, 'repo-transport-linux.mjs'), provisioner, { flag: 'wx' });
  return { path: resolve(output, 'plan.json'), planSha256: repoHash(JSON.stringify(plan)), baseImage: plan.baseImage, runnable: false, mutationPerformed: 'Local Git bundles and transport plan only' };
}

export async function runTransportPlan(action, planPath, confirmation) {
  assert.ok(['audit', 'provision', 'verify'].includes(action));
  const file = await ownedFile(planPath), directory = dirname(file), plan = validateTransportPlan(JSON.parse(await readFile(file, 'utf8')));
  const linux = await fixture(); assert.equal(linux.name, plan.distro);
  const source = await readFile(resolve(directory, 'repo-transport-linux.mjs')); assert.equal(repoHash(source), plan.provisionerSha256);
  assert.equal(repoHash(await readFile(provisionerFile)), plan.provisionerSha256, 'Authored provisioner changed: freeze a new plan');
  const server = await readFile(resolve(directory, 'git-server.mjs')); assert.equal(repoHash(server), plan.serverSha256);
  assert.equal(repoHash(await readFile(serverFile)), plan.serverSha256, 'Authored server changed: freeze a new plan');
  assert.equal(repoHash(await readFile(resolve(directory, '..', 'manifest.json'))), plan.manifestSha256);
  if (action === 'provision') assert.equal(confirmation, repoHash(JSON.stringify(plan)), 'Explicit --confirm-plan=<sha256> is required after coordinating the mutation window');
  // Merely auditing must not start a stopped WSL distribution.
  const running = (await execute('wsl.exe', ['--list', '--running', '--quiet'], { env: platform, windowsHide: true, encoding: 'utf16le', timeout: 10000 })).stdout.replace(/\0/g, '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  assert.ok(running.includes(plan.distro), 'Owned WSL is not already running; this script does not start it');
  const payload = { action, plan, ...(action === 'verify' ? { receipt: JSON.parse(await readFile(resolve(directory, 'fetch-receipt.json'), 'utf8')) } : {}), ...(action === 'provision' ? { confirmPlanSha256: confirmation, server: server.toString('base64'), bundles: Object.fromEntries(await Promise.all(plan.repositories.map(async repo => {
    const bytes = await readFile(resolve(directory, repo.name + '.bundle')); assert.equal(repoHash(bytes), repo.bundleSha256); return [repo.name, bytes.toString('base64')];
  }))) } : {}) };
  const bootstrap = `try{const {runRepoTransport}=await import('data:text/javascript;base64,${source.toString('base64')}');let raw='';for await(const b of process.stdin){raw+=b; if(raw.length>3000000)throw Error('Input exceeds bound')}console.log(JSON.stringify(await runRepoTransport(JSON.parse(raw))));}catch(error){console.error(error.message);process.exitCode=1}`;
  const result = await new Promise((yes, no) => {
    const child = spawn('wsl.exe', ['-d', plan.distro, '-u', 'root', '--exec', '/opt/syna-autonomy/node/bin/node', '--input-type=module', '-e', bootstrap], { env: platform, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0;
    const timer = setTimeout(() => { child.kill(); no(new Error('Transport acknowledgement lost; do not replay provisioning, inspect the owned lock/directory')); }, action === 'provision' ? 300000 : 45000);
    child.on('error', error => { clearTimeout(timer); no(error); });
    child.stdout.on('data', bytes => { size += bytes.length; if (size > 4 * 1024 * 1024) { child.kill(); no(new Error('Receipt exceeds bound')); } else stdout += bytes; });
    child.stderr.on('data', bytes => { if (stderr.length < 16384) stderr += bytes; });
    child.on('close', code => { clearTimeout(timer); if (code !== 0) no(new Error(`Transport ${action} denied: ${stderr}`)); else { try { yes(JSON.parse(stdout)); } catch (error) { no(error); } } });
    child.stdin.on('error', error => { clearTimeout(timer); no(error); }); child.stdin.end(JSON.stringify(payload));
  });
  if (action === 'provision') {
    assert.equal(result.kind, 'syna-repository-fetch-receipt'); assert.equal(result.verifiedFetch, true); assert.equal(result.oracleServed, false);
    assert.equal(result.planSha256, repoHash(JSON.stringify(plan)));
    assert.deepEqual(result.repositories, plan.repositories.map(({ url, commit, tree }) => ({ url, commit, tree, shallow: true })));
    await writeFile(resolve(directory, 'fetch-receipt.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  }
  return result;
}

export async function bindTransport(planPath) {
  const file = await ownedFile(planPath), directory = dirname(file), manifestPath = resolve(directory, '..', 'manifest.json');
  const { manifest } = await manifestAt(manifestPath), plan = validateTransportPlan(JSON.parse(await readFile(file, 'utf8')));
  const current = await runTransportPlan('verify', file), fixture = await readIsolationFixture(), worker = await observeRepoWorker(fixture);
  assert.equal(worker.executionImage, current.executionImage, 'Parent must explicitly select the verified private execution image and restart the idle worker first');
  const workerReceiptSha256 = repoHash(JSON.stringify(worker)), transport = { kind: 'simulated-github-transport', runtime: fixture.runtimeScope, workerReceiptSha256,
    repositories: manifest.repositories.map(({ url, commit, tree }) => ({ url, commit, tree })), verifiedFetch: true, oracleServed: false, productionDnsChanged: false,
    planPath: relative(dirname(manifestPath), file).split(sep).join('/'), fetchReceiptSha256: repoHash(await readFile(resolve(directory, 'fetch-receipt.json'))), verifiedTransport: current };
  assert.deepEqual(transport.repositories, plan.repositories.map(({ url, commit, tree }) => ({ url, commit, tree })));
  const bytes = Buffer.from(JSON.stringify(transport, null, 2) + '\n');
  const bound = { ...manifest, runtime: fixture.runtimeScope, workerReceiptSha256, transport: { kind: transport.kind, isolatedRuntime: fixture.runtimeScope,
    scope: 'exact-fixture-repositories-only', productionDnsChanged: false, receiptSha256: repoHash(bytes) } };
  validateRepoManifest(bound, { runnable: true });
  await writeFile(resolve(dirname(manifestPath), 'transport.json'), bytes, { flag: 'wx' });
  await writeFile(resolve(dirname(manifestPath), 'bound-manifest.json'), JSON.stringify(bound, null, 2) + '\n', { flag: 'wx' });
  return { path: resolve(dirname(manifestPath), 'bound-manifest.json'), runtime: fixture.runtimeScope, workerReceiptSha256, executionImage: current.executionImage, modelCalls: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), modes = args.filter(arg => ['--plan', '--audit', '--provision', '--bind'].includes(arg)); assert.equal(modes.length, 1);
  const option = name => args.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1);
  assert.ok(args.every(arg => modes.includes(arg) || /^(?:--manifest|--transport-plan|--confirm-plan)=/.test(arg)), 'Unknown option');
  const result = modes[0] === '--plan' ? await createTransportPlan(option('--manifest')) : modes[0] === '--bind' ? await bindTransport(option('--transport-plan')) : await runTransportPlan(modes[0].slice(2), option('--transport-plan'), option('--confirm-plan'));
  console.log(JSON.stringify(result));
}
