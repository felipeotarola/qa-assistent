import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRepoFaultGateway } from './helpers/repo-fault-gateway.mjs';
import { parseFaultLifecycleArguments } from './helpers/repo-fault-lifecycle.mjs';
import { assertFaultLifecycleInput, assertFaultProcessIdentity, assertTerminalOttoJobs, assertEmptyCodexScopes } from './helpers/repo-fault-lifecycle-linux.mjs';

test('lifecycle CLI requires one explicit action and a separately chosen start window', () => {
  const id = randomUUID();
  assert.deepEqual(parseFaultLifecycleArguments(['--start', '--manifest=a.json', '--window=' + id]), { action: 'start', manifest: 'a.json', receipt: undefined, id });
  assert.equal(parseFaultLifecycleArguments(['--validate', '--manifest=a.json']).action, 'validate');
  assert.equal(parseFaultLifecycleArguments(['--restore', '--receipt=a.json']).action, 'restore');
  for (const args of [[], ['--start'], ['--start', '--manifest=a.json'], ['--start', '--manifest=a.json', '--window=../old'],
    ['--validate', '--start', '--manifest=a.json'], ['--validate', '--validate', '--manifest=a.json'], ['--validate', '--manifest=a.json', '--window=' + id],
    ['--restore', '--receipt=a.json', '--manifest=b.json'], ['--restore', '--receipt=a.json', '--window=' + id],
    ['--validate', '--manifest=a.json', '--manifest=b.json'], ['--validate', '--manifest=a.json', '--execute'],
  ]) assert.throws(() => parseFaultLifecycleArguments(args));
});

test('remote lifecycle refuses foreign scope or unbound restore before effects', () => {
  const input = { action: 'start', id: randomUUID(), runtime: 'autonomy-test:fixture', distro: 'SynaAutonomy-ff9dd82d1748', runnerKey: 'a'.repeat(64), internalKey: 'b'.repeat(64), browserKey: 'c'.repeat(64) };
  assert.doesNotThrow(() => assertFaultLifecycleInput(input));
  assert.doesNotThrow(() => assertFaultLifecycleInput({ ...input, action: 'restore', expectedReceiptSha256: 'a'.repeat(64) }));
  for (const extra of [{ action: 'restart' }, { id: '../other' }, { runtime: 'production' }, { distro: 'Ubuntu' }, { runnerKey: '' }, { internalKey: '' }, { browserKey: '' }, { action: 'restore' }]) {
    assert.throws(() => assertFaultLifecycleInput({ ...input, ...extra }));
  }
});

test('signalling requires full current executable, start identity and exact argv, never a PID alone', () => {
  const identity = { pid: 1122, startTicks: '12001', executable: '/opt/syna-autonomy/node/bin/node', executableSha256: 'a'.repeat(64), argv: ['/opt/syna-autonomy/node/bin/node', '/opt/syna-autonomy/source/infra/repo-runner/server.mjs'] };
  assert.doesNotThrow(() => assertFaultProcessIdentity(identity, structuredClone(identity)));
  for (const extra of [{ pid: 1123 }, { startTicks: '12002' }, { executable: '/usr/bin/node' }, { executableSha256: 'b'.repeat(64) }, { argv: ['/opt/syna-autonomy/node/bin/node', '/other.mjs'] }]) {
    assert.throws(() => assertFaultProcessIdentity(identity, { ...identity, ...extra }));
  }
  assert.throws(() => assertFaultProcessIdentity(identity, null));
  assert.throws(() => assertFaultProcessIdentity({ ...identity, pid: 1 }, { ...identity, pid: 1 }));
});

test('all saved Otto work must be terminal before switching either service', () => {
  assert.doesNotThrow(() => assertTerminalOttoJobs([]));
  assert.doesNotThrow(() => assertTerminalOttoJobs([{ status: 'completed' }, { status: 'cancelled' }, { status: 'failed' }, { status: 'needs_configuration' }, { status: 'interrupted' }]));
  for (const status of ['queued', 'running', 'cancelling', 'unknown', undefined]) assert.throws(() => assertTerminalOttoJobs([{ status: 'completed' }, { status }]));
});

test('terminal jobs and empty Docker are insufficient when a real Codex cgroup is populated or unreadable', () => {
  const name = 'syna-codex-' + randomUUID();
  assert.doesNotThrow(() => assertEmptyCodexScopes([]));
  assert.doesNotThrow(() => assertEmptyCodexScopes([{ name, events: 'populated 0\nfrozen 0\n' }]));
  assert.throws(() => assertEmptyCodexScopes([{ name, events: 'populated 1\nfrozen 0\n' }]), /physical cleanup/);
  assert.throws(() => assertEmptyCodexScopes([{ name, events: 'frozen 0\n' }]), /physical cleanup/);
  assert.throws(() => assertEmptyCodexScopes([{ name: '../other', events: 'populated 0\n' }]));
});

test('gateway bootstrap health authenticates each socket without touching an upstream or fault files', async t => {
  let forwarded = 0;
  const upstream = createServer((_req, res) => { forwarded++; res.writeHead(500); res.end(); });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  const runnerKey = 'runner-'.repeat(8), internalKey = 'internal-'.repeat(8);
  // Deliberately nonexistent directory proves health does not inspect arm files.
  const gateway = createRepoFaultGateway({ directory: '/nonexistent/syna-health-' + randomUUID(), runnerKey, internalKey,
    backendPort: upstream.address().port, appPort: upstream.address().port });
  for (const server of Object.values(gateway)) await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { for (const server of [...Object.values(gateway), upstream]) { server.closeAllConnections(); await new Promise(done => server.close(done)); } });
  for (const [name, key, role] of [['runner', runnerKey, 'runner'], ['callbacks', internalKey, 'callback']]) {
    const origin = `http://127.0.0.1:${gateway[name].address().port}`, nonce = randomUUID();
    const request = (path, method = 'GET', secret = key, challenge = nonce) => fetch(origin + path, { method,
      headers: { authorization: 'Bearer ' + secret, 'x-syna-health-nonce': challenge }, signal: AbortSignal.timeout(2000) });
    const good = await request('/__syna_fault_health'); assert.equal(good.status, 200);
    assert.equal(good.headers.get('cache-control'), 'no-store');
    const body = await good.json(); assert.deepEqual(body, { version: 1, kind: 'syna-repo-fault-gateway-health', role, nonce });
    assert.ok(!JSON.stringify(body).includes(key));
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) { const reply = await request('/__syna_fault_health', method); assert.equal(reply.status, 405); assert.equal(reply.headers.get('allow'), 'GET'); }
    for (const path of ['/__syna_fault_health/extra', '/__syna_fault_health?nonce=' + nonce, '/__syna_fault_healthz']) assert.equal((await request(path)).status, 404);
    assert.equal((await request('/__syna_fault_health', 'GET', name === 'runner' ? internalKey : runnerKey)).status, 401);
    assert.equal((await request('/__syna_fault_health', 'GET', '')).status, 401);
    assert.equal((await request('/__syna_fault_health', 'GET', key, 'bad')).status, 400);
  }
  assert.equal(forwarded, 0);
});
