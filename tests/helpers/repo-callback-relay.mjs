// Test-only, bounded JSON relay between the two private loopback namespaces.
// Never log bodies, URLs with query values, headers, credentials or errors.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export const callbackRoutes = Object.freeze({
  '/api/internal/execution-capabilities': 'GET',
  '/api/internal/autonomy/executor/admit': 'POST',
  '/api/internal/environment-release': 'POST',
  '/api/internal/environment-retain': 'POST',
  '/api/internal/repository-result': 'POST',
  '/api/internal/setup-result': 'POST',
});
const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createRepoCallbackRelay({ secret, upstreamOrigin, allowedRemoteAddresses, maxBytes = 8 * 1024 * 1024, timeoutMs = 20000 }) {
  assert.ok(typeof secret === 'string' && secret.length >= 32);
  const upstream = new URL(upstreamOrigin);
  assert.ok(upstream.protocol === 'http:' && !upstream.username && !upstream.password && upstream.pathname === '/' && !upstream.search && !upstream.hash);
  assert.ok(['127.0.0.1', '172.25.48.1'].includes(upstream.hostname));
  assert.ok(Array.isArray(allowedRemoteAddresses) && allowedRemoteAddresses.length > 0 && allowedRemoteAddresses.every(ip => ['127.0.0.1', '172.25.60.200'].includes(ip)));
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 8 * 1024 * 1024);
  return createServer(async (incoming, outgoing) => {
    outgoing.setHeader('cache-control', 'no-store');
    const deny = status => { outgoing.writeHead(status); outgoing.end(); };
    if (!allowedRemoteAddresses.includes(incoming.socket.remoteAddress)) return deny(403);
    if (!same(incoming.headers.authorization, 'Bearer ' + secret)) return deny(401);
    if (!Object.hasOwn(callbackRoutes, incoming.url)) return deny(404);
    if (callbackRoutes[incoming.url] !== incoming.method) return deny(405);
    if (incoming.method === 'POST' && incoming.headers['content-type']?.split(';')[0] !== 'application/json') return deny(415);
    let bytes = 0; const chunks = [];
    try {
      for await (const chunk of incoming) { bytes += chunk.length; if (bytes > maxBytes) return deny(413); chunks.push(chunk); }
      if (incoming.method === 'GET' && bytes) return deny(400);
      const body = Buffer.concat(chunks);
      const forwarded = request({ hostname: upstream.hostname, port: upstream.port, method: incoming.method, path: incoming.url,
        headers: { authorization: 'Bearer ' + secret, ...(incoming.method === 'POST' ? { 'content-type': 'application/json' } : {}), 'content-length': body.length, connection: 'close' } }, response => {
        let length = 0; const parts = [];
        response.on('data', chunk => { length += chunk.length; if (length > maxBytes) response.destroy(); else parts.push(chunk); });
        response.on('error', () => { if (!outgoing.headersSent) deny(502); else outgoing.destroy(); });
        response.on('end', () => {
          if (length > maxBytes) return deny(502);
          outgoing.writeHead(response.statusCode, { 'content-type': response.headers['content-type'] || 'application/json' });
          outgoing.end(Buffer.concat(parts));
        });
      });
      forwarded.setTimeout(timeoutMs, () => forwarded.destroy());
      forwarded.on('error', () => { if (!outgoing.headersSent) deny(502); else outgoing.destroy(); });
      outgoing.on('close', () => { if (!outgoing.writableEnded) forwarded.destroy(); });
      forwarded.end(body);
    } catch { if (!outgoing.headersSent) deny(400); else outgoing.destroy(); }
  });
}
