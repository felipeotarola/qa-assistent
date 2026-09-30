import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { chromium } from 'playwright-core';
import WebSocket, { WebSocketServer } from 'ws';

const key = process.env.BROWSER_SERVICE_KEY;
const base = process.env.BROWSER_PUBLIC_URL;
if (!key || key.length < 32 || !base) throw new Error('Configure service key and public URL');
const viewer = await readFile(new URL('./viewer.html', import.meta.url));
const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
const maxSessions = Number(process.env.BROWSER_MAX_SESSIONS || 3);
if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 20) throw new Error('BROWSER_MAX_SESSIONS must be between 1 and 20');
const sessions = new Map();
let starting = 0;
const privateNetworks = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4]]) privateNetworks.addSubnet(address, prefix);
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) privateNetworks.addSubnet(address, prefix, 'ipv6');
async function publicDestination(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return false;
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
    for (const ws of current.sockets) ws.terminate();
    try {
      await current.context.close().catch(() => {});
      await rm(current.dir, { recursive: true, force: true });
    } finally { sessions.delete(current.id); }
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
    if (url.pathname === '/viewer' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors http://localhost:3000 http://127.0.0.1:3000 https://qa-assistent.vercel.app" });
      return res.end(viewer);
    }
    if (!matches(req.headers.authorization, `Bearer ${key}`)) return reply(res, 401, { error: 'Unauthorized' });
    if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ready: true, active: sessions.size > 0, activeSessions: sessions.size, startingSessions: starting, maxSessions });
    if (req.method === 'POST' && url.pathname === '/sessions') {
      if (starting + sessions.size >= maxSessions) return reply(res, 409, { error: 'Browser capacity reached. Retry after a session finishes.', maxSessions });
      starting++;
      let dir, context;
      try {
        dir = await mkdtemp('/tmp/qa-browser-');
        context = await chromium.launchPersistentContext(dir, { headless: true, chromiumSandbox: true, viewport: { width: 1280, height: 900 }, acceptDownloads: false, args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] });
        await context.route('**/*', async route => await publicDestination(route.request().url()) ? route.continue() : route.abort('blockedbyclient'));
        await context.routeWebSocket('**/*', async route => { if (await publicDestination(route.url())) route.connectToServer(); else route.close(); });
        const [port, debuggerPath] = (await readFile(`${dir}/DevToolsActivePort`, 'utf8')).trim().split('\n');
        if (!/^\d+$/.test(port) || !debuggerPath?.startsWith('/devtools/browser/')) throw new Error('Invalid Chromium endpoint');
        const session = { id: randomUUID(), token: randomBytes(32).toString('hex'), viewerToken: randomBytes(32).toString('hex'), expiresAt: Date.now() + 1800_000, control: 'agent', context, dir, endpoint: `ws://127.0.0.1:${port}${debuggerPath}`, sockets: new Set() };
        sessions.set(session.id, session);
        context.on('close', () => { void close(session).catch(() => {}); });
        const wsBase = base.replace(/^http/, 'ws');
        return reply(res, 201, { sessionId: session.id, connectUrl: `${wsBase}/cdp/${session.id}?token=${session.token}`, liveUrl: `${base}/viewer#${session.id}:${session.viewerToken}`, expiresAt: new Date(session.expiresAt).toISOString() });
      } catch (error) {
        await context?.close().catch(() => {});
        if (dir) await rm(dir, { recursive: true, force: true });
        console.error('Browser launch failed:', error.message);
        return reply(res, 503, { error: 'Browser launch failed' });
      } finally { starting--; }
    }
    const match = url.pathname.match(/^\/sessions\/([\w-]+)(?:\/(human|agent))?$/);
    const session = match && sessions.get(match[1]);
    if (!session || session.closing) return reply(res, 404, { error: 'Session not found' });
    if (req.method === 'DELETE') { await close(session); return reply(res, 200, { closed: true }); }
    if (req.method === 'POST' && match[2]) { session.control = match[2]; return reply(res, 200, { control: session.control }); }
    reply(res, 405, { error: 'Method not allowed' });
  } catch { reply(res, 500, { error: 'Browser service failed' }); }
});
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, base);
  const current = sessions.get(url.pathname.split('/')[2]);
  const isCdp = current && url.pathname === `/cdp/${current.id}` && matches(url.searchParams.get('token'), current.token);
  const isViewer = current && url.pathname === `/view/${current.id}` && matches(url.searchParams.get('token'), current.viewerToken) && req.headers.origin === new URL(base).origin;
  if (!current || current.closing || current.expiresAt <= Date.now() || (!isCdp && !isViewer)) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  sockets.handleUpgrade(req, socket, head, ws => {
    current.sockets.add(ws);
    ws.on('close', () => current.sockets.delete(ws));
    ws.on('error', () => {});
    if (isCdp) {
      const upstream = new WebSocket(current.endpoint);
      const pending = [];
      ws.on('message', data => upstream.readyState === WebSocket.OPEN ? upstream.send(data.toString()) : pending.push(data.toString()));
      upstream.on('open', () => { for (const data of pending) upstream.send(data); });
      upstream.on('message', data => { if (ws.readyState === WebSocket.OPEN) ws.send(data.toString()); });
      upstream.on('close', () => ws.close());
      upstream.on('error', () => ws.close());
      ws.on('close', () => upstream.close());
      return;
    }
    // One sequential capture per viewer. No stored screenshots or input logs here.
    let timer, queue = Promise.resolve();
    const frame = async () => {
      if (ws.readyState !== WebSocket.OPEN || sessions.get(current.id) !== current || current.closing) return;
      try {
        const page = await pageFor(current);
        if (page) send(ws, { type: 'frame', image: (await page.screenshot({ type: 'jpeg', quality: 65, timeout: 3000 })).toString('base64'), control: current.control });
      } catch { /* A navigation can briefly prevent capture. */ }
      if (ws.readyState === WebSocket.OPEN) timer = setTimeout(frame, 250);
    };
    void frame();
    ws.on('close', () => clearTimeout(timer));
    ws.on('message', data => {
      if (data.length > 64 * 1024) { ws.close(1009); return; }
      if (current.control !== 'human') return;
      let input;
      try { input = JSON.parse(data.toString()); } catch { return; }
      queue = queue.then(async () => {
        if (sessions.get(current.id) !== current || current.closing || current.control !== 'human') return;
        const page = await pageFor(current);
        if (!page) return;
        if (input.type === 'click' && Number.isFinite(input.x) && Number.isFinite(input.y)) await page.mouse.click(Math.max(0, Math.min(1279, input.x)), Math.max(0, Math.min(899, input.y)));
        if (input.type === 'text' && typeof input.text === 'string' && input.text.length <= 10000) await page.keyboard.insertText(input.text);
        if (input.type === 'key' && ['Enter', 'Tab', 'Shift+Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Control+a'].includes(input.key)) await page.keyboard.press(input.key);
        if (input.type === 'wheel' && Number.isFinite(input.y)) await page.mouse.wheel(0, Math.max(-1000, Math.min(1000, input.y)));
      }).catch(() => {});
    });
  });
});
setInterval(() => { for (const session of sessions.values()) if (session.expiresAt <= Date.now()) void close(session).catch(() => {}); }, 10000).unref();
process.on('SIGTERM', async () => { await Promise.allSettled([...sessions.values()].map(close)); server.close(); process.exit(0); });
server.listen(8080, '0.0.0.0');
