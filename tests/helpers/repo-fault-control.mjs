// Test authority only: observe an explicitly provisioned gateway; write bounded
// arm/continue files inside its exact owned directory. Never starts a service.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { repoHash, validateRepoManifest } from './repo-benchmark-contract.mjs';
import { validateRepoFaultArm } from './repo-fault-contract.mjs';
import { REPO_WORKER_PROBE } from './repo-worker-integrity.mjs';
import { readIsolationFixture } from './autonomy-isolation.mjs';
import { runTransportPlan } from './repo-transport.mjs';

const platform = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:path|pathext|systemroot|windir|comspec|temp|tmp)$/i.test(key)));
const root = resolve('.data/autonomy-isolation/repo-fixtures');
const gatewayFile = 'tests/helpers/repo-fault-gateway.mjs';
function directory(value) { assert.match(value, /^\/var\/lib\/syna-autonomy\/repo-faults\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/); return value; }
export function validateFaultGateway(value) {
  assert.equal(value?.version, 1); directory(value.directory); assert.match(value.sha256, /^[a-f0-9]{64}$/);
  assert.equal(value.frontPort, 58091); assert.equal(value.backendPort, 58093); assert.equal(value.callbackPort, 58094); assert.equal(value.appOrigin, 'http://127.0.0.1:58000');
  return value;
}
async function run(script, input) {
  const linux = JSON.parse(await readFile('.data/autonomy-isolation/linux/fixture.json', 'utf8'));
  assert.match(linux.name, /^SynaAutonomy-[a-f0-9]{12}$/); assert.equal(resolve(linux.path), resolve('.data/autonomy-isolation/linux', linux.name));
  const running = (await promisify(execFile)('wsl.exe', ['--list', '--running', '--quiet'], { env: platform, windowsHide: true, encoding: 'utf16le', timeout: 10000 })).stdout.replace(/\0/g, '').split(/\r?\n/).map(x => x.trim());
  assert.ok(running.includes(linux.name), 'A read/protocol signal must not start WSL');
  const result = await new Promise((yes, no) => {
    const child = spawn('wsl.exe', ['-d', linux.name, '-u', 'root', '--exec', '/opt/syna-autonomy/node/bin/node', '--input-type=module', '-e', script], { env: platform, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', bytes = 0; const timer = setTimeout(() => { child.kill(); no(new Error('Fault control receipt lost; do not blindly repeat a signal')); }, 20000);
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 2 * 1024 * 1024) { child.kill(); no(new Error('Fault control output exceeded its bound')); } else out += data; });
    child.stderr.on('data', data => { if (err.length < 8192) err += data; });
    child.on('error', error => { clearTimeout(timer); no(error); }); child.stdin.on('error', error => { clearTimeout(timer); no(error); });
    child.on('close', code => { clearTimeout(timer); if (code) no(new Error(err)); else { try { yes(JSON.parse(out)); } catch (error) { no(error); } } });
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
  return { distro: linux.name, result };
}

// The ordinary direct-worker probe stays immutable. This separate contract
// replaces only the three explicitly declared socket/callback expectations.
export function faultWorkerProbe(config) {
  validateFaultGateway(config);
  const replacements = [
    ["sport = :58091", "sport = :58093"], ["sockets[0].includes('127.0.0.1:58091')", "sockets[0].includes('127.0.0.1:58093')"],
    ["for (const key of ['AUTONOMY_APP_URL','REPO_APP_URL']) assert.equal(env[key],'http://127.0.0.1:58000');", "assert.equal(env.AUTONOMY_APP_URL,'http://127.0.0.1:58000'); assert.equal(env.REPO_APP_URL,'http://127.0.0.1:58094'); assert.equal(env.REPO_PUBLIC_URL,'http://127.0.0.1:58091');"],
    ["assert.equal(env.REPO_RUNNER_PORT,'58091')", "assert.equal(env.REPO_RUNNER_PORT,'58093')"],
    ["callbackOrigin:'http://127.0.0.1:58000'", "callbackOrigin:'http://127.0.0.1:58094'"],
  ];
  let source = REPO_WORKER_PROBE;
  for (const [old, changed] of replacements) { assert.equal(source.split(old).length, 2, 'Worker probe changed; explicit fault adapter review required'); source = source.replace(old, changed); }
  return `const captured=[];const console={log:x=>captured.push(JSON.parse(x))};const gatewayConfig=${JSON.stringify(config)};\n` + source + String.raw`
assert.equal(captured.length,1);const dir=gatewayConfig.directory,file=dir+'/repo-fault-gateway.mjs';assert.equal(fs.realpathSync(dir),dir);assert.equal(fs.realpathSync(file),file);assert.equal(hash(fs.readFileSync(file)),gatewayConfig.sha256);
const matches=fs.readdirSync('/proc').filter(x=>/^[0-9]+$/.test(x)).flatMap(pid=>{try{const argv=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').filter(Boolean);return argv.includes(file)?[{pid:Number(pid),argv}]:[]}catch{return []}});assert.equal(matches.length,1);
const gateway=matches[0];assert.deepEqual(gateway.argv,['/opt/syna-autonomy/node/bin/node',file,dir]);const gproc='/proc/'+gateway.pid;const gs=fs.readFileSync(gproc+'/stat','utf8');gateway.startTicks=gs.slice(gs.lastIndexOf(')')+2).split(' ')[19];gateway.executable=fs.realpathSync(gproc+'/exe');assert.equal(gateway.executable,process.executable);gateway.executableSha256=hash(fs.readFileSync(gateway.executable));
assert.ok(Math.max(fs.statSync(file).mtimeMs,fs.statSync(file).ctimeMs)<=(boot+Number(gateway.startTicks)/hz)*1000);const genv=Object.fromEntries(fs.readFileSync(gproc+'/environ','utf8').split('\0').filter(Boolean).map(x=>{const n=x.indexOf('=');return[x.slice(0,n),x.slice(n+1)]}));assert.ok(!genv.NODE_OPTIONS&&!genv.NODE_PATH);assert.ok(genv.REPO_RUNNER_KEY?.length>=32&&genv.INTERNAL_API_SECRET?.length>=32);assert.ok(genv.REPO_RUNNER_KEY===env.REPO_RUNNER_KEY,'Runner key binding mismatch');assert.ok(genv.INTERNAL_API_SECRET===env.INTERNAL_API_SECRET,'Callback key binding mismatch');
for(const port of[58091,58094]){const rows=execFileSync('ss',['-H','-ltnp','sport = :'+port],{encoding:'utf8'}).trim().split('\n');assert.equal(rows.length,1);assert.ok(rows[0].includes('127.0.0.1:'+port)&&rows[0].includes('pid='+gateway.pid+','));}
const last=fs.readFileSync(gproc+'/stat','utf8');assert.equal(last.slice(last.lastIndexOf(')')+2).split(' ')[19],gateway.startTicks);globalThis.console.log(JSON.stringify({...captured[0],faultGateway:{...gatewayConfig,process:gateway}}));
`;
}
export async function observeFaultWorker(fixture, config) {
  assert.equal(fixture.runner.url, 'http://127.0.0.1:58091'); validateFaultGateway(config);
  assert.equal(repoHash(await readFile(gatewayFile)), config.sha256, 'Gateway source changed after the protocol was frozen');
  const { distro, result } = await run(faultWorkerProbe(config));
  assert.equal(result.sourceSha256, repoHash(JSON.stringify(result.files))); return { distro, ...result };
}

const control = String.raw`
import fs from'node:fs/promises';import assert from'node:assert/strict';let text='';for await(const b of process.stdin){text+=b;if(text.length>16000)throw Error('Control bound')}const x=JSON.parse(text),d=x.directory;assert.match(d,/^\/var\/lib\/syna-autonomy\/repo-faults\/[a-f0-9-]{36}$/);assert.equal(await fs.realpath(d),d);assert.equal((await fs.stat(d)).uid,0);const json=async p=>{try{return JSON.parse(await fs.readFile(p,'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw e}};const id=x.id??x.arm?.id;assert.match(id,/^[a-f0-9-]{36}$/);let result;
if(x.action==='arm'){const old=await json(d+'/arm.json');assert.ok(!old||Date.parse(old.expiresAt)<Date.now()||await json(d+'/receipt-'+old.id+'.json'),'Previous live fault has no receipt');assert.equal(x.arm.id,id);await fs.writeFile(d+'/arm-'+id+'.tmp',JSON.stringify(x.arm),{flag:'wx',mode:0o600});await fs.rename(d+'/arm-'+id+'.tmp',d+'/arm.json');result={armed:true,id};}
else if(x.action==='read'){result={pending:await json(d+'/pending-'+id+'.json'),receipt:await json(d+'/receipt-'+id+'.json')};}
else if(x.action==='continue'){const arm=await json(d+'/arm.json'),pending=await json(d+'/pending-'+id+'.json');assert.equal(arm?.id,id);assert.ok(Date.parse(arm.expiresAt)>Date.now());assert.equal(pending?.id,id);assert.equal(x.signal.id,id);assert.equal(x.signal.consentId,pending.consentId);assert.equal(x.signal.revision,pending.revision+1);assert.equal(x.signal.apiStatus,200);assert.ok(Date.parse(x.signal.revokedAt)>=Date.parse(pending.reachedAt));await fs.writeFile(d+'/continue-'+id+'.json',JSON.stringify(x.signal),{flag:'wx',mode:0o600});result={continued:true,id};}
else throw Error('Unknown action');console.log(JSON.stringify(result));
`;
export async function armRepoFault(config, arm) { validateFaultGateway(config); validateRepoFaultArm(arm); return (await run(control, { action: 'arm', directory: config.directory, arm })).result; }
export async function readRepoFault(config, id) { validateFaultGateway(config); return (await run(control, { action: 'read', directory: config.directory, id })).result; }
export async function continueRepoFault(config, signal) { validateFaultGateway(config); return (await run(control, { action: 'continue', directory: config.directory, id: signal.id, signal })).result; }

/** Bind only AFTER the separately coordinated idle-worker/gateway restart.
 * Original normal manifest and receipt remain immutable and usable again when
 * their original runtime is restored. This does not provision either service. */
export async function bindRepoFaultRuntime(manifestPath, gatewayDirectory) {
  const file = resolve(manifestPath); assert.ok(file.startsWith(root + sep)); assert.equal(await realpath(file), file);
  const manifest = validateRepoManifest(JSON.parse(await readFile(file, 'utf8')), { runnable: true }); assert.ok(!manifest.faultGateway);
  const old = JSON.parse(await readFile(resolve(dirname(file), 'transport.json'), 'utf8')); assert.equal(old.kind, 'simulated-github-transport');
  assert.equal(repoHash(await readFile(resolve(dirname(file), 'transport.json'))), manifest.transport.receiptSha256);
  assert.match(old.planPath, /^transport-[a-f0-9-]{36}\/plan\.json$/);
  const current = await runTransportPlan('verify', resolve(dirname(file), old.planPath)), fixture = await readIsolationFixture(); assert.equal(manifest.runtime, fixture.runtimeScope);
  const gateway = validateFaultGateway({ version: 1, directory: directory(gatewayDirectory), sha256: repoHash(await readFile(gatewayFile)), frontPort: 58091, backendPort: 58093, callbackPort: 58094, appOrigin: fixture.app.origin });
  const worker = await observeFaultWorker(fixture, gateway); assert.equal(worker.executionImage, current.executionImage); assert.deepEqual(current, old.verifiedTransport);
  const id = randomUUID(), workerReceiptSha256 = repoHash(JSON.stringify(worker));
  const transport = { ...old, workerReceiptSha256, faultGateway: gateway }, bytes = Buffer.from(JSON.stringify(transport, null, 2) + '\n');
  const receiptFile = `fault-transport-${id}.json`, bound = { ...manifest, workerReceiptSha256, faultGateway: gateway, transport: { ...manifest.transport, receiptSha256: repoHash(bytes), receiptFile } };
  await writeFile(resolve(dirname(file), receiptFile), bytes, { flag: 'wx' });
  const path = resolve(dirname(file), `fault-manifest-${id}.json`); await writeFile(path, JSON.stringify(bound, null, 2) + '\n', { flag: 'wx' });
  return { path, workerReceiptSha256, gateway, modelCalls: 0, serviceMutations: 0 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = Object.fromEntries(process.argv.slice(2).map(x => { const n = x.indexOf('='); assert.ok(n > 0); return [x.slice(0, n), x.slice(n + 1)]; }));
  assert.deepEqual(Object.keys(options).sort(), ['--gateway-directory', '--manifest']);
  console.log(JSON.stringify(await bindRepoFaultRuntime(options['--manifest'], options['--gateway-directory'])));
}
