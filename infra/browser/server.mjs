import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { chromium } from 'playwright-core';
import WebSocket, { WebSocketServer } from 'ws';
import { FrameHub } from './frame-hub.mjs';
import { ExecutionStore } from '../execution/store.mjs';
import { issueSubscription, verifySubscription, serveEvents } from '../execution/stream.mjs';
import { readJson, allowedOrigins, frameAncestorsPolicy } from '../execution/http.mjs';
import { parseBrowserPolicy, browserPolicyDigest, admitBrowserRequest, humanInputAllowed } from './policy.mjs';
import { SessionRedaction, RedactionError, requireRedactionSession, readRedactionObservation, redactionPage } from './redaction.mjs';

const key = process.env.BROWSER_SERVICE_KEY;
const base = process.env.BROWSER_PUBLIC_URL;
if (!key || key.length < 32 || !base) throw new Error('Configure service key and public URL');
const viewer = await readFile(new URL('./viewer.html', import.meta.url));
const viewerPolicy = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; ${frameAncestorsPolicy()}`;
const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
const maxSessions = Number(process.env.BROWSER_MAX_SESSIONS || 3);
if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 20) throw new Error('BROWSER_MAX_SESSIONS must be between 1 and 20');
const sessions = new Map();
// Only an assigned preview worker gets this exact, numeric container origin.
const previewOrigin = process.env.BROWSER_PREVIEW_ORIGIN || '';
if (previewOrigin && !/^http:\/\/172\.30\.0\.\d{1,3}:\d{2,5}$/.test(previewOrigin)) throw new Error('Invalid assigned preview origin');
const events = new ExecutionStore(`${process.env.BROWSER_DATA || '/tmp/qa-browser-state'}/events`);
const snapshot = session => ({ id: session.id, status: session.closing ? 'closed' : 'ready', control: session.control, controlEpoch: session.controlEpoch, expiresAt: new Date(session.expiresAt).toISOString(), ...(session.policy ? { policyVersion: 1, policyDigest: browserPolicyDigest(session.policy) } : {}), telemetry: { workerId: 'vps-browser', heartbeatAt: new Date().toISOString() } });
const publish = (session, type) => events.publish(session.id, 'browser', type, snapshot(session));
let starting = 0;
const privateNetworks = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4]]) privateNetworks.addSubnet(address, prefix);
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) privateNetworks.addSubnet(address, prefix, 'ipv6');
async function publicDestination(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return false;
    if (previewOrigin && url.origin.replace(/^ws:/, 'http:') === previewOrigin && !url.username && !url.password) return true;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
    return addresses.length > 0 && addresses.every(a => !privateNetworks.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4'));
  } catch { return false; }
}
const matches = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const send = (ws, data) => { if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 2_000_000) ws.send(JSON.stringify(data)); };
async function close(current) {
  if (!current) return;
  if (current.closing) return current.closing;
  current.closing = (async () => {
    current.redaction?.clear();
    current.hub?.close();
    for (const ws of current.sockets) ws.terminate();
    try {
      await current.context.close().catch(() => {});
      await rm(current.dir, { recursive: true, force: true });
    } finally { sessions.delete(current.id); await publish(current, 'closed'); }
  })();
  return current.closing;
}
async function pageFor(current) {
  const pages = current.context.pages();
  for (const page of [...pages].reverse()) {
    if (await page.evaluate(() => document.visibilityState === 'visible').catch(() => false)) return page;
  }
  return pages.at(-1);
}
function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, base);
    if (url.pathname === '/events' && req.method === 'GET') {
      const claims = verifySubscription(key, url.searchParams.get('token'), req.headers.origin);
      if (!claims) return reply(res, 401, { error: 'Subscription expired or invalid' });
      return await serveEvents(req, res, events, claims);
    }
    if (url.pathname === '/viewer' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': viewerPolicy });
      return res.end(viewer);
    }
    if (!matches(req.headers.authorization, `Bearer ${key}`)) return reply(res, 401, { error: 'Unauthorized' });
    if (url.pathname === '/subscriptions' && req.method === 'POST') {
      const { ids, origin } = await readJson(req);
      if (!allowedOrigins().includes(origin)) return reply(res, 403, { error: 'Origin not permitted' });
      return reply(res, 200, issueSubscription(key, ids, origin));
    }
    if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ready: true, active: sessions.size > 0, activeSessions: sessions.size, startingSessions: starting, maxSessions });
    if (req.method === 'POST' && url.pathname === '/sessions') {
      let policy;
      try { policy = parseBrowserPolicy((await readJson(req)).policy); }
      catch { return reply(res, 400, { error: 'Invalid browser policy' }); }
      if (starting + sessions.size >= maxSessions) return reply(res, 409, { error: 'Browser capacity reached. Retry after a session finishes.', maxSessions });
      starting++;
      let dir, context, session;
      try {
        dir = await mkdtemp('/tmp/qa-browser-');
        context = await chromium.launchPersistentContext(dir, { headless: true, chromiumSandbox: true, viewport: { width: 1280, height: 900 }, acceptDownloads: false, ...(policy ? { serviceWorkers: 'block' } : {}), args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] });
        await context.route('**/*', async route => {
          const request = route.request();
          const allowed = await admitBrowserRequest(policy, { url: request.url(), method: request.method(), navigation: request.isNavigationRequest() },
            () => session && ({ control: session.control, controlEpoch: session.controlEpoch, closing: !!session.closing, expiresAt: session.expiresAt }), publicDestination);
          if (allowed) await route.continue();
          else await route.abort('blockedbyclient');
        });
        await context.routeWebSocket('**/*', async route => { if (!policy && await publicDestination(route.url())) route.connectToServer(); else route.close(); });
        const [port, debuggerPath] = (await readFile(`${dir}/DevToolsActivePort`, 'utf8')).trim().split('\n');
        if (!/^\d+$/.test(port) || !debuggerPath?.startsWith('/devtools/browser/')) throw new Error('Invalid Chromium endpoint');
        session = { id: randomUUID(), token: randomBytes(32).toString('hex'), viewerToken: randomBytes(32).toString('hex'), controlToken: randomBytes(32).toString('hex'), expiresAt: Math.min(Date.now() + 1800_000, policy ? Date.parse(policy.deadlineAt) : Infinity), policy, redaction: new SessionRedaction(), control: 'agent', controlEpoch: 0, inputQueue: Promise.resolve(), pendingInputs: 0, context, dir, endpoint: `ws://127.0.0.1:${port}${debuggerPath}`, sockets: new Set(), cdpSockets: new Set() };
        session.hub = new FrameHub(async () => {
          const page = await pageFor(session);
          if (!page) throw new Error('No page');
          return (await page.screenshot({ type: 'jpeg', quality: 65, timeout: 3000 })).toString('base64');
        }, (ws, image) => send(ws, { type: 'frame', image, control: session.control, controlEpoch: session.controlEpoch }));
        sessions.set(session.id, session);
        context.on('close', () => { void close(session).catch(() => {}); });
        await publish(session, 'started');
        const wsBase = base.replace(/^http/, 'ws');
        return reply(res, 201, { sessionId: session.id, connectUrl: `${wsBase}/cdp/${session.id}?token=${session.token}`, liveUrl: `${base}/viewer#${session.id}:${session.viewerToken}`, expiresAt: new Date(session.expiresAt).toISOString(), ...(policy ? { policyVersion: 1, policyDigest: browserPolicyDigest(policy) } : {}) });
      } catch (error) {
        await context?.close().catch(() => {});
        if (dir) await rm(dir, { recursive: true, force: true });
        console.error('Browser launch failed:', error.message);
        return reply(res, 503, { error: 'Browser launch failed' });
      } finally { starting--; }
    }
    const match = url.pathname.match(/^\/sessions\/([\w-]+)(?:\/(human|agent|redaction|observation))?$/);
    const session = match && sessions.get(match[1]);
    if (!session || session.closing) return reply(res, 404, { error: 'Session not found' });
    if (['redaction', 'observation'].includes(match[2])) {
      if (req.method !== 'POST') return reply(res, 405, { error: 'Method not allowed' });
      let body;
      try { body = await readJson(req, 256 * 1024); }
      catch { return reply(res, 413, { error: 'Invalid redaction request' }); }
      const expected = match[2] === 'redaction' ? ['expectedPolicyDigest', 'values'] : ['expectedPolicyDigest', 'targetId'];
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(field => !expected.includes(field))) return reply(res, 400, { error: 'Invalid redaction request' });
      const epoch = session.controlEpoch;
      const digest = requireRedactionSession(session, body.expectedPolicyDigest, epoch);
      if (match[2] === 'redaction') {
        session.redaction.register(body.values);
        return reply(res, 200, { redaction: session.redaction.receipt(digest) });
      }
      const page = await redactionPage(session.context, body.targetId);
      requireRedactionSession(sessions.get(session.id), digest, epoch);
      const raw = await readRedactionObservation(page);
      // A human->agent round trip is also a new control epoch, not permission
      // to publish an observation begun before the handoff.
      requireRedactionSession(sessions.get(session.id), digest, epoch);
      const observation = session.redaction.observation(raw);
      return reply(res, 200, { observation, redaction: { ...session.redaction.receipt(digest), targetId: body.targetId } });
    }
    if (req.method === 'DELETE') { await close(session); return reply(res, 200, { closed: true }); }
    if (req.method === 'GET' && !match[2]) return reply(res, 200, snapshot(session));
    if (req.method === 'POST' && match[2]) {
      if (url.searchParams.get('scoped') === '1') session.scopedControl = true;
      session.control = match[2]; session.controlEpoch++;
      session.controlToken = randomBytes(32).toString('hex');
      if (session.control === 'human') for (const ws of session.cdpSockets) ws.terminate();
      await publish(session, 'control');
      return reply(res, 200, { control: session.control, controlEpoch: session.controlEpoch, liveUrl: `${base}/viewer#${session.id}:${session.control === 'human' ? session.controlToken : session.viewerToken}` });
    }
    reply(res, 405, { error: 'Method not allowed' });
  } catch (error) { reply(res, error instanceof RedactionError ? error.status : 500, { error: error instanceof RedactionError ? error.code : 'Browser service failed' }); }
});
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, base);
  const current = sessions.get(url.pathname.split('/')[2]);
  const isCdp = current && current.control === 'agent' && url.pathname === `/cdp/${current.id}` && matches(url.searchParams.get('token'), current.token);
  const isController = current && (matches(url.searchParams.get('token'), current.controlToken) || (!current.scopedControl && matches(url.searchParams.get('token'), current.viewerToken)));
  const isViewer = current && url.pathname === `/view/${current.id}` && (isController || matches(url.searchParams.get('token'), current.viewerToken)) && req.headers.origin === new URL(base).origin;
  if (!current || current.closing || current.expiresAt <= Date.now() || (!isCdp && !isViewer)) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  sockets.handleUpgrade(req, socket, head, ws => {
    current.sockets.add(ws);
    ws.on('close', () => current.sockets.delete(ws));
    ws.on('error', () => {});
    if (isCdp) {
      current.cdpSockets.add(ws);
      ws.on('close', () => current.cdpSockets.delete(ws));
      const upstream = new WebSocket(current.endpoint);
      const pending = [];
      ws.on('message', data => {
        if (current.control !== 'agent' || current.closing || pending.length > 100) { ws.close(); return; }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString()); else pending.push(data.toString());
      });
      upstream.on('open', () => { for (const data of pending) upstream.send(data); });
      upstream.on('message', data => { if (ws.readyState === WebSocket.OPEN) ws.send(data.toString()); });
      upstream.on('close', () => ws.close());
      upstream.on('error', () => ws.close());
      ws.on('close', () => upstream.close());
      return;
    }
    current.hub.add(ws);
    ws.on('close', () => current.hub.remove(ws));
    ws.on('message', data => {
      if (data.length > 64 * 1024) { ws.close(1009); return; }
      let input;
      try { input = JSON.parse(data.toString()); } catch { return; }
      if (input.type === 'visibility') { current.hub.visibility(ws, input.visible === true); return; }
      if (!isController || (current.scopedControl && !matches(url.searchParams.get('token'), current.controlToken)) || !humanInputAllowed(current, input.controlEpoch) || current.pendingInputs >= 32) return;
      current.pendingInputs++;
      current.inputQueue = current.inputQueue.then(async () => {
        if (sessions.get(current.id) !== current || !humanInputAllowed(current, input.controlEpoch)) return;
        const page = await pageFor(current);
        if (!page || sessions.get(current.id) !== current || !humanInputAllowed(current, input.controlEpoch)) return;
        if (input.type === 'click' && Number.isFinite(input.x) && Number.isFinite(input.y)) await page.mouse.click(Math.max(0, Math.min(1279, input.x)), Math.max(0, Math.min(899, input.y)));
        if (input.type === 'text' && typeof input.text === 'string' && input.text.length <= 10000) await page.keyboard.insertText(input.text);
        if (input.type === 'key' && ['Enter', 'Tab', 'Shift+Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Control+a'].includes(input.key)) await page.keyboard.press(input.key);
        if (input.type === 'wheel' && Number.isFinite(input.y)) await page.mouse.wheel(0, Math.max(-1000, Math.min(1000, input.y)));
      }).catch(() => {}).finally(() => { current.pendingInputs--; });
    });
  });
});
setInterval(() => { for (const session of sessions.values()) if (session.expiresAt <= Date.now()) void close(session).catch(() => {}); }, 10000).unref();
setInterval(() => { for (const session of sessions.values()) if (!session.closing) void publish(session, 'heartbeat').catch(() => {}); }, 10000).unref();
process.on('SIGTERM', async () => { await Promise.allSettled([...sessions.values()].map(close)); server.close(); process.exit(0); });
server.listen(8080, '0.0.0.0');
