// Isolated fault injector, not product code. Startup/provision is a separately
// coordinated action. Never persist request bodies, headers, cookies or keys.
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/, hash = value => createHash('sha256').update(value).digest('hex');
const execute = promisify(execFile), env = { PATH: '/opt/syna-autonomy/node/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/nonexistent', DOCKER_HOST: 'unix:///var/run/docker.sock' };
const readJson = async path => { try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const equalSecret = (given, expected) => typeof given === 'string' && typeof expected === 'string' && Buffer.byteLength(given) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
const bufferedHeaders = (headers, bytes) => {
  const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...String(headers.connection ?? '').split(',').map(x => x.trim().toLowerCase())]);
  return { ...Object.fromEntries(Object.entries(headers).filter(([key]) => !hop.has(key))), connection: 'close', 'content-length': String(bytes) };
};

export function matchesRepoFault(arm, value, now = Date.now()) {
  return !!arm && uuid.test(arm.id) && uuid.test(arm.workspaceId) && ['runner_ack_lost', 'app_stops_after_ready', 'consent_revoked_before_release'].includes(arm.variant)
    && Number.isFinite(Date.parse(arm.expiresAt)) && Date.parse(arm.expiresAt) > now && Date.parse(arm.armedAt) <= now && Date.parse(arm.expiresAt) - Date.parse(arm.armedAt) <= 75 * 60_000
    && value?.workspaceId === arm.workspaceId && value.execution?.runtime === arm.runtime && uuid.test(value.execution?.attemptId) && uuid.test(value.execution?.dispatchId)
    && (value.url ?? value.environmentExecution?.repoUrl ?? value.environmentExecution?.plan?.repoUrl ?? value.environment?.repoUrl) === arm.repoUrl;
}

/** Stops the exact confirmed keyless app process group, retaining its sandbox
 * so the ordinary product must observe failure and perform its own cleanup. */
export async function stopOwnedFixtureApplication(value) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const { id, jobId, workspaceId, execution, environment } = value;
  for (const item of [id, jobId, workspaceId, execution?.attemptId]) assert.match(item, uuid);
  assert.equal(execution.dispatchId, jobId); assert.equal(environment.processId, execution.attemptId);
  assert.equal(environment.repoUrl, 'https://github.com/syna-autonomy-fixture/keyless'); assert.equal(environment.probeKind, 'http');
  assert.ok(environment.httpStatus >= 200 && environment.httpStatus < 400 && Number.isFinite(Date.parse(environment.observedAt)));
  const saved = await readJson(`/var/lib/syna-autonomy/runner/codex/${jobId}.json`);
  assert.ok(saved); assert.equal(saved.id, id); assert.equal(saved.workspaceId, workspaceId); assert.deepEqual(saved.execution, execution);
  assert.equal(saved.environment.processId, environment.processId); assert.equal(saved.environment.commit, environment.commit);
  assert.equal(saved.status, 'completed'); assert.equal(saved.cleanup, 'retained');
  const name = `qa-sandbox-${id}`, container = JSON.parse((await execute('docker', ['inspect', name], { env, encoding: 'utf8', timeout: 10000 })).stdout)[0];
  assert.equal(container.Name, '/' + name); assert.equal(container.Config.Labels['qa.sandbox'], 'true'); assert.equal(container.State.Running, true);
  assert.equal(container.Image, environment.executionProfile.imageDigest);
  const script = String.raw`const f=require('fs');(async()=>{const id=process.argv[1],port=Number(process.argv[2]);if(!/^[a-f0-9-]{36}$/.test(id)||!Number.isInteger(port)||port<1024||port>65535)throw Error('Scope');const p=JSON.parse(f.readFileSync('/tmp/qa-processes/'+id+'.json','utf8'));if(p.id!==id||p.status!=='running'||!Number.isSafeInteger(p.pid)||p.pid<=1)throw Error('Not running');const raw=f.readFileSync('/proc/'+p.pid+'/stat','utf8'),startTicks=raw.slice(raw.lastIndexOf(')')+2).split(' ')[19];process.kill(-p.pid,'SIGKILL');const end=Date.now()+2000;let live;do{live=f.readdirSync('/proc').filter(x=>/^[0-9]+$/.test(x)).some(x=>{try{const s=f.readFileSync('/proc/'+x+'/stat','utf8');const a=s.slice(s.lastIndexOf(')')+2).split(' ');return Number(a[2])===p.pid&&a[0]!=='Z'}catch{return false}});if(live)await new Promise(r=>setTimeout(r,25));}while(live&&Date.now()<end);if(live)throw Error('Process group not empty');let reachable=false;try{await fetch('http://127.0.0.1:'+port+'/',{signal:AbortSignal.timeout(750)});reachable=true}catch{}if(reachable)throw Error('App still responds');console.log(JSON.stringify({pid:p.pid,startTicks,processGroupEmpty:true,httpReachableAfter:false}));})().catch(e=>{console.error(e.message);process.exitCode=1});`;
  const proof = JSON.parse((await execute('docker', ['exec', name, 'node', '-e', script, environment.processId, String(environment.port)], { env, encoding: 'utf8', timeout: 10000, maxBuffer: 8192 })).stdout);
  return { containerId: container.Id, resourceId: id, processId: environment.processId, commit: environment.commit, readyAt: environment.observedAt, ...proof };
}

export function createRepoFaultGateway({ directory, runnerKey, internalKey, backendPort = 58093, appPort = 58000, stopApplication = stopOwnedFixtureApplication, now = Date.now }) {
  assert.ok(runnerKey?.length >= 32 && internalKey?.length >= 32);
  let serial = Promise.resolve();
  const locked = fn => { const result = serial.then(fn, fn); serial = result.catch(() => {}); return result; };
  const receiptFile = arm => `${directory}/receipt-${arm.id}.json`;
  const record = async (arm, value, extra) => {
    const result = { version: 1, variant: arm.variant, id: arm.id, workspaceId: arm.workspaceId, runtime: arm.runtime, applied: true,
      appliedAt: new Date(now()).toISOString(), jobId: value.jobId ?? value.id, attemptId: value.execution.attemptId, dispatchId: value.execution.dispatchId, ...extra };
    await fs.writeFile(receiptFile(arm), JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 }); return result;
  };
  const stopIfReady = (arm, value) => locked(async () => {
    if (!matchesRepoFault(arm, value, now()) || arm.variant !== 'app_stops_after_ready' || value.status !== 'completed' || value.cleanup !== 'retained' || value.environment?.probeKind !== 'http') return;
    if (await readJson(receiptFile(arm))) return;
    const proof = await stopApplication(value); await record(arm, value, proof);
  });
  const server = callback => createServer(async (req, res) => {
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) { res.writeHead(400); res.end(); return; }
    // Local lifecycle proof is available before either upstream is running.
    // It cannot arm a fault or forward a callback, and never echoes credentials.
    if (req.url.startsWith('/__syna_fault_health')) {
      res.setHeader('cache-control', 'no-store');
      if (req.url !== '/__syna_fault_health') { res.writeHead(404); res.end(); return; }
      if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return; }
      if (!equalSecret(req.headers.authorization, 'Bearer ' + (callback ? internalKey : runnerKey))) { res.writeHead(401); res.end(); return; }
      const nonce = req.headers['x-syna-health-nonce'];
      if (typeof nonce !== 'string' || !uuid.test(nonce)) { res.writeHead(400); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 1, kind: 'syna-repo-fault-gateway-health', role: callback ? 'callback' : 'runner', nonce }));
      return;
    }
    try {
      const chunks = []; let size = 0;
      for await (const bytes of req) { size += bytes.length; assert.ok(size <= 8 * 1024 * 1024); chunks.push(bytes); }
      const body = Buffer.concat(chunks), arm = await readJson(directory + '/arm.json');
      let revokedSubmission = null;
      let value; try { value = body.length ? JSON.parse(body) : null; } catch { value = null; }
      const authorized = equalSecret(req.headers.authorization, 'Bearer ' + (callback ? internalKey : runnerKey));
      if (authorized && callback && req.url === '/api/internal/setup-result') await stopIfReady(arm, value);
      if (authorized && !callback && req.url === '/codex' && value?.action === 'start' && value.environmentExecution?.phase === 'apply'
        && arm?.variant === 'consent_revoked_before_release' && matchesRepoFault(arm, value, now())) {
        await locked(async () => {
          const previous = await readJson(receiptFile(arm));
          if (previous) { assert.equal(previous.requestSha256, hash(body), 'Fault replay payload changed'); return; }
          const consent = value.environmentExecution.consent; assert.ok(consent && uuid.test(consent.id));
          const pending = { id: arm.id, jobId: value.jobId, attemptId: value.execution.attemptId, dispatchId: value.execution.dispatchId, consentId: consent.id, revision: consent.revision, reachedAt: new Date(now()).toISOString() };
          await fs.writeFile(`${directory}/pending-${arm.id}.json`, JSON.stringify(pending), { flag: 'wx', mode: 0o600 });
          const deadline = Math.min(now() + 10000, Date.parse(arm.expiresAt)); let signal;
          while (now() < deadline) { signal = await readJson(`${directory}/continue-${arm.id}.json`); if (signal) break; await new Promise(done => setTimeout(done, 25)); }
          assert.equal(signal?.id, arm.id); assert.equal(signal.consentId, consent.id); assert.equal(signal.revision, consent.revision + 1); assert.equal(signal.apiStatus, 200);
          assert.ok(Number.isFinite(Date.parse(signal.revokedAt)) && Date.parse(signal.revokedAt) >= Date.parse(pending.reachedAt));
          assert.ok(now() < deadline && !res.destroyed, 'Revocation barrier expired or caller disconnected');
          // Durable intent precedes the external effect, but is never an
          // applied/forwarded receipt. An interrupted request remains unknown.
          revokedSubmission = { consentId: consent.id, revision: signal.revision, appliedAt: signal.revokedAt, requestSha256: hash(body) };
          await fs.writeFile(`${directory}/submission-${arm.id}.json`, JSON.stringify({ version: 2, id: arm.id, jobId: value.jobId,
            attemptId: value.execution.attemptId, dispatchId: value.execution.dispatchId, ...revokedSubmission, status: 'outcome_unknown' }), { flag: 'wx', mode: 0o600 });
        });
      }
      const upstream = httpRequest({ hostname: '127.0.0.1', port: callback ? appPort : backendPort, path: req.url, method: req.method,
        headers: { ...bufferedHeaders(req.headers, body.length), host: `127.0.0.1:${callback ? appPort : backendPort}` } }, async incoming => {
        try {
          if (incoming.headers['content-type']?.includes('text/event-stream')) { res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res); return; }
          const buffers = []; let total = 0;
          for await (const bytes of incoming) { total += bytes.length; assert.ok(total <= 8 * 1024 * 1024); buffers.push(bytes); }
          const response = Buffer.concat(buffers); let returned; try { returned = JSON.parse(response); } catch { returned = null; }
          if (revokedSubmission) {
            assert.ok(incoming.statusCode >= 200 && incoming.statusCode < 300, 'No accepted downstream job receipt');
            assert.equal(returned?.jobId, value.jobId); assert.equal(returned?.id, value.id); assert.equal(returned?.workspaceId, value.workspaceId);
            assert.deepEqual(returned.execution, value.execution); assert.deepEqual(returned.environmentExecution, value.environmentExecution);
            assert.match(returned.fingerprint, /^[a-f0-9]{64}$/);
            assert.ok(now() < Date.parse(arm.expiresAt), 'Fault deadline expired before downstream receipt');
            await locked(() => record(arm, value, { ...revokedSubmission, version: 2, forwardedAfterRevocation: true,
              downstream: { accepted: true, status: incoming.statusCode, receivedAt: new Date(now()).toISOString(),
                jobId: returned.jobId, resourceId: returned.id, attemptId: returned.execution.attemptId, dispatchId: returned.execution.dispatchId,
                fingerprint: returned.fingerprint, responseSha256: hash(response) } }));
          }
          if (authorized && !callback && req.url === '/codex' && incoming.statusCode === 200) await stopIfReady(arm, returned);
          if (authorized && !callback && req.url === '/jobs' && req.method === 'POST' && arm?.variant === 'runner_ack_lost' && value?.mode === 'test'
            && matchesRepoFault(arm, value, now()) && incoming.statusCode >= 200 && incoming.statusCode < 300) {
            const drop = await locked(async () => {
              if (await readJson(receiptFile(arm))) return false;
              const job = returned?.job ?? returned; assert.equal(job?.id, value.id); assert.deepEqual(job.execution, value.execution); assert.match(job.fingerprint, /^[a-f0-9]{64}$/);
              await record(arm, job, { upstreamAccepted: true, clientReceiptDropped: true, fingerprint: job.fingerprint, requestSha256: hash(body) }); return true;
            });
            if (drop) { res.destroy(); return; }
          }
          res.writeHead(incoming.statusCode, bufferedHeaders(incoming.headers, response.length)); res.end(response);
        } catch { if (!res.headersSent) res.writeHead(502); res.end('Fault gateway denied an unverified transition'); }
      });
      upstream.setTimeout(60000, () => upstream.destroy(new Error('Upstream timeout')));
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Fault gateway upstream unavailable'); });
      res.on('close', () => { if (!res.writableFinished) upstream.destroy(); }); upstream.end(body);
    } catch { if (!res.headersSent) res.writeHead(503); res.end('Fault point unavailable'); }
  });
  const runner = server(false), callbacks = server(true);
  runner.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/preview/') || req.url.includes('\\') || req.url.startsWith('//')) { socket.destroy(); return; }
    const peer = connect(backendPort, '127.0.0.1', () => { peer.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${req.rawHeaders.reduce((s, part, i) => s + part + (i % 2 ? '\r\n' : ': '), '')}\r\n`); if (head.length) peer.write(head); socket.pipe(peer).pipe(socket); });
    peer.on('error', () => socket.destroy()); socket.on('error', () => peer.destroy()); socket.on('close', () => peer.destroy());
  });
  for (const entry of [runner, callbacks]) { entry.requestTimeout = 70000; entry.headersTimeout = 5000; entry.maxConnections = 40; }
  return { runner, callbacks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  const directory = process.argv[2]; assert.match(directory, /^\/var\/lib\/syna-autonomy\/repo-faults\/[a-f0-9-]{36}$/); assert.equal(await fs.realpath(directory), directory);
  const servers = createRepoFaultGateway({ directory, runnerKey: process.env.REPO_RUNNER_KEY, internalKey: process.env.INTERNAL_API_SECRET });
  servers.runner.listen(58091, '127.0.0.1'); servers.callbacks.listen(58094, '127.0.0.1');
}
