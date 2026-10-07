// Explicit local test lifecycle. This is never imported by the application or
// acceptance harness and never starts/stops services without a CLI action.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { readIsolationFixture } from './autonomy-isolation.mjs';
import { requireWindowsRuntimeStopped } from './isolated-runtime-identity.mjs';
import { repoHash, validateRepoManifest } from './repo-benchmark-contract.mjs';
import { observeRepoWorker, observeRepoResources } from './repo-worker-integrity.mjs';
import { runTransportPlan } from './repo-transport.mjs';
import { verifyRepoCallbackTransport } from './repo-callback-integrity.mjs';

const fixtureRoot = resolve('.data/autonomy-isolation/repo-fixtures'), lifecycleRoot = resolve('.data/autonomy-isolation/linux/fault-runtime');
const platform = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(path|pathext|systemroot|windir|comspec|temp|tmp)$/i.test(name)));
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export function parseFaultLifecycleArguments(args) {
  const actions = args.filter(x => ['--validate', '--start', '--restore'].includes(x));
  assert.equal(actions.length, 1, 'Choose validate or one explicit lifecycle action');
  const values = {};
  for (const arg of args.filter(x => !actions.includes(x))) {
    const at = arg.indexOf('='); assert.ok(at > 0); const key = arg.slice(0, at);
    assert.ok(['--manifest', '--receipt', '--window'].includes(key) && !Object.hasOwn(values, key)); values[key] = arg.slice(at + 1);
  }
  const action = actions[0].slice(2);
  if (action === 'restore') { assert.ok(values['--receipt']); assert.ok(!values['--manifest'] && !values['--window']); }
  else { assert.ok(values['--manifest']); assert.ok(!values['--receipt']); }
  if (action === 'start') assert.match(values['--window'], uuid, 'An explicit coordinated window UUID is required');
  if (action === 'validate') assert.ok(!values['--window'], 'Validation does not create a lifecycle window');
  return { action, manifest: values['--manifest'], receipt: values['--receipt'], id: values['--window'] };
}
async function physicalFile(root, value) {
  const file = resolve(value); assert.ok(file.startsWith(root + sep)); assert.equal(await realpath(file), file); return file;
}
async function databaseIdle(fixture) {
  const sql = postgres(fixture.databaseUrl, { max: 1, prepare: false, connection: { TimeZone: 'UTC', default_transaction_read_only: 'on' } });
  try {
    const [counts] = await sql.begin('read only', tx => tx`select
      (select count(*) from pat_missions where runtime=${fixture.runtimeScope} and controller_version=1 and lifecycle <> 'closed')::int as missions,
      (select count(*) from pat_mission_reports r join pat_missions m on m.id=r.mission_id where m.runtime=${fixture.runtimeScope} and r.status in ('queued','running'))::int as reports,
      (select count(*) from pat_result_assessments where runtime=${fixture.runtimeScope} and status in ('queued','running'))::int as reviews,
      (select count(*) from pat_mission_resource_claims where runtime=${fixture.runtimeScope})::int as claims`);
    assert.ok(Object.values(counts).every(x => x === 0), 'Original isolated missions/queues/claims must settle before switching workers');
  } finally { await sql.end(); }
}
async function stoppedApplication(fixture) {
  assert.equal(resolve(fixture.app.root), resolve('.data/autonomy-isolation', 'application-' + fixture.runtimeScope.split(':')[1]));
  const runtime = JSON.parse(await readFile(resolve(fixture.app.root, 'runtime.json'), 'utf8'));
  await requireWindowsRuntimeStopped(fixture.app.root, runtime, ['web', 'eve']);
}
async function runningDistro(name) {
  const running = (await promisify(execFile)('wsl.exe', ['--list', '--running', '--quiet'], { env: platform, windowsHide: true, encoding: 'utf16le', timeout: 10000 })).stdout.replace(/\0/g, '').split(/\r?\n/).map(x => x.trim());
  assert.ok(running.includes(name), 'Lifecycle must not implicitly start WSL');
}
export async function manageRepoFaultLifecycle(options) {
  assert.ok(['validate', 'start', 'restore'].includes(options.action), 'Explicit lifecycle action required');
  const fixture = await readIsolationFixture(); assert.equal(fixture.runner.url, 'http://127.0.0.1:58091');
  const linux = JSON.parse(await readFile('.data/autonomy-isolation/linux/fixture.json', 'utf8'));
  assert.match(linux.name, /^SynaAutonomy-[a-f0-9]{12}$/); assert.equal(resolve(linux.path), resolve('.data/autonomy-isolation/linux', linux.name));
  let id = options.id, worker, manifestPath, before;
  if (options.action !== 'restore') {
    manifestPath = await physicalFile(fixtureRoot, options.manifest);
    const manifest = validateRepoManifest(JSON.parse(await readFile(manifestPath, 'utf8')), { runnable: true });
    assert.ok(!manifest.faultGateway); assert.equal(manifest.runtime, fixture.runtimeScope);
    if (options.action === 'validate') return { validated: true, serviceMutations: 0, modelCalls: 0, manifestPath,
      required: 'Coordinated stopped-app window, settled DB/physical resources, verified direct worker, fresh window UUID. No gateway is provisioned by validation.' };
    await stoppedApplication(fixture); await databaseIdle(fixture); await runningDistro(linux.name);
    worker = await observeRepoWorker(fixture); assert.equal(repoHash(JSON.stringify(worker)), manifest.workerReceiptSha256);
    const bytes = await readFile(resolve(dirname(manifestPath), 'transport.json')); assert.equal(repoHash(bytes), manifest.transport.receiptSha256);
    const transport = JSON.parse(bytes); assert.match(transport.planPath, /^transport-[a-f0-9-]{36}\/plan\.json$/);
    assert.deepEqual(await runTransportPlan('verify', resolve(dirname(manifestPath), transport.planPath)), transport.verifiedTransport);
  } else {
    const path = await physicalFile(lifecycleRoot, options.receipt); before = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(before.kind, 'syna-repo-fault-lifecycle-wrapper'); assert.equal(before.runtime, fixture.runtimeScope); id = before.id;
    assert.ok(before.result && before.result.id === id && before.result.phase !== 'restored');
    await stoppedApplication(fixture); await databaseIdle(fixture); await runningDistro(linux.name);
  }
  assert.match(id, uuid);
  const resources = await observeRepoResources(fixture); assert.deepEqual(resources, []);
  // The Windows/WSL loopback bridge remains running while the app is stopped.
  // Its authenticated 502 must be backed by exact process/source evidence.
  const callbackBinding = JSON.parse(await readFile('.data/autonomy-isolation/linux/callback-transport-binding.json', 'utf8'));
  const callback = await verifyRepoCallbackTransport(fixture, callbackBinding, { requireApp: false });
  const callbackReceipt = JSON.parse(await readFile(callbackBinding.path, 'utf8'));
  const sourcePath = resolve('tests/helpers/repo-fault-lifecycle-linux.mjs'), source = await readFile(sourcePath, 'utf8');
  const gatewaySource = await readFile('tests/helpers/repo-fault-gateway.mjs', 'utf8');
  const outputDirectory = resolve(lifecycleRoot, id); await mkdir(outputDirectory, { recursive: true }); assert.equal(await realpath(outputDirectory), outputDirectory);
  const output = resolve(outputDirectory, options.action + '-receipt.json');
  const receipt = { kind: 'syna-repo-fault-lifecycle-wrapper', version: 1, id, action: options.action, runtime: fixture.runtimeScope,
    requestedAt: new Date().toISOString(), manifestPath, callback, linuxHelperSha256: repoHash(source), gatewaySha256: repoHash(gatewaySource), result: null };
  await writeFile(output, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  // Recheck immediately before submitting a physical lifecycle operation.
  await stoppedApplication(fixture); await runningDistro(linux.name);
  const script = source + '\nlet raw="";for await(const chunk of process.stdin){raw+=chunk;if(raw.length>2*1024*1024)throw Error("Input bound")}await runRepoFaultLifecycle(JSON.parse(raw));';
  const input = { action: options.action, id, runtime: fixture.runtimeScope, distro: linux.name, worker,
    runnerKey: fixture.runner.key, internalKey: fixture.internalApiSecret, browserKey: fixture.browser.key, gatewaySource, gatewaySha256: repoHash(gatewaySource),
    callback: { ...callback.linux, directory: callbackReceipt.plan.linuxDirectory },
    ...(before ? { expectedReceiptSha256: repoHash(JSON.stringify(before.result)) } : {}) };
  try {
    const result = await new Promise((yes, no) => {
      const child = spawn('wsl.exe', ['-d', linux.name, '-u', 'root', '--exec', '/opt/syna-autonomy/node/bin/node', '--input-type=module', '-e', script], { env: platform, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = ''; const timer = setTimeout(() => { child.kill(); no(new Error('Lifecycle acknowledgement lost; inspect exact Linux receipt, never repeat start blindly')); }, 120000);
      child.stdout.on('data', chunk => { out += chunk; if (out.length > 2 * 1024 * 1024) { child.kill(); no(new Error('Lifecycle output bound exceeded')); } });
      child.stderr.on('data', chunk => { if (err.length < 8192) err += chunk; });
      child.on('error', error => { clearTimeout(timer); no(error); }); child.stdin.on('error', error => { clearTimeout(timer); no(error); });
      child.on('close', code => { clearTimeout(timer); if (code) no(new Error(err.replaceAll(fixture.runner.key, '[redacted]').replaceAll(fixture.internalApiSecret, '[redacted]').replaceAll(fixture.browser.key, '[redacted]'))); else { try { yes(JSON.parse(out)); } catch (error) { no(error); } } });
      child.stdin.end(JSON.stringify(input));
    });
    receipt.result = result; receipt.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(receipt, null, 2));
    return { receiptPath: output, directory: result.directory, phase: result.phase, modelCalls: 0,
      next: options.action === 'start' ? 'Bind a NEW fault manifest using repo-fault-control; no model trial has started.' : 'Rebind the restarted direct worker before any subsequent normal or preparation trial.' };
  } catch (error) {
    receipt.error = String(error.message).replaceAll(fixture.runner.key, '[redacted]').replaceAll(fixture.internalApiSecret, '[redacted]').replaceAll(fixture.browser.key, '[redacted]').slice(0, 1000);
    receipt.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(receipt, null, 2));
    // The raw cause can contain inherited executor diagnostics or credentials.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(receipt.error);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await manageRepoFaultLifecycle(parseFaultLifecycleArguments(process.argv.slice(2)))));
