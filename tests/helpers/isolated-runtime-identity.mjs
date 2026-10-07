import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

// CommandLineToArgvW-compatible quote/backslash handling for Node spawn's argv.
export function windowsCommandArguments(command) {
  if (typeof command !== 'string' || !command) return [];
  const result = []; let i = 0;
  while (i < command.length) {
    while (/\s/.test(command[i] || '') && i < command.length) i++;
    if (i === command.length) break;
    let argument = '', quoted = false;
    while (i < command.length) {
      if (!quoted && /\s/.test(command[i])) break;
      let slashes = 0;
      while (command[i] === '\\') { slashes++; i++; }
      if (command[i] === '"') {
        argument += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) argument += '"';
        else quoted = !quoted;
        i++; continue;
      }
      argument += '\\'.repeat(slashes);
      if (i < command.length) argument += command[i++];
    }
    if (quoted) throw new Error('Unbalanced runtime command line');
    result.push(argument);
  }
  return result;
}

export function isolatedServiceCommand(root, service, eveCli) {
  const cwd = resolve(root, service);
  if (service === 'web') return ['--import', pathToFileURL(resolve(cwd, 'tests/helpers/observe-http.mjs')).href, resolve(cwd, '.output/server/index.mjs')];
  if (service === 'eve' && typeof eveCli === 'string') return [eveCli, 'start', '--host', '127.0.0.1', '--port', '58001'];
  throw new Error('Unknown isolated service command');
}

const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && resolve(a).toLowerCase() === resolve(b).toLowerCase();
const time = value => typeof value === 'string' ? Date.parse(value) : NaN;

/** The file receipt is not enough: match actual process start identity, argv,
 * parentage and the owner of the exact loopback listener before any API call. */
export function verifyRuntimeIdentity({ root, runtime, nodeExecutable, eveCli, services = ['web', 'eve'], observed, requireRecordedIdentity = false }) {
  if (!Array.isArray(observed.processes) || !Array.isArray(observed.listeners)) throw new Error('Missing runtime process observation');
  const receipts = {};
  const verifyProcess = (process, args) => {
    if (!process || !samePath(process.executable, nodeExecutable)) throw new Error('Runtime PID does not belong to the managed Node executable');
    const actual = windowsCommandArguments(process.commandLine);
    if (!samePath(actual[0], nodeExecutable) || JSON.stringify(actual.slice(1)) !== JSON.stringify(args)) throw new Error('Runtime PID command differs from the owned service');
    if (!Number.isFinite(time(process.createdAt))) throw new Error('Runtime process has no verified start identity');
    return { pid: process.pid, parentPid: process.parentPid, createdAt: process.createdAt, commandSha256: createHash('sha256').update(JSON.stringify(actual)).digest('hex') };
  };
  for (const service of services) {
    if (!['web', 'eve'].includes(service)) throw new Error('Unknown runtime identity service');
    const saved = runtime[service], port = service === 'web' ? 58000 : 58001;
    if (!Number.isSafeInteger(saved?.pid) || saved.pid <= 0 || !Number.isFinite(time(saved.startedAt))) throw new Error('Invalid recorded runtime start');
    if (saved.cwd !== resolve(root, service) || saved.origin !== `http://127.0.0.1:${port}`) throw new Error('Recorded runtime location is not the owned service');
    const process = observed.processes.find(entry => entry.pid === saved.pid);
    const main = verifyProcess(process, isolatedServiceCommand(root, service, eveCli));
    if (Math.abs(time(process.createdAt) - time(saved.startedAt)) > 10000) throw new Error('Recorded runtime PID was reused or has a stale start identity');
    const listeners = observed.listeners.filter(listener => listener.port === port);
    if (listeners.length !== 1 || listeners[0].address !== '127.0.0.1') throw new Error('Expected exactly one owned IPv4 loopback listener');
    const owner = listeners[0].pid;
    let listener = main;
    if (service === 'web') {
      if (owner !== process.pid) throw new Error('Web listener belongs to another process');
    } else {
      const child = observed.processes.find(entry => entry.pid === owner);
      if (!child || child.parentPid !== process.pid || time(child.createdAt) < time(process.createdAt) - 1000) throw new Error('Eve listener is not the current CLI child');
      listener = verifyProcess(child, [resolve(root, 'eve/.output/server/index.mjs')]);
    }
    const receipt = { main, listener, address: '127.0.0.1', port };
    if ((requireRecordedIdentity || saved.identity) && JSON.stringify(saved.identity) !== JSON.stringify(receipt)) throw new Error('Runtime process/listener identity changed since verified start');
    receipts[service] = receipt;
  }
  return receipts;
}

export async function observeWindowsRuntime(runtime, services = ['web', 'eve']) {
  if (process.platform !== 'win32') throw new Error('This runtime identity fixture requires Windows CIM and TCP listener observations');
  const ids = services.map(service => runtime[service]?.pid);
  if (!ids.length || ids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error('Invalid runtime PID observation request');
  const script = `$ErrorActionPreference = 'Stop'
$ids = @(${ids.join(',')})
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 58000,58001 -ErrorAction SilentlyContinue | ForEach-Object { @{ port=[int]$_.LocalPort; address=$_.LocalAddress; pid=[int]$_.OwningProcess } })
$owners = @($listeners | ForEach-Object { $_.pid })
$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in $ids -or $_.ParentProcessId -in $ids -or $_.ProcessId -in $owners } | ForEach-Object { @{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; createdAt=$_.CreationDate.ToUniversalTime().ToString('o'); executable=$_.ExecutablePath; commandLine=$_.CommandLine } })
@{ processes=$processes; listeners=$listeners } | ConvertTo-Json -Depth 5 -Compress`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 15000 });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}

/** A dead CLI PID is insufficient: its child can still own the workflow
 * directory or listener. This read-only probe also catches startup failures
 * before a child identity could be persisted. No process is terminated here. */
export async function requireWindowsRuntimeStopped(root, runtime, services) {
  if (process.platform !== 'win32') throw new Error('Stopped-runtime verification requires Windows process observation');
  const config = { root: resolve(root), services, identities: services.flatMap(service => [runtime[service]?.identity?.main, runtime[service]?.identity?.listener]).filter(Boolean) };
  const encoded = Buffer.from(JSON.stringify(config)).toString('base64');
  const script = `$ErrorActionPreference = 'Stop'
$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$ports = @($config.services | ForEach-Object { if ($_ -eq 'web') { 58000 } else { 58001 } })
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $ports -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.OwningProcess })
$processes = @(Get-CimInstance Win32_Process | Where-Object {
  $candidate = $_
  foreach ($identity in $config.identities) {
    if ($candidate.ProcessId -eq $identity.pid -and $candidate.CreationDate.ToUniversalTime().ToString('o') -eq $identity.createdAt) { return $true }
  }
  if (-not $candidate.CommandLine) { return $false }
  foreach ($service in $config.services) {
    if ($candidate.CommandLine.Contains((Join-Path $config.root ($service + [IO.Path]::DirectorySeparatorChar)))) { return $true }
    if ($service -eq 'eve' -and $candidate.CommandLine.Contains($config.root) -and $candidate.CommandLine -match 'eve[.]js start --host 127[.]0[.]0[.]1 --port 58001$') { return $true }
  }
  return $false
} | ForEach-Object { [int]$_.ProcessId })
@{ processes=$processes; listeners=$listeners } | ConvertTo-Json -Compress`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 15000 });
  assertRuntimeStoppedObservation(JSON.parse(stdout.replace(/^\uFEFF/, '')));
}

export function assertRuntimeStoppedObservation(observed) {
  if (!Array.isArray(observed.processes) || !Array.isArray(observed.listeners)) throw new Error('Missing stopped-runtime observation');
  if (observed.processes.length || observed.listeners.length) throw new Error('Stop all owned runtime processes and listeners before changing artifacts or workflow stores');
}
