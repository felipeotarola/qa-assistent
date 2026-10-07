// Read-only identity and capability proof for the separately owned test relays.
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { windowsCommandArguments } from './isolated-runtime-identity.mjs';
import { repoHash } from './repo-benchmark-contract.mjs';

const root = resolve('.data/autonomy-isolation/linux/callback-relay');
const platform = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(path|pathext|systemroot|windir|comspec|temp|tmp)$/i.test(name)));
export async function observeRepoCallbackTransport(fixture, plan) {
  assert.equal(fixture.app.origin, 'http://127.0.0.1:58000'); assert.equal(plan.runtime, fixture.runtimeScope);
  assert.match(plan.id, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  assert.equal(resolve(plan.directory), resolve(root, plan.id)); assert.equal(await realpath(plan.directory), plan.directory);
  assert.equal(plan.windowsEntry, resolve(plan.directory, 'windows-relay.mjs')); assert.equal(plan.windowsRuntime, resolve(plan.directory, 'windows-runtime.json'));
  assert.equal(plan.linuxDirectory, '/var/lib/syna-autonomy/callback-relay/' + plan.id);
  const windows = JSON.parse(await readFile(plan.windowsRuntime, 'utf8')), linux = JSON.parse(await readFile(resolve(plan.directory, 'linux-runtime.json'), 'utf8'));
  assert.equal(windows.id, plan.id); assert.equal(linux.id, plan.id); assert.equal(windows.runtime, fixture.runtimeScope);
  assert.equal(windows.sourceSha256, plan.sourceSha256); assert.equal(linux.sourceSha256, plan.sourceSha256);
  assert.equal(repoHash(await readFile(resolve(plan.directory, 'relay.mjs'))), plan.sourceSha256);
  assert.equal(repoHash(await readFile('tests/helpers/repo-callback-relay.mjs')), plan.sourceSha256);
  assert.equal(repoHash(await readFile(plan.windowsEntry)), windows.entrySha256);
  assert.equal(repoHash(await readFile(windows.argv[0])), windows.executableSha256);
  assert.ok(Number.isSafeInteger(windows.pid) && windows.pid > 1);
  const script = `$ErrorActionPreference='Stop'
$p=Get-CimInstance Win32_Process -Filter "ProcessId=${windows.pid}"
$listeners=@(Get-NetTCPConnection -State Listen -LocalPort 58095 -ErrorAction SilentlyContinue | ForEach-Object {@{port=[int]$_.LocalPort;address=$_.LocalAddress;pid=[int]$_.OwningProcess}})
@{process=@{pid=[int]$p.ProcessId;createdAt=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath;argv=$p.CommandLine};listeners=$listeners} | ConvertTo-Json -Depth 4 -Compress`;
  const seen = JSON.parse((await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: platform, windowsHide: true, encoding: 'utf8', timeout: 10000 })).stdout.replace(/^\uFEFF/, ''));
  assert.equal(seen.process.pid, windows.pid); assert.equal(seen.process.executable.toLowerCase(), windows.argv[0].toLowerCase());
  assert.deepEqual(windowsCommandArguments(seen.process.argv).map(value => value.toLowerCase()), windows.argv.map(value => value.toLowerCase()));
  assert.deepEqual(seen.listeners, [{ port: 58095, address: '172.25.48.1', pid: windows.pid }]);
  const distro = JSON.parse(await readFile('.data/autonomy-isolation/linux/fixture.json', 'utf8')).name; assert.match(distro, /^SynaAutonomy-[a-f0-9]{12}$/);
  const running = (await promisify(execFile)('wsl.exe', ['--list', '--running', '--quiet'], { env: platform, windowsHide: true, encoding: 'utf16le', timeout: 10000 })).stdout.replace(/\0/g, '').split(/\r?\n/).map(x => x.trim());
  assert.ok(running.includes(distro), 'A relay observation must not start WSL');
  const source = String.raw`import fs from'node:fs/promises';import assert from'node:assert/strict';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';let raw='';for await(const b of process.stdin)raw+=b;const x=JSON.parse(raw),r=x.receipt,hash=v=>createHash('sha256').update(v).digest('hex');assert.match(r.directory,/^\/var\/lib\/syna-autonomy\/callback-relay\/[a-f0-9-]{36}$/);assert.equal(await fs.realpath(r.directory),r.directory);const stat=await fs.readFile('/proc/'+r.pid+'/stat','utf8');assert.equal(stat.slice(stat.lastIndexOf(')')+2).split(' ')[19],r.startTicks);assert.deepEqual((await fs.readFile('/proc/'+r.pid+'/cmdline','utf8')).split('\0').filter(Boolean),r.argv);assert.equal(await fs.realpath('/proc/'+r.pid+'/exe'),r.executable);assert.equal(hash(await fs.readFile(r.executable)),r.executableSha256);assert.equal(hash(await fs.readFile(r.directory+'/relay.mjs')),r.sourceSha256);assert.equal(hash(await fs.readFile(r.directory+'/linux-relay.mjs')),r.entrySha256);const rows=execFileSync('ss',['-H','-ltnp','sport = :58000'],{encoding:'utf8'}).trim().split('\n');assert.equal(rows.length,1);assert.ok(rows[0].includes('127.0.0.1:58000')&&rows[0].includes('pid='+r.pid+','));const env=Object.fromEntries((await fs.readFile('/proc/'+r.pid+'/environ','utf8')).split('\0').filter(Boolean).map(v=>{const n=v.indexOf('=');return[v.slice(0,n),v.slice(n+1)]}));assert.ok(!env.NODE_OPTIONS&&!env.NODE_PATH);assert.equal(env.INTERNAL_API_SECRET===x.secret,true);const response=await fetch('http://127.0.0.1:58000/api/internal/execution-capabilities',{headers:{authorization:'Bearer '+x.secret},redirect:'error',signal:AbortSignal.timeout(5000)});assert.equal(response.status,x.requireApp?200:502);if(x.requireApp)assert.deepEqual(await response.json(),{protocol:1,repositoryPlans:true,sandboxes:true});console.log(JSON.stringify({pid:r.pid,startTicks:r.startTicks,executableSha256:r.executableSha256,sourceSha256:r.sourceSha256,entrySha256:r.entrySha256,capabilityStatus:response.status}));`;
  const observedLinux = await new Promise((yes, no) => {
    const child = spawn('wsl.exe', ['-d', distro, '-u', 'root', '--exec', '/opt/syna-autonomy/node/bin/node', '--input-type=module', '-e', source], { env: platform, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; const timeout = setTimeout(() => { child.kill(); no(new Error('Read-only relay observation timed out')); }, 15000);
    child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { if (err.length < 16000) err += b; }); child.on('error', no);
    child.on('close', code => { clearTimeout(timeout); if (code) no(new Error(err.replaceAll(fixture.internalApiSecret, '[REDACTED]'))); else { try { yes(JSON.parse(out)); } catch (error) { no(error); } } });
    child.stdin.end(JSON.stringify({ receipt: linux, secret: fixture.internalApiSecret, requireApp: plan.requireApp !== false }));
  });
  return { windows: { ...seen.process, executableSha256: windows.executableSha256, sourceSha256: windows.sourceSha256, entrySha256: windows.entrySha256 }, linux: observedLinux,
    routing: { windowsHost: '172.25.48.1', windowsPort: 58095, linuxHost: '127.0.0.1', linuxPort: 58000, applicationOrigin: fixture.app.origin } };
}
export async function verifyRepoCallbackTransport(fixture, binding, { requireApp = true } = {}) {
  const path = resolve(binding.path); assert.ok(path.startsWith(root + sep)); assert.equal(await realpath(path), path);
  const bytes = await readFile(path); assert.equal(repoHash(bytes), binding.sha256, 'Frozen callback transport receipt changed');
  const receipt = JSON.parse(bytes); assert.equal(receipt.kind, 'syna-repo-callback-transport'); assert.equal(receipt.runtime, fixture.runtimeScope);
  const observed = await observeRepoCallbackTransport(fixture, { ...receipt.plan, requireApp });
  const expected = structuredClone(receipt.observed); expected.linux.capabilityStatus = requireApp ? 200 : 502;
  assert.deepEqual(observed, expected, 'Callback relay identity or source changed'); return { receiptSha256: binding.sha256, ...observed };
}
