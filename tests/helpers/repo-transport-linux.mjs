// Separate test provisioning, never imported by product/runtime modules.
// Importing this file is pure. runRepoTransport is invoked only by the guarded
// Windows wrapper; audit reads state, provision has explicit fenced effects.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex');
const names = ['library', 'keyless', 'configured'], address = '198.51.100.10', port = 18080;
const cleanEnv = { PATH: '/opt/syna-autonomy/node/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/nonexistent', DOCKER_HOST: 'unix:///var/run/docker.sock', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const command = async (file, args, options = {}) => (await run(file, args, { env: cleanEnv, timeout: 20000, maxBuffer: 4 * 1024 * 1024, ...options })).stdout.trim();
const exists = async file => { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

export function validateTransportPlan(plan) {
  assert.equal(plan?.version, 1); assert.equal(plan.kind, 'syna-repo-transport-plan');
  assert.match(plan.id, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  assert.match(plan.distro, /^SynaAutonomy-[a-f0-9]{12}$/);
  assert.equal(plan.root, `/var/lib/syna-autonomy/repo-fixtures/${plan.id}`);
  assert.equal(plan.host, address); assert.equal(plan.port, port);
  assert.match(plan.baseImage, /^sha256:[a-f0-9]{64}$/); assert.equal(plan.imageTag, `syna-repo-fixture:${plan.id}`);
  assert.equal(plan.baseTag, `127.0.0.1:9/syna-repo-fixture-base:${plan.id}`);
  for (const field of ['manifestSha256', 'serverSha256', 'provisionerSha256']) assert.match(plan[field], /^[a-f0-9]{64}$/);
  assert.equal(plan.oracleIncluded, false); assert.equal(plan.productionDnsChanged, false);
  assert.deepEqual(plan.repositories?.map(repo => repo.name), names);
  for (const repo of plan.repositories) {
    assert.equal(repo.url, `https://github.com/syna-autonomy-fixture/${repo.name}`);
    assert.equal(repo.transportUrl, `http://${address}:${port}/${repo.name}`);
    assert.match(repo.commit, /^[a-f0-9]{40}$/); assert.match(repo.tree, /^[a-f0-9]{40}$/); assert.match(repo.bundleSha256, /^[a-f0-9]{64}$/);
  }
  return plan;
}

export function transportDockerfile(plan) {
  validateTransportPlan(plan);
  const mapping = plan.repositories.map(repo => `git config --system url.${repo.transportUrl}.insteadOf ${repo.url}`).join(' && ');
  return `FROM ${plan.baseTag}\nUSER root\nRUN if test -f /etc/gitconfig; then git config --system --list >/dev/null && test -z "$(git config --system --get-regexp '^url\\..*\\.insteadof$' || true)"; fi && ${mapping}\nUSER 1000:1000\nLABEL syna.isolation="${plan.distro}" syna.repo.fixture="${plan.id}"\n`;
}

export function assertDerivedTransportImage(plan, base, derived) {
  validateTransportPlan(plan); assert.equal(base.Id, plan.baseImage);
  assert.match(derived.Id, /^sha256:[a-f0-9]{64}$/); assert.equal(derived.Os, base.Os); assert.equal(derived.Architecture, base.Architecture);
  assert.ok(Array.isArray(base.RootFS?.Layers) && base.RootFS.Layers.length > 0);
  assert.ok(Array.isArray(derived.RootFS?.Layers) && derived.RootFS.Layers.length > base.RootFS.Layers.length);
  for (const layer of [...base.RootFS.Layers, ...derived.RootFS.Layers]) assert.match(layer, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(derived.RootFS.Layers.slice(0, base.RootFS.Layers.length), base.RootFS.Layers, 'Derived image must retain the exact inspected base layers');
  assert.equal(derived.Config.User, '1000:1000'); assert.equal(derived.Config.Labels['syna.repo.fixture'], plan.id); assert.equal(derived.Config.Labels['syna.isolation'], plan.distro);
}

export function assertTransportQuiescent(state, plan) {
  validateTransportPlan(plan);
  assert.equal(state.dockerRootDir, '/var/lib/syna-autonomy/docker');
  assert.ok(state.daemonArgs.includes('--data-root') && state.daemonArgs[state.daemonArgs.indexOf('--data-root') + 1] === state.dockerRootDir);
  assert.ok(state.daemonArgs.includes('--exec-root') && state.daemonArgs[state.daemonArgs.indexOf('--exec-root') + 1] === '/var/run/syna-autonomy/docker');
  assert.ok(state.daemonArgs.includes('--cgroup-parent') && state.daemonArgs[state.daemonArgs.indexOf('--cgroup-parent') + 1] === '/' + plan.distro.toLowerCase().replace('synaautonomy-', 'syna-autonomy-'));
  assert.deepEqual(state.runnerProcesses, [], 'Stop the isolated repo-runner before provisioning; this script never stops it');
  assert.deepEqual(state.executorProcesses, [], 'An executor may still own a job');
  assert.deepEqual(state.ephemeralContainers, [], 'No repository, sandbox or preview container may exist');
  assert.equal(state.runnerListener, '', 'Runner port is occupied');
  assert.equal(state.transportListener, '', 'Transport port is occupied');
  assert.equal(state.addressPresent, false, 'Transport address already exists; never adopt or replace it');
  assert.equal(state.rootExists, false, 'Transport output already exists; partial provision must be audited, not replayed');
  assert.equal(state.imageExists, false, 'Fixture image tag already exists');
  assert.equal(state.baseImage, plan.baseImage); assert.ok(['', '0', 'root', 'node'].includes(state.baseUser));
  assert.deepEqual(state.repoNetwork.subnets, ['172.30.0.0/24']); assert.equal(state.repoNetwork.ipv6, false);
  assert.equal(state.repoNetwork.name, 'qa-repo-net'); assert.equal(state.lockExists, false);
}

async function processes() {
  const rows = [];
  for (const pid of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try { rows.push({ pid: Number(pid), argv: (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean) }); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; /* A process can exit during the census. */ }
  }
  return rows;
}

async function identity(pid) {
  const prefix = `/proc/${pid}`, raw = await fs.readFile(prefix + '/stat', 'utf8');
  return { pid, startTicks: raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19], argv: (await fs.readFile(prefix + '/cmdline', 'utf8')).split('\0').filter(Boolean), executable: await fs.realpath(prefix + '/exe') };
}

async function audit(plan, ownLock = false) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  assert.equal(await fs.realpath('/var/lib/syna-autonomy'), '/var/lib/syna-autonomy');
  const daemonPid = (await fs.readFile('/var/run/syna-autonomy/dockerd.pid', 'utf8')).trim(); assert.match(daemonPid, /^\d+$/);
  const daemon = await identity(Number(daemonPid)); assert.equal(daemon.executable, await fs.realpath('/usr/bin/dockerd'));
  assert.ok(daemon.argv[0] === 'dockerd' || daemon.argv[0].endsWith('/dockerd'));
  const info = JSON.parse(await command('docker', ['info', '--format', '{{json .}}']));
  const containers = (await command('docker', ['ps', '--all', '--format', '{{json .}}'])).split('\n').filter(Boolean).map(row => JSON.parse(row));
  const rows = await processes(), images = (await command('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'])).split('\n');
  const base = JSON.parse(await command('docker', ['image', 'inspect', plan.baseImage]))[0];
  const network = JSON.parse(await command('docker', ['network', 'inspect', 'qa-repo-net']))[0];
  const addresses = JSON.parse(await command('ip', ['-j', '-4', 'address', 'show']));
  const state = { dockerRootDir: info.DockerRootDir, daemonArgs: daemon.argv,
    runnerProcesses: rows.filter(row => row.argv.some(value => value.endsWith('/infra/repo-runner/server.mjs'))).map(row => row.pid),
    executorProcesses: rows.filter(row => row.argv.some(value => value === '/opt/qa-codex/codex' || value.endsWith('/infra/codex-worker/worker.mjs'))).map(row => row.pid),
    ephemeralContainers: containers.filter(row => /^qa-(?:repo|sandbox|preview)-/.test(row.Names) || /^syna-repo-fetch-/.test(row.Names)).map(row => row.Names),
    runnerListener: await command('ss', ['-H', '-ltnp', 'sport = :58091']), transportListener: await command('ss', ['-H', '-ltnp', `sport = :${port}`]),
    addressPresent: addresses.some(row => row.addr_info.some(info => info.local === address)), rootExists: await exists(plan.root), imageExists: images.includes(plan.imageTag) || images.includes(plan.baseTag),
    baseImage: base.Id, baseUser: base.Config.User, repoNetwork: { name: network.Name, subnets: network.IPAM.Config.map(row => row.Subnet), ipv6: network.EnableIPv6 },
    lockExists: !ownLock && await exists('/var/run/syna-autonomy/repo-transport.lock') };
  assertTransportQuiescent(state, plan);
  return { ...state, daemon, observedAt: new Date().toISOString() };
}

async function readOnlyTree(root) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink()); const full = root + '/' + entry.name;
    if (entry.isDirectory()) await readOnlyTree(full); else { assert.ok(entry.isFile()); await fs.chmod(full, 0o444); }
  }
  await fs.chmod(root, 0o555);
}

async function verifyTransport(plan, receipt) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  assert.equal(await fs.realpath(plan.root), plan.root);
  assert.deepEqual(JSON.parse(await fs.readFile(plan.root + '/plan.json', 'utf8')), plan);
  assert.deepEqual(JSON.parse(await fs.readFile(plan.root + '/fetch-receipt.json', 'utf8')), receipt);
  assert.equal(receipt.kind, 'syna-repository-fetch-receipt'); assert.equal(receipt.planSha256, hash(JSON.stringify(plan)));
  assert.equal(receipt.verifiedFetch, true); assert.equal(receipt.oracleServed, false);
  assert.equal(hash(await fs.readFile(plan.root + '/git-server.mjs')), plan.serverSha256);
  assert.deepEqual(await identity(receipt.serverProcess.pid), receipt.serverProcess);
  const sockets = (await command('ss', ['-H', '-ltnp', `sport = :${port}`])).split('\n');
  assert.equal(sockets.length, 1); assert.ok(sockets[0].includes(`${address}:${port}`) && sockets[0].includes(`pid=${receipt.serverProcess.pid},`));
  const image = JSON.parse(await command('docker', ['image', 'inspect', receipt.executionImage]))[0];
  const base = JSON.parse(await command('docker', ['image', 'inspect', plan.baseTag]))[0];
  assert.equal(image.Id, receipt.executionImage); assertDerivedTransportImage(plan, base, image);
  assert.equal(receipt.baseTag, plan.baseTag); assert.deepEqual(receipt.baseLayers, base.RootFS.Layers); assert.deepEqual(receipt.executionLayers, image.RootFS.Layers);
  assert.equal(hash(await fs.readFile(plan.root + '/build/Dockerfile')), hash(transportDockerfile(plan)));
  assert.deepEqual(receipt.repositories, plan.repositories.map(({ url, commit, tree }) => ({ url, commit, tree, shallow: true })));
  for (const repo of plan.repositories) {
    const bare = plan.root + `/repos/${repo.name}.git`; assert.equal(await fs.realpath(bare), bare);
    assert.equal(await command('git', ['--git-dir=' + bare, 'rev-parse', 'HEAD']), repo.commit);
    assert.equal(await command('git', ['--git-dir=' + bare, 'rev-parse', 'HEAD^{tree}']), repo.tree);
  }
  return { planSha256: receipt.planSha256, executionImage: receipt.executionImage, serverProcess: receipt.serverProcess, serverSha256: plan.serverSha256, repositories: receipt.repositories };
}

export async function runRepoTransport(input) {
  const plan = validateTransportPlan(input.plan);
  assert.ok(['audit', 'provision', 'verify'].includes(input.action));
  if (input.action === 'audit') return { action: 'audit', planSha256: hash(JSON.stringify(plan)), state: await audit(plan), mutated: false };
  if (input.action === 'verify') return await verifyTransport(plan, input.receipt);
  assert.equal(input.confirmPlanSha256, hash(JSON.stringify(plan)), 'Provision requires the exact frozen plan hash');
  const server = Buffer.from(input.server || '', 'base64'); assert.equal(hash(server), plan.serverSha256);
  assert.equal(Object.keys(input.bundles || {}).length, 3);
  for (const repo of plan.repositories) assert.equal(hash(Buffer.from(input.bundles[repo.name] || '', 'base64')), repo.bundleSha256);
  await audit(plan);
  const lockPath = '/var/run/syna-autonomy/repo-transport.lock', lock = await fs.open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ id: plan.id, pid: process.pid, planSha256: hash(JSON.stringify(plan)), createdAt: new Date().toISOString() }));
  let effectsStarted = false;
  try {
    const before = await audit(plan, true);
    const parent = '/var/lib/syna-autonomy/repo-fixtures'; await fs.mkdir(parent, { recursive: true }); assert.equal(await fs.realpath(parent), parent);
    await fs.mkdir(plan.root, { mode: 0o755 }); effectsStarted = true;
    for (const sub of ['repos', 'input', 'build']) await fs.mkdir(plan.root + '/' + sub, { mode: sub === 'input' ? 0o700 : 0o755 });
    await fs.writeFile(plan.root + '/plan.json', JSON.stringify(plan, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.writeFile(plan.root + '/git-server.mjs', server, { mode: 0o444, flag: 'wx' });
    for (const repo of plan.repositories) {
      const bundle = plan.root + `/input/${repo.name}.bundle`, bare = plan.root + `/repos/${repo.name}.git`;
      await fs.writeFile(bundle, Buffer.from(input.bundles[repo.name], 'base64'), { mode: 0o400, flag: 'wx' });
      await command('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--bare', '--', bundle, bare]);
      assert.equal(await command('git', ['--git-dir=' + bare, 'rev-parse', 'HEAD']), repo.commit);
      assert.equal(await command('git', ['--git-dir=' + bare, 'rev-parse', 'HEAD^{tree}']), repo.tree);
      await command('git', ['--git-dir=' + bare, 'fsck', '--strict']);
      await command('git', ['--git-dir=' + bare, 'config', 'http.receivepack', 'false']);
      await command('git', ['--git-dir=' + bare, 'config', 'core.hooksPath', '/dev/null']);
      await readOnlyTree(bare);
    }
    await fs.chmod(plan.root + '/repos', 0o555);
    await fs.writeFile(plan.root + '/build/Dockerfile', transportDockerfile(plan), { mode: 0o444, flag: 'wx' });
    // Docker FROM sha256:<local-image-id> is not a local-ID reference: Docker
    // treats it as a repository named "sha256". Use an owned unique tag,
    // inspect it immediately, and prove the resulting image's layer ancestry.
    const originalBase = JSON.parse(await command('docker', ['image', 'inspect', plan.baseImage]))[0];
    assert.equal(originalBase.Id, plan.baseImage);
    await command('docker', ['image', 'tag', plan.baseImage, plan.baseTag]);
    assert.equal(JSON.parse(await command('docker', ['image', 'inspect', plan.baseTag]))[0].Id, plan.baseImage);
    await command('docker', ['build', '--pull=false', '--network=none', '--tag', plan.imageTag, plan.root + '/build'], { timeout: 180000 });
    const image = JSON.parse(await command('docker', ['image', 'inspect', plan.imageTag]))[0];
    const base = JSON.parse(await command('docker', ['image', 'inspect', plan.baseTag]))[0];
    assert.equal(base.Id, originalBase.Id); assertDerivedTransportImage(plan, base, image);
    // The product runner remains stopped throughout the mutation window.
    assert.ok(!(await processes()).some(row => row.argv.some(value => value.endsWith('/infra/repo-runner/server.mjs'))));
    await command('ip', ['address', 'add', address + '/32', 'dev', 'lo']);
    const log = await fs.open(plan.root + '/transport.log', 'wx', 0o600);
    const child = spawn('/opt/syna-autonomy/node/bin/node', [plan.root + '/git-server.mjs', plan.root + '/repos'], { cwd: plan.root, uid: 65534, gid: 65534, detached: true, stdio: ['ignore', log.fd, log.fd], env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } });
    await new Promise((yes, no) => { child.once('spawn', yes); child.once('error', no); }); child.unref(); await log.close();
    const serverProcess = await identity(child.pid); await fs.writeFile(plan.root + '/server-process.json', JSON.stringify(serverProcess), { mode: 0o600, flag: 'wx' });
    assert.deepEqual(serverProcess.argv, ['/opt/syna-autonomy/node/bin/node', plan.root + '/git-server.mjs', plan.root + '/repos']);
    const deadline = Date.now() + 5000;
    while (true) { const sockets = await command('ss', ['-H', '-ltnp', `sport = :${port}`]); if (sockets.includes(`${address}:${port}`) && sockets.includes(`pid=${child.pid},`)) break; assert.ok(Date.now() < deadline, 'Fixture server did not become ready'); await new Promise(yes => setTimeout(yes, 50)); }
    const fetched = [];
    for (const repo of plan.repositories) {
      // Only the image's real Git URL rewrite can make this request succeed.
      // No host checkout, oracle, credentials or Git config is mounted.
      const script = 'test "$(git ls-remote --get-url "$1")" = "$3"; git init -q /tmp/check; git -C /tmp/check remote add origin "$1"; git -C /tmp/check -c http.followRedirects=false fetch --depth=1 origin "$2"; git -C /tmp/check rev-parse FETCH_HEAD; git -C /tmp/check rev-parse "FETCH_HEAD^{tree}"; test "$(git -C /tmp/check rev-parse --is-shallow-repository)" = true';
      const actual = await command('docker', ['run', '--rm', '--name', `syna-repo-fetch-${plan.id}-${repo.name}`, '--label', `syna.isolation=${plan.distro}`, '--label', `syna.repo.fixture=${plan.id}`, '--runtime=runsc', '--network=qa-repo-net', '--user=1000:1000', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m,uid=1000,gid=1000', '--memory=256m', '--memory-swap=256m', '--cpus=0.5', '--pids-limit=64', '--cap-drop=ALL', '--security-opt=no-new-privileges', '-e', 'GIT_TERMINAL_PROMPT=0', '--entrypoint', '/bin/sh', image.Id, '-ceu', script, '--', repo.url, repo.commit, repo.transportUrl], { timeout: 60000 });
      const lines = actual.split('\n'); assert.deepEqual(lines, [repo.commit, repo.tree]);
      fetched.push({ url: repo.url, commit: lines[0], tree: lines[1], shallow: true });
    }
    assert.deepEqual(await identity(child.pid), serverProcess);
    const receipt = { version: 1, kind: 'syna-repository-fetch-receipt', planSha256: hash(JSON.stringify(plan)), distro: plan.distro, baseImage: plan.baseImage, baseTag: plan.baseTag, baseLayers: base.RootFS.Layers, executionLayers: image.RootFS.Layers, executionImage: image.Id,
      serverSha256: plan.serverSha256, serverProcess, before, repositories: fetched, verifiedFetch: true, oracleServed: false, productionDnsChanged: false, verifiedAt: new Date().toISOString() };
    await fs.writeFile(plan.root + '/fetch-receipt.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await lock.close(); await fs.unlink(lockPath);
    return receipt;
  } catch (error) {
    await lock.close();
    if (!effectsStarted) await fs.unlink(lockPath);
    // Once effects began, preserve the lock and exact directory for inspection.
    // No blind retry, adopting resources, broad deletion or killing other jobs.
    throw new Error(`Fixture provisioning stopped${effectsStarted ? '; owned partial resources and lock retained' : ''}: ${error.message}`, { cause: error });
  }
}
