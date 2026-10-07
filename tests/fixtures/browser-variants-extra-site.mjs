import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

// A separate immutable deployment: changing WEB04/AUTH09 must never change the
// already running WEB02/03 fixture or its source hash. No private oracle import.
export const extraSiteRevision = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
export const regressionOrigin = 'http://qa-regression.test';
export const authOrigin = 'http://qa-auth.test';
export const fakeAccount = Object.freeze({ email: 'elin.fixture@example.test', password: 'Local-fixture-only-37!', name: 'Elin Exempel', membership: 'LINDEN-1042' });
const digest = value => createHash('sha256').update(value).digest('hex');
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const html = (title, body) => `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} | Linden</title><style>body{font:18px/1.6 system-ui;margin:32px auto;padding:24px;max-width:700px;color:#24302b;background:#fafaf7}a{color:#14533f}label,input,button{display:block;margin:12px 0}input,button{font:inherit;padding:8px}a:focus-visible,input:focus-visible,button:focus-visible{outline:3px solid #945400}small{display:block;margin-top:40px}</style></head><body><header>Lindens kulturhus</header><main><h1>${title}</h1>${body}</main></body></html>`;
const page = (status, title, body, headers = {}) => ({ status, body: html(title, body), headers });
const cookies = header => new Map(String(header || '').split(';').map(part => part.trim().split(/=(.*)/s)).filter(pair => pair.length >= 2));
export function createExtraSiteState({ adminToken, now = () => Date.now() } = {}) {
  if (typeof adminToken !== 'string' || adminToken.length < 32) throw new Error('Explicit private fixture administrator token required');
  return { adminToken, now, sessions: new Map(), nonces: new Map(), events: [] };
}

/** Pure request routing supports negative tests without listening or touching a
 * browser. Receipts contain no passwords, cookie values, CSRF tokens or bodies. */
export function extraSiteRequest(request, state) {
  const host = request.headers?.host, method = request.method, url = new URL(request.url, `http://${host}`);
  if (![new URL(regressionOrigin).host, new URL(authOrigin).host].includes(host) || !request.url.startsWith('/') || request.url.startsWith('//')) return page(400, 'Ogiltig adress', '');
  if (url.pathname === '/__fixture/audit') {
    if (method !== 'GET' || !safeEqual(request.headers['x-fixture-administrator'], state.adminToken)) return page(404, 'Sidan finns inte', '');
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: extraSiteRevision, events: state.events }) };
  }
  if (host === new URL(regressionOrigin).host) {
    if (!['GET', 'HEAD'].includes(method)) return page(405, 'Metoden stöds inte', '');
    const found = url.pathname.match(/^\/regression\/(a|b)(?:\/(article|contact|missing))?$/);
    if (!found || url.search) return page(404, 'Sidan finns inte', '');
    const [, version, route] = found, base = `/regression/${version}`;
    const stamp = `<small>Webbversion ${version.toUpperCase()}</small>`;
    if (!route) return page(200, 'Besöksinformation', `<nav><a href="${base}/article">Låna böcker</a> · <a href="${base}/contact">Kontakt</a></nav>${stamp}`);
    if (route === 'article') return page(200, 'Låna böcker', `<p>Lån gäller i fyra veckor.</p><a href="${base}${version === 'a' ? '/missing' : ''}">Tillbaka till besöksinformation</a>${stamp}`);
    if (route === 'contact') return page(200, 'Kontakt', `<p>Kontakta oss på besok@linden.example.test.</p><a href="${base}">Besöksinformation</a>${stamp}`);
    return page(404, 'Sidan finns inte', `<p>Adressen saknas.</p>${stamp}`);
  }
  const at = new Date(state.now()).toISOString(), jar = cookies(request.headers.cookie), session = state.sessions.get(jar.get('linden_session'));
  const valid = session && session.expiresAt > state.now();
  const record = event => { if (state.events.length >= 1000) throw new Error('Fixture receipt budget exhausted'); state.events.push({ sequence: state.events.length + 1, at, host, ...event }); };
  if (url.pathname === '/account' && ['GET', 'HEAD'].includes(method)) {
    record({ kind: 'account_read', method, authenticated: !!valid, cookiePresent: jar.has('linden_session'), sessionHash: valid ? session.hash : null, status: valid ? 200 : 303, location: valid ? null : '/login' });
    return valid ? page(200, 'Min profil', `<dl><dt>Namn</dt><dd>${fakeAccount.name}</dd><dt>E-post</dt><dd>${fakeAccount.email}</dd><dt>Medlemsnummer</dt><dd>${fakeAccount.membership}</dd></dl>`) : page(303, 'Inloggning krävs', '<a href="/login">Logga in</a>', { location: '/login' });
  }
  if (url.pathname === '/login' && ['GET', 'HEAD'].includes(method)) {
    const nonce = randomBytes(24).toString('hex'); state.nonces.set(nonce, state.now() + 300_000);
    return page(200, 'Logga in', `<p>Logga in för att se din medlemsprofil.</p><form action="/login" method="post"><input type="hidden" name="csrf" value="${nonce}"><label for="email">E-post</label><input id="email" name="email" type="email" autocomplete="username" required><label for="password">Lösenord</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Logga in</button></form>`, { 'set-cookie': `linden_csrf=${nonce}; Path=/; HttpOnly; SameSite=Strict; Max-Age=300` });
  }
  if (url.pathname === '/login' && method === 'POST') {
    const form = new URLSearchParams(request.body || ''), csrf = form.get('csrf'), nonce = jar.get('linden_csrf');
    const origin = request.headers.origin;
    if (origin !== authOrigin || !String(request.headers['content-type']).startsWith('application/x-www-form-urlencoded') || !nonce || !safeEqual(csrf, nonce) || (state.nonces.get(nonce) ?? 0) <= state.now()) {
      record({ kind: 'login', method, accepted: false, status: 403, reason: 'csrf_or_origin', sessionHash: null }); return page(403, 'Inloggningen kunde inte genomföras', 'Ladda formuläret igen.');
    }
    state.nonces.delete(nonce);
    if (!safeEqual(form.get('email'), fakeAccount.email) || !safeEqual(form.get('password'), fakeAccount.password)) {
      record({ kind: 'login', method, accepted: false, status: 401, reason: 'credentials', sessionHash: null }); return page(401, 'Inloggningen misslyckades', '<a href="/login">Försök igen</a>');
    }
    const token = randomBytes(32).toString('hex'), sessionHash = digest(token); state.sessions.set(token, { hash: sessionHash, expiresAt: state.now() + 1200_000 });
    record({ kind: 'login', method, accepted: true, status: 303, location: '/account', sessionHash });
    return page(303, 'Inloggad', '<a href="/account">Min profil</a>', { location: '/account', 'set-cookie': `linden_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1200` });
  }
  return page(['GET', 'HEAD'].includes(method) ? 404 : 405, 'Sidan finns inte', '');
}

export function createExtraSite(options) {
  const state = createExtraSiteState(options);
  return http.createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 8192) throw new Error('Request too large'); }
      const selected = extraSiteRequest({ method: request.method, url: request.url, headers: request.headers, body }, state);
      response.writeHead(selected.status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(selected.body), 'cache-control': 'no-store',
        // Chromium sends Origin:null for a form POST under no-referrer. Keep
        // exact same-origin + nonce checks without permitting opaque origins.
        'x-fixture-sha256': extraSiteRevision, 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", ...selected.headers });
      response.end(request.method === 'HEAD' ? undefined : selected.body);
    } catch { response.writeHead(400); response.end(); }
  });
}
