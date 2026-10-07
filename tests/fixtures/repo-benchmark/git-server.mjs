// Test-only smart Git transport. It serves three immutable repositories, never
// application credentials, the oracle, filesystem paths or receive-pack.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const GIT_FIXTURE_HOST = '198.51.100.10';
export const GIT_FIXTURE_PORT = 18080;
export const GIT_FIXTURE_NAMES = ['library', 'keyless', 'configured'];
const MAX_REQUEST = 1024 * 1024, MAX_RESPONSE = 8 * 1024 * 1024;

export function gitRequest(method, rawUrl, headers = {}) {
  // Match the raw request target before any URL normalization/percent decoding.
  const match = /^\/(library|keyless|configured)(?:\.git)?\/(info\/refs\?service=git-upload-pack|git-upload-pack)$/.exec(rawUrl || '');
  assert.ok(match, 'Unknown fixture Git resource');
  const advertise = match[2].startsWith('info/refs');
  assert.equal(method, advertise ? 'GET' : 'POST', 'Read-only Git protocol');
  assert.ok(!headers.authorization && !headers.cookie && !headers['content-encoding'], 'Credentials and encoded request bodies are not accepted');
  if (!advertise) assert.equal(headers['content-type'], 'application/x-git-upload-pack-request');
  const length = headers['content-length'];
  assert.ok(length === undefined || (/^\d+$/.test(length) && Number(length) <= MAX_REQUEST));
  return { name: match[1], pathInfo: `/${match[1]}.git/${advertise ? 'info/refs' : 'git-upload-pack'}`, query: advertise ? 'service=git-upload-pack' : '', advertise };
}

export function gitCgiResponse(bytes) {
  assert.ok(bytes.length <= MAX_RESPONSE);
  let end = bytes.indexOf('\r\n\r\n'), skip = 4;
  if (end < 0) { end = bytes.indexOf('\n\n'); skip = 2; }
  assert.ok(end > 0 && end <= 8192, 'Invalid CGI response');
  let status = 200; const headers = {};
  for (const line of bytes.subarray(0, end).toString('ascii').split(/\r?\n/)) {
    const colon = line.indexOf(':'); assert.ok(colon > 0);
    const key = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim();
    if (key === 'status') { assert.match(value, /^(?:200|400|403|404|405|500)\b/); status = Number(value.slice(0, 3)); }
    else { assert.ok(['content-type', 'cache-control', 'expires', 'pragma'].includes(key)); headers[key] = value; }
  }
  assert.ok(headers['content-type']);
  return { status, headers: { ...headers, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: bytes.subarray(end + skip) };
}

async function backend(root, request, body) {
  const env = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: request.pathInfo, QUERY_STRING: request.query,
    REQUEST_METHOD: request.advertise ? 'GET' : 'POST', CONTENT_TYPE: request.advertise ? '' : 'application/x-git-upload-pack-request', CONTENT_LENGTH: String(body.length) };
  return await new Promise((yes, no) => {
    const args = GIT_FIXTURE_NAMES.flatMap(name => ['-c', `safe.directory=${root}/${name}.git`]);
    const child = spawn('/usr/bin/git', [...args, '-c', 'http.receivepack=false', '-c', 'core.hooksPath=/dev/null', 'http-backend'], { cwd: root, env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let size = 0, failure; const chunks = [];
    const stop = error => { failure ||= error; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already reaped: close still settles the request. */ } };
    const timer = setTimeout(() => stop(new Error('Git transport timed out')), 15000);
    child.on('error', no);
    child.stdout.on('data', bytes => { size += bytes.length; if (size > MAX_RESPONSE) stop(new Error('Git response too large')); else chunks.push(bytes); });
    child.stdin.on('error', () => stop(new Error('Git backend rejected input')));
    child.on('close', code => { clearTimeout(timer); if (failure || code !== 0) no(failure || new Error('Git backend failed')); else yes(gitCgiResponse(Buffer.concat(chunks))); });
    child.stdin.end(body);
  });
}

export function createGitFixtureServer(root, runBackend = backend) {
  let active = 0;
  const server = createServer(async (req, res) => {
    let request;
    try { request = gitRequest(req.method, req.url, req.headers); }
    catch { req.resume(); res.writeHead(404, { 'cache-control': 'no-store' }); res.end('Not found'); return; }
    if (active >= 2) { req.resume(); res.writeHead(503); res.end('Busy'); return; }
    active++;
    try {
      const chunks = []; let length = 0;
      for await (const bytes of req) { length += bytes.length; assert.ok(length <= MAX_REQUEST, 'Request too large'); chunks.push(bytes); }
      assert.ok(!request.advertise || length === 0);
      const reply = await runBackend(root, request, Buffer.concat(chunks));
      res.writeHead(reply.status, reply.headers); res.end(reply.body);
    } catch { if (!res.headersSent) res.writeHead(500, { 'cache-control': 'no-store' }); res.end('Git fixture unavailable'); }
    finally { active--; }
  });
  server.requestTimeout = 20000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxConnections = 8;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 65534, 'Fixture server must run without root privileges');
  const root = process.argv[2]; assert.match(root, /^\/var\/lib\/syna-autonomy\/repo-fixtures\/[a-f0-9-]{36}\/repos$/);
  assert.equal(await realpath(root), root);
  for (const name of GIT_FIXTURE_NAMES) { const path = `${root}/${name}.git`; assert.equal(await realpath(path), path); assert.ok((await lstat(path)).isDirectory()); }
  createGitFixtureServer(root).listen(GIT_FIXTURE_PORT, GIT_FIXTURE_HOST);
}
