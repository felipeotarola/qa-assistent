import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRepoCallbackRelay, callbackRoutes } from './helpers/repo-callback-relay.mjs';

test('callback relay preserves only authenticated exact executor routes and never widens scope', async t => {
  const secret = 'test-local-key-'.repeat(4), calls = [];
  const upstream = createServer(async (req, res) => {
    const parts = []; for await (const chunk of req) parts.push(chunk);
    calls.push({ method: req.method, path: req.url, auth: req.headers.authorization, cookie: req.headers.cookie, bytes: Buffer.concat(parts).toString() });
    res.writeHead(req.method === 'GET' ? 200 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.method === 'GET' ? { protocol: 1 } : { statusCode: 400 }));
  });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  const relay = createRepoCallbackRelay({ secret, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, allowedRemoteAddresses: ['127.0.0.1'] });
  await new Promise(done => relay.listen(0, '127.0.0.1', done));
  t.after(async () => { for (const server of [relay, upstream]) { server.closeAllConnections(); await new Promise(done => server.close(done)); } });
  const invoke = (path, method, token = secret) => fetch(`http://127.0.0.1:${relay.address().port}${path}`, { method,
    headers: { authorization: 'Bearer ' + token, cookie: 'must-not-forward=private', 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
  for (const [path, method] of Object.entries(callbackRoutes)) assert.equal((await invoke(path, method)).status, method === 'GET' ? 200 : 400);
  assert.equal(calls.length, 6); assert.ok(calls.every(call => call.auth === 'Bearer ' + secret && call.cookie === undefined));
  for (const path of ['/api/internal/profile', '/api/internal/autonomy/executor/admit?x=1', '/api/internal/autonomy/drain', '//outside.invalid/a']) assert.equal((await invoke(path, 'GET')).status, 404);
  assert.equal((await invoke('/api/internal/execution-capabilities', 'POST')).status, 405);
  assert.equal((await invoke('/api/internal/execution-capabilities', 'GET', 'wrong')).status, 401);
  assert.equal(calls.length, 6);
});

test('callback relay rejects arbitrary upstream and remote hosts before it can listen', () => {
  const base = { secret: 'a'.repeat(64), upstreamOrigin: 'http://127.0.0.1:58000', allowedRemoteAddresses: ['127.0.0.1'] };
  for (const upstreamOrigin of ['https://prod.invalid', 'http://user:pw@127.0.0.1:58000', 'http://127.0.0.1:58000/path', 'http://127.0.0.1:58000/?query=1', 'http://0.0.0.0:58000']) assert.throws(() => createRepoCallbackRelay({ ...base, upstreamOrigin }));
  assert.throws(() => createRepoCallbackRelay({ ...base, allowedRemoteAddresses: ['0.0.0.0'] }));
});
