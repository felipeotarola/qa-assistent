// Test infrastructure only. Executed by the Windows lifecycle wrapper after
// read-only app/DB gates and an explicitly coordinated stopped-app window.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, relative, sep } from 'node:path';

const node = '/opt/syna-autonomy/node/bin/node', root = '/opt/syna-autonomy/source', entry = root + '/infra/repo-runner/server.mjs';
const parent = '/var/lib/syna-autonomy/repo-faults', uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const run = (name, args) => execFileSync(name, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 }).trim();
const sleep = ms => new Promise(done => setTimeout(done, ms));
export function assertFaultLifecycleInput(input) {
  assert.ok(['start', 'restore'].includes(input.action)); assert.match(input.id, uuid);
  assert.match(input.runtime, /^autonomy-test:[a-z0-9-]+$/); assert.match(input.distro, /^SynaAutonomy-[a-f0-9]{12}$/);
  for (const name of ['runnerKey', 'internalKey', 'browserKey']) assert.ok(typeof input[name] === 'string' && input[name].length >= 32);
  if (input.action === 'restore') assert.match(input.expectedReceiptSha256, /^[a-f0-9]{64}$/);
}
export function assertFaultProcessIdentity(expected, actual) {
  assert.ok(Number.isSafeInteger(expected?.pid) && expected.pid > 1);
  assert.match(expected.startTicks, /^[0-9]+$/); assert.equal(expected.executable, node); assert.match(expected.executableSha256, /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(expected.argv) && expected.argv[0] === node);
  assert.deepEqual(actual, expected, 'Stale process identity; no signal sent');
}
export function assertTerminalOttoJobs(jobs) {
  for (const job of jobs) assert.ok(['completed', 'failed', 'cancelled', 'needs_configuration', 'interrupted'].includes(job.status), 'An Otto job is not terminal');
}
export function assertEmptyCodexScopes(scopes) {
  for (const scope of scopes) {
    assert.match(scope.name, /^syna-codex-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
    assert.equal(scope.events.match(/^populated ([01])$/m)?.[1], '0', 'Codex physical cleanup is not confirmed');
  }
}
export async function runRepoFaultLifecycle(input) {
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
assertFaultLifecycleInput(input);
const directory = parent + '/' + input.id;
assert.equal(resolve(directory), directory); await fs.mkdir(parent, { recursive: true, mode: 0o700 });
assert.equal(await fs.realpath(parent), parent); assert.equal((await fs.stat(parent)).uid, 0);
const lockPath = parent + '/lifecycle.lock', lock = await fs.open(lockPath, 'wx', 0o600);
await lock.writeFile(JSON.stringify({ pid: process.pid, id: input.id, startedAt: new Date().toISOString() }));
let receipt;
const save = async phase => {
  receipt.phase = phase; receipt.updatedAt = new Date().toISOString();
  await fs.writeFile(directory + '/lifecycle.json.tmp', JSON.stringify(receipt, null, 2), { mode: 0o600 });
  await fs.rename(directory + '/lifecycle.json.tmp', directory + '/lifecycle.json');
};
const identity = async pid => {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  try {
    const argv = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean), stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const executable = await fs.realpath(`/proc/${pid}/exe`);
    return { pid, argv, startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], executable, executableSha256: hash(await fs.readFile(executable)) };
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
};
const envFor = async pid => Object.fromEntries((await fs.readFile(`/proc/${pid}/environ`, 'utf8')).split('\0').filter(Boolean).map(pair => { const at = pair.indexOf('='); return [pair.slice(0, at), pair.slice(at + 1)]; }));
const cgroupParent = async pid => {
  const raw = (await fs.readFile(`/proc/${pid}/cgroup`, 'utf8')).split('\n').find(line => line.startsWith('0::'))?.slice(3);
  assert.ok(raw?.startsWith('/') && !raw.split('/').includes('..'));
  return resolve('/sys/fs/cgroup', '.' + raw);
};
const emptyCodexParent = async directory => {
  const child = relative('/sys/fs/cgroup', directory);
  assert.ok(child !== '..' && !child.startsWith('..' + sep) && !child.startsWith(sep));
  assert.equal(await fs.realpath(directory), directory); assert.equal((await fs.statfs(directory)).type, 0x63677270);
  const scopes = [];
  for (const name of (await fs.readdir(directory)).filter(value => /^syna-codex-[a-f0-9-]{36}$/.test(value))) {
    const path = directory + '/' + name; assert.equal(await fs.realpath(path), path); assert.equal((await fs.stat(path)).uid, 0);
    scopes.push({ name, events: await fs.readFile(path + '/cgroup.events', 'utf8') });
  }
  assertEmptyCodexScopes(scopes);
};
const socket = (port, pid) => { const rows = run('ss', ['-H', '-ltnp', 'sport = :' + port]).split('\n').filter(Boolean); assert.equal(rows.length, 1, 'Expected one owned listener'); assert.ok(rows[0].includes('127.0.0.1:' + port) && rows[0].includes('pid=' + pid + ','), 'Listener owner mismatch'); };
const free = port => assert.equal(run('ss', ['-H', '-ltnp', 'sport = :' + port]), '', 'Expected unused lifecycle port');
const appOff = async () => {
  const relay = input.callback;
  assert.match(relay.directory, /^\/var\/lib\/syna-autonomy\/callback-relay\/[a-f0-9-]{36}$/);
  assert.equal(await fs.realpath(relay.directory), relay.directory);
  assertFaultProcessIdentity({ pid: relay.pid, startTicks: relay.startTicks, executable: node, executableSha256: relay.executableSha256,
    argv: [node, relay.directory + '/linux-relay.mjs'] }, await identity(relay.pid));
  socket(58000, relay.pid);
  assert.equal(hash(await fs.readFile(relay.directory + '/relay.mjs')), relay.sourceSha256);
  assert.equal(hash(await fs.readFile(relay.directory + '/linux-relay.mjs')), relay.entrySha256);
  const response = await fetch('http://127.0.0.1:58000/api/internal/execution-capabilities', { headers: { authorization: 'Bearer ' + input.internalKey }, redirect: 'error', signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 502, 'Verified relay must observe its Windows application upstream stopped');
};
const emptyResources = async () => {
  const response = await fetch('http://127.0.0.1:58092/health', { headers: { authorization: 'Bearer ' + input.browserKey }, redirect: 'error', signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200); const browser = await response.json();
  assert.equal(browser.ready, true); assert.equal(browser.active, false); assert.equal(browser.activeSessions, 0); assert.equal(browser.startingSessions, 0);
  const names = run('docker', ['ps', '--all', '--format', '{{.Names}}']).split('\n');
  assert.ok(!names.some(name => /^qa-(repo|sandbox|preview)-/.test(name)), 'Executor resources must settle before lifecycle changes');
  const jobs = '/var/lib/syna-autonomy/runner/codex';
  for (const name of (await fs.readdir(jobs)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
    const job = JSON.parse(await fs.readFile(jobs + '/' + name, 'utf8'));
    assertTerminalOttoJobs([job]);
  }
};
const health = async port => { const response = await fetch('http://127.0.0.1:' + port + '/health', { headers: { authorization: 'Bearer ' + input.runnerKey }, signal: AbortSignal.timeout(3000) }); assert.equal(response.status, 200); const value = await response.json(); assert.ok(value.ready && value.callbackConfigured); assert.equal(value.active, 0); assert.equal(value.queued, 0); assert.equal(value.autonomousExecution?.processIsolation?.available, true); return value; };
const stopExact = async expected => {
  if (!expected) return;
  await appOff();
  const actual = await identity(expected.pid); if (!actual) return;
  assertFaultProcessIdentity(expected, actual);
  process.kill(expected.pid, 'SIGTERM');
  const until = Date.now() + 15000; while (Date.now() < until && await identity(expected.pid)) await sleep(100);
  assert.equal(await identity(expected.pid), null, 'Process stop unconfirmed; no forced kill or restore');
};
const launch = async (args, env, logName) => {
  const log = await fs.open(directory + '/' + logName, 'a', 0o600);
  const child = spawn(node, args, { cwd: root, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
  await new Promise((yes, no) => { child.once('spawn', yes); child.once('error', no); }); child.unref(); await log.close();
  const observed = await identity(child.pid); assert.ok(observed);
  assert.equal(observed.executable, node); assert.equal(observed.executableSha256, receipt.originalWorker.process.executableSha256);
  assert.deepEqual(observed.argv, [node, ...args]);
  const parent = await cgroupParent(child.pid); if (!receipt.cgroupParents.includes(parent)) receipt.cgroupParents.push(parent);
  return observed;
};
const baseEnvironment = configuration => ({ PATH: '/opt/syna-autonomy/node/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', NODE_ENV: 'test',
  REPO_RUNNER_KEY: input.runnerKey, INTERNAL_API_SECRET: input.internalKey, REPO_RUNNER_DATA: '/var/lib/syna-autonomy/runner', REPO_RUNNER_HOST: '127.0.0.1',
  CODEX_ACCESS_MODE: 'shared', WORKER_ID: input.distro, EXECUTION_ORIGINS: 'http://127.0.0.1:58000', AUTONOMY_APP_URL: 'http://127.0.0.1:58000',
  EXECUTION_IMAGE: configuration.executionImage, PREVIEW_BROWSER_IMAGE: configuration.previewImage });
const waitFor = async work => { let last; const until = Date.now() + 15000; do { try { return await work(); } catch (error) { last = error; await sleep(100); } } while (Date.now() < until); throw last; };
const verifySource = async files => { for (const file of files) { assert.ok(!file.path.startsWith('/') && !file.path.split('/').includes('..')); const path = root + '/' + file.path; assert.equal(await fs.realpath(path), path); assert.equal(hash(await fs.readFile(path)), file.sha256, 'Worker source changed'); } };
const verifyBinaries = async worker => {
  assert.equal(hash(await fs.readFile(node)), worker.process.executableSha256);
  assert.equal(await fs.realpath('/opt/qa-codex/codex'), worker.codex.path); assert.equal(hash(await fs.readFile(worker.codex.path)), worker.codex.sha256);
  for (const id of [worker.executionImage, worker.previewImage]) { assert.match(id, /^sha256:[a-f0-9]{64}$/); assert.equal(JSON.parse(run('docker', ['image', 'inspect', id]))[0].Id, id); }
};
const gatewayHealth = async () => {
  for (const [port, key, role] of [[58091, input.runnerKey, 'runner'], [58094, input.internalKey, 'callback']]) {
    socket(port, receipt.gateway.pid); const nonce = randomUUID();
    const response = await fetch('http://127.0.0.1:' + port + '/__syna_fault_health', { headers: { authorization: 'Bearer ' + key, 'x-syna-health-nonce': nonce }, redirect: 'error', signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { version: 1, kind: 'syna-repo-fault-gateway-health', role, nonce });
  }
  assert.deepEqual(await identity(receipt.gateway.pid), receipt.gateway);
  assert.equal(hash(await fs.readFile(directory + '/repo-fault-gateway.mjs')), receipt.gatewaySha256);
};
try {
  await appOff(); await emptyResources();
  if (input.action === 'start') {
    await fs.mkdir(directory, { mode: 0o700 }); assert.equal(await fs.realpath(directory), directory);
    assert.equal(hash(input.gatewaySource), input.gatewaySha256); assert.match(input.gatewaySha256, /^[a-f0-9]{64}$/);
    const expected = input.worker; assert.equal(expected.distro, input.distro); assert.equal(expected.process.executable, node);
    assert.deepEqual(await identity(expected.process.pid), expected.process); socket(58091, expected.process.pid); free(58093); free(58094);
    const oldEnv = await envFor(expected.process.pid);
    assert.ok(oldEnv.REPO_RUNNER_KEY === input.runnerKey && oldEnv.INTERNAL_API_SECRET === input.internalKey, 'Isolated key binding mismatch');
    assert.equal(oldEnv.REPO_APP_URL, 'http://127.0.0.1:58000'); assert.equal(oldEnv.AUTONOMY_APP_URL, 'http://127.0.0.1:58000');
    await verifySource(expected.files); await verifyBinaries(expected); await health(58091);
    const originalCgroupParent = await cgroupParent(expected.process.pid); await emptyCodexParent(originalCgroupParent);
    receipt = { version: 1, kind: 'syna-repo-fault-lifecycle', id: input.id, runtime: input.runtime, directory, startedAt: new Date().toISOString(),
      originalWorker: expected, cgroupParents: [originalCgroupParent], configuration: { executionImage: expected.executionImage, previewImage: expected.previewImage }, gatewaySha256: input.gatewaySha256 };
    await fs.writeFile(directory + '/repo-fault-gateway.mjs', input.gatewaySource, { flag: 'wx', mode: 0o600 });
    await save('validated'); await stopExact(expected.process); await save('original_runner_stopped'); free(58091);
    receipt.gateway = await launch([directory + '/repo-fault-gateway.mjs', directory], { PATH: '/usr/bin:/bin', HOME: '/nonexistent', REPO_RUNNER_KEY: input.runnerKey, INTERNAL_API_SECRET: input.internalKey }, 'gateway.log');
    await save('gateway_started'); await waitFor(gatewayHealth); await save('gateway_verified');
    // Callback URL is set only after both actual proxy sockets passed their own
    // authenticated local challenge and source/process identity checks.
    await appOff(); await verifySource(expected.files);
    receipt.runner = await launch([entry], { ...baseEnvironment(receipt.configuration), REPO_RUNNER_PORT: '58093', REPO_PUBLIC_URL: 'http://127.0.0.1:58091', REPO_APP_URL: 'http://127.0.0.1:58094' }, 'runner.log');
    await save('fault_runner_started'); await waitFor(async () => { socket(58093, receipt.runner.pid); await health(58093); }); await gatewayHealth();
    await fs.writeFile('/var/run/syna-autonomy/runner.pid', String(receipt.runner.pid) + '\n', { mode: 0o600 }); await save('ready');
  } else {
    assert.equal(await fs.realpath(directory), directory); receipt = JSON.parse(await fs.readFile(directory + '/lifecycle.json', 'utf8'));
    assert.equal(hash(JSON.stringify(receipt)), input.expectedReceiptSha256, 'Lifecycle receipt changed; inspect before restoring');
    assert.equal(receipt.id, input.id); assert.equal(receipt.runtime, input.runtime); assert.equal(receipt.directory, directory);
    assert.ok(receipt.phase !== 'restored', 'Already restored; do not create a second direct runner');
    await verifySource(receipt.originalWorker.files); await verifyBinaries(receipt.originalWorker);
    assert.ok(Array.isArray(receipt.cgroupParents) && receipt.cgroupParents.length > 0);
    for (const directory of receipt.cgroupParents) await emptyCodexParent(directory);
    if (receipt.runner && await identity(receipt.runner.pid)) { socket(58093, receipt.runner.pid); await health(58093); }
    await stopExact(receipt.runner); await save('fault_runner_stopped'); await stopExact(receipt.gateway); await save('gateway_stopped');
    free(58091); free(58093); free(58094); await appOff();
    receipt.restoredRunner = await launch([entry], { ...baseEnvironment(receipt.configuration), REPO_RUNNER_PORT: '58091', REPO_PUBLIC_URL: 'http://127.0.0.1:58091', REPO_APP_URL: 'http://127.0.0.1:58000' }, 'restored-runner.log');
    await save('restoring_direct'); await waitFor(async () => { socket(58091, receipt.restoredRunner.pid); await health(58091); });
    await fs.writeFile('/var/run/syna-autonomy/runner.pid', String(receipt.restoredRunner.pid) + '\n', { mode: 0o600 }); await save('restored');
  }
  console.log(JSON.stringify(receipt));
} catch (error) {
  if (receipt) { receipt.failure = { at: new Date().toISOString(), name: error.name, message: String(error.message).replaceAll(input.runnerKey, '[redacted]').replaceAll(input.internalKey, '[redacted]').replaceAll(input.browserKey, '[redacted]').slice(0, 500) }; await save(receipt.phase).catch(() => {}); }
  console.error(JSON.stringify({ failed: true, directory, phase: receipt?.phase ?? 'preflight', message: 'Lifecycle transition failed; inspect its private receipt. Never blindly repeat start.' })); process.exitCode = 1;
} finally { await lock.close(); await fs.unlink(lockPath); }
}
