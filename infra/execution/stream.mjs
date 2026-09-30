import { createHmac, timingSafeEqual } from 'node:crypto';
import { validId } from './store.mjs';

export function issueSubscription(key, ids, origin, now = Date.now()) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 30 || ids.some(id => !validId(id))) throw new Error('Invalid subscription');
  const payload = Buffer.from(JSON.stringify({ ids: [...new Set(ids)], origin, expiresAt: now + 120000 })).toString('base64url');
  const signature = createHmac('sha256', key).update(`execution-stream:${payload}`).digest('base64url');
  return { token: `${payload}.${signature}`, expiresAt: now + 120000 };
}
export function verifySubscription(key, token, origin, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 6000) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  const expected = createHmac('sha256', key).update(`execution-stream:${payload}`).digest('base64url');
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (claims.origin !== origin || claims.expiresAt <= now || !Array.isArray(claims.ids) || claims.ids.length > 30 || claims.ids.some(id => !validId(id))) return null;
    return claims;
  } catch { return null; }
}
export async function serveEvents(req, res, store, claims) {
  if (store.listenerCount('event') >= 200) { res.writeHead(503, { 'retry-after': '5' }); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'access-control-allow-origin': claims.origin, vary: 'Origin' });
  const ids = new Set(claims.ids), seen = new Map();
  let ended = false;
  const send = event => {
    if (ended || !ids.has(event.executionId) || (seen.get(event.executionId) || 0) >= event.seq) return;
    if (res.writableLength > 256000) { res.end(); return; }
    seen.set(event.executionId, event.seq);
    const message = { ...event }; delete message.events;
    res.write(`id: ${event.executionId}:${event.seq}\ndata: ${JSON.stringify(message)}\n\n`);
  };
  store.on('event', send);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  const expiry = setTimeout(() => res.end(), Math.max(1, claims.expiresAt - Date.now()));
  const cleanup = () => { ended = true; store.off('event', send); clearInterval(heartbeat); clearTimeout(expiry); };
  res.on('close', cleanup);
  try { for (const id of ids) { const record = await store.read(id); if (record) send(record); } }
  catch { cleanup(); res.end(); }
}
