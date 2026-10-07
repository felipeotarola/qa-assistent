import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import http from 'node:http';
import { createExtraSite, extraSiteRevision, fakeAccount } from './fixtures/browser-variants-extra-site.mjs';

// Ephemeral loopback HTTP unit fixture; not the owned application, browser or
// WSL deployment. No model/browser execution or cookie injection is claimed.
let now = Date.parse('2026-10-05T12:00:00Z'), origin;
const adminToken = 'fixture-administrator-test-only-token';
const server = createExtraSite({ adminToken, now: () => now });
assert.equal(server.listening, false);
before(async () => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`; });
after(async () => { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; });
async function request(path, { host = 'qa-auth.test', ...options } = {}) {
  return new Promise((resolve, reject) => {
    const sent = http.request(origin + path, { method: options.method || 'GET', headers: { ...options.headers, host }, signal: AbortSignal.timeout(3000) }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString(), headers: { get: name => Array.isArray(response.headers[name]) ? response.headers[name][0] : response.headers[name] } }));
    });
    sent.on('error', reject); sent.end(options.body);
  });
}
async function loginForm() {
  const form = await request('/login'); assert.equal(form.status, 200);
  assert.equal(form.headers.get('referrer-policy'), 'same-origin');
  return { csrf: form.body.match(/name="csrf" value="([a-f0-9]+)"/)[1], cookie: form.headers.get('set-cookie').split(';')[0] };
}
const login = (form, changed = {}) => request('/login', { method: 'POST', headers: { origin: 'http://qa-auth.test', cookie: form.cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ csrf: form.csrf, email: fakeAccount.email, password: fakeAccount.password, ...changed }).toString() });

test('version A has a broken return; immutable version B fixes only that flow while contact data stays the same', async () => {
  for (const version of ['a', 'b']) {
    const article = await request(`/regression/${version}/article`, { host: 'qa-regression.test' });
    assert.equal(article.status, 200); assert.equal(article.headers.get('x-fixture-sha256'), extraSiteRevision);
    const path = article.body.match(/href="([^"]+)"/)[1], returned = await request(path, { host: 'qa-regression.test' });
    assert.equal(returned.status, version === 'a' ? 404 : 200);
    const contact = await request(`/regression/${version}/contact`, { host: 'qa-regression.test' });
    assert.equal(contact.status, 200); assert.match(contact.body, /besok@linden.example.test/);
    assert.match(contact.body, new RegExp(`Webbversion ${version.toUpperCase()}`));
  }
});

test('actual HTTP login requires form POST and issues a cookie whose next request reaches the protected profile', async () => {
  const anonymous = await request('/account'); assert.equal(anonymous.status, 303); assert.equal(anonymous.headers.get('location'), '/login');
  assert.doesNotMatch(anonymous.body, /LINDEN-1042|Elin Exempel/);
  const form = await loginForm(), accepted = await login(form);
  assert.equal(accepted.status, 303); assert.equal(accepted.headers.get('location'), '/account');
  const cookie = accepted.headers.get('set-cookie'); assert.match(cookie, /HttpOnly; SameSite=Strict; Max-Age=1200/);
  const profile = await request('/account', { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(profile.status, 200); for (const text of ['Min profil', fakeAccount.name, fakeAccount.email, fakeAccount.membership]) assert.ok(profile.body.includes(text));
  assert.equal((await request('/account')).status, 303, 'Another session must remain unauthenticated');
  const audit = await request('/__fixture/audit', { headers: { 'x-fixture-administrator': adminToken } });
  const events = JSON.parse(audit.body).events, granted = events.find(row => row.kind === 'login' && row.accepted), read = events.find(row => row.kind === 'account_read' && row.authenticated);
  assert.equal(granted.method, 'POST'); assert.equal(granted.status, 303); assert.equal(read.method, 'GET'); assert.equal(read.sessionHash, granted.sessionHash); assert.equal(read.cookiePresent, true);
  assert.doesNotMatch(audit.body, new RegExp(fakeAccount.password)); assert.ok(!audit.body.includes(cookie.split(';')[0].split('=')[1]) && !audit.body.includes(form.csrf));
});

test('GET/query, wrong credentials, missing CSRF and cross-origin POST never establish login', async () => {
  const query = await request(`/login?email=${fakeAccount.email}&password=wrong`); assert.equal(query.status, 200); assert.ok(!query.headers.get('set-cookie').includes('linden_session'));
  assert.equal((await login(await loginForm(), { password: 'wrong' })).status, 401);
  assert.equal((await login(await loginForm(), { csrf: 'forged' })).status, 403);
  const form = await loginForm();
  for (const origin of ['http://other.test', 'null']) assert.equal((await request('/login', { method: 'POST', headers: { origin, cookie: form.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...form, ...fakeAccount }).toString() })).status, 403);
  assert.equal((await request('/account')).status, 303);
});

test('cookie expiration denies profile and private receipt/source endpoints do not leak to browser callers', async () => {
  const accepted = await login(await loginForm()), cookie = accepted.headers.get('set-cookie').split(';')[0];
  now += 1200_001; assert.equal((await request('/account', { headers: { cookie } })).status, 303);
  for (const path of ['/__fixture/audit', '/oracle.json', '/browser-variants-extra-site.mjs', '/.env']) {
    const denied = await request(path); assert.equal(denied.status, 404); assert.doesNotMatch(denied.body, /sessionHash|known_working|Local-fixture/);
  }
  assert.equal((await request('/account', { host: 'unrelated.test' })).status, 400);
});
