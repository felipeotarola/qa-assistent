import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CodexClient, codexProcessIsolationCapability } from '../infra/codex-worker/client.mjs';

// Explicitly launched in the owned Linux fixture. No Codex binary, provider,
// application, network, database, service or existing container is used.
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
assert.equal(process.env.WSL_DISTRO_NAME, 'SynaAutonomy-ff9dd82d1748');
assert.equal(process.env.SYNA_CODEX_GROUP_TEST, 'isolated');
const id = randomUUID(), directory = await mkdtemp('/tmp/syna-codex-group-');
assert.ok((await realpath(directory)).startsWith('/tmp/syna-codex-group-'));
await chmod(directory, 0o755);
const binary = resolve(directory, 'fake-codex'), program = resolve(directory, 'app.mjs');
await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${program}' "$@"\n`, { mode: 0o755 });
await writeFile(program, `import {spawn} from 'node:child_process';
process.on('SIGTERM',()=>{});
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});
child.unref();
console.log(JSON.stringify({method:'fixture/ready',params:{pid:process.pid,childPid:child.pid}}));
setInterval(()=>{},1000);
`, { mode: 0o644 });
const records = [], clients = [];
const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
const sentinelExit = once(sentinel, 'exit');
async function processState(pid) {
  try {
    const content = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = content.slice(content.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], processGroup: Number(fields[2]), session: Number(fields[3]) };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const live = state => state && !['Z', 'X'].includes(state.state);
async function start() {
  let delivered;
  const ready = new Promise(resolve => { delivered = resolve; });
  const client = new CodexClient({ binary, closeGraceMs: 75, closeForceMs: 1500, onRequest() { throw new Error('No model protocol is permitted in this fixture'); },
    onEvent: event => { assert.equal(event.method, 'fixture/ready'); delivered(event.params); } });
  clients.push(client);
  const pids = await Promise.race([ready, delay(5000).then(() => { throw new Error('Synthetic Linux process did not start'); })]);
  const parentScope = (await readFile(`/proc/${pids.pid}/cgroup`, 'utf8')).trim();
  assert.match(parentScope, new RegExp(`syna-codex-${client.scope.id}$`));
  assert.equal((await readFile(`/proc/${pids.childPid}/cgroup`, 'utf8')).trim(), parentScope);
  assert.notEqual((await processState(pids.childPid)).session, (await processState(client.child.pid)).session, 'Grandchild actually escaped the launcher session with setsid');
  return { client, pids, parentScope };
}
try {
  assert.equal(codexProcessIsolationCapability().available, true);
  for (const earlyLauncherExit of [false, true]) {
    const { client, pids, parentScope } = await start(), launcherPid = client.child.pid;
    if (earlyLauncherExit) {
      const exited = once(client.child, 'exit'); client.child.kill('SIGKILL'); await exited;
      assert.equal(client.exited, true);
      assert.ok(live(await processState(pids.childPid)), 'A launcher exit really leaves a surviving descendant in this fault');
    }
    const began = Date.now(), stop = client.close(); assert.equal(client.close(), stop, 'Stop retries reuse the original physical operation');
    const receipt = await stop;
    assert.equal(receipt.mechanism, 'cgroup-v2'); assert.equal(receipt.empty, true);
    assert.ok(!live(await processState(pids.pid))); assert.ok(!live(await processState(pids.childPid)));
    assert.ok(live(await processState(sentinel.pid)), 'An unrelated process group must remain alive');
    records.push({ scenario: earlyLauncherExit ? 'launcher-exited-first' : 'term-resistant-setsid-descendant', launcherPid, ...pids,
      parentScope, receipt, durationMs: Date.now() - began, unrelatedSentinelAlive: true });
  }
  // An independent worker process cannot treat a surviving foreign-generation
  // scope as newly available capacity, even when its launcher record was lost.
  const { client, pids } = await start();
  const probe = spawn(process.execPath, ['--input-type=module', '-e', `import {codexProcessIsolationCapability} from ${JSON.stringify(new URL('../infra/codex-worker/client.mjs', import.meta.url).href)}; console.log(JSON.stringify(codexProcessIsolationCapability()));`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; probe.stdout.on('data', chunk => { output += chunk; });
  const [code] = await once(probe, 'exit'); assert.equal(code, 0);
  assert.equal(JSON.parse(output).available, false); assert.ok(live(await processState(pids.childPid)));
  await client.close();
  records.push({ scenario: 'new-worker-quarantines-surviving-control-process', denied: true, unrelatedSentinelAlive: live(await processState(sentinel.pid)) });
  assert.equal(codexProcessIsolationCapability().available, true);
} finally {
  for (const client of clients) await client.close();
  sentinel.kill('SIGKILL'); await sentinelExit;
  assert.ok((await realpath(directory)).startsWith('/tmp/syna-codex-group-'));
  await rm(directory, { recursive: true, force: true });
}
const artifact = fileURLToPath(new URL(`../.data/autonomy-isolation/codex-process-isolation-${id}.json`, import.meta.url));
await mkdir(dirname(artifact), { recursive: true });
await writeFile(artifact, JSON.stringify({ version: 1, at: new Date().toISOString(), distro: process.env.WSL_DISTRO_NAME, models: 'none', records, sentinelStopped: !live(await processState(sentinel.pid)) }, null, 2));
console.log(JSON.stringify({ passed: records.length, artifact, scenarios: records.map(row => row.scenario), models: 'none', physical: 'Linux cgroup v2 / runuser / setsid descendants' }));
