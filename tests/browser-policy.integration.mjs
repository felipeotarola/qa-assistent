import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { assertIsolatedDatabaseUrl } from './helpers/autonomy-isolation.mjs';
import { browserPolicyDigest } from '../infra/browser/policy.mjs';

// Actual isolated browser service and Chromium, no model, fake route or app.
assertIsolatedDatabaseUrl(process.env.DATABASE_URL);
assert.match(process.env.PAT_RUNTIME_SCOPE || '', /^autonomy-test:/);
assert.equal(process.env.BROWSER_SERVICE_URL, 'http://127.0.0.1:58092');
assert.ok(process.env.BROWSER_SERVICE_KEY);
const origin = process.env.BROWSER_SERVICE_URL;
const headers = { authorization: `Bearer ${process.env.BROWSER_SERVICE_KEY}`, 'content-type': 'application/json' };
const policy = { version: 1, allowedOrigins: ['http://qa-fixture.test'], readOnly: true, deadlineAt: new Date(Date.now() + 120000).toISOString() };
let browser, session;
const passed = [];
async function request(path, body, method = 'POST') {
  const response = await fetch(origin + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  return { status: response.status, data: await response.json() };
}
try {
  assert.equal((await request('/sessions', { policy: { ...policy, readOnly: false } })).status, 400);
  const response = await request('/sessions', { policy });
  assert.equal(response.status, 201); session = response.data;
  assert.equal(session.policyVersion, 1); assert.equal(session.policyDigest, browserPolicyDigest(policy));
  assert.equal((await request(`/sessions/${session.sessionId}`, undefined, 'GET')).data.policyDigest, session.policyDigest);
  passed.push('Service validates policy and attests its exact digest on creation and subsequent status');
  browser = await chromium.connectOverCDP(session.connectUrl);
  let page = browser.contexts()[0].pages()[0];
  assert.equal((await page.goto('http://qa-fixture.test')).status(), 200);
  await page.getByRole('link', { name: 'Produkter', exact: true }).click();
  assert.equal(new URL(page.url()).pathname, '/products');
  passed.push('Allowed navigation works through actual Chromium');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(await page.evaluate(async method => { try { await fetch('/test-write', { method, body: 'fixture-test' }); return 'sent'; } catch { return 'blocked'; } }, method), 'blocked');
  }
  await assert.rejects(page.goto('https://example.com', { timeout: 10000 }), /ERR_|Navigation/);
  await page.close(); page = await browser.contexts()[0].newPage();
  await page.goto('http://qa-fixture.test');
  assert.equal(await page.evaluate(async () => { try { await fetch('http://10.254.254.254:9'); return 'sent'; } catch { return 'blocked'; } }), 'blocked');
  assert.equal(await page.evaluate(() => new Promise(resolve => { const socket = new WebSocket('ws://qa-fixture.test'); socket.onopen = () => resolve('opened'); socket.onclose = () => resolve('blocked'); socket.onerror = () => resolve('blocked'); })), 'blocked');
  assert.equal(await page.evaluate(async () => { try { await navigator.serviceWorker.register('/worker.js'); return 'registered'; } catch { return 'blocked'; } }), 'blocked');
  passed.push('Writes, out-of-scope navigation, private destinations, WebSocket and service workers are blocked');

  await page.evaluate(() => { window.__policyProof = 'pending'; setTimeout(() => { fetch('/after-disconnect', { method: 'POST', body: 'fixture' }).then(() => { window.__policyProof = 'sent'; }).catch(() => { window.__policyProof = 'blocked'; }); }, 500); });
  await browser.close(); browser = undefined;
  await delay(1500);
  browser = await chromium.connectOverCDP(session.connectUrl); page = browser.contexts()[0].pages()[0];
  assert.equal(await page.evaluate(() => window.__policyProof), 'blocked');
  assert.equal((await request(`/sessions/${session.sessionId}`, undefined, 'GET')).data.policyDigest, session.policyDigest);
  passed.push('Browser-owned policy persists while the app/CDP client is disconnected and after reconnection');
  await browser.close(); browser = undefined;
  await request(`/sessions/${session.sessionId}`, undefined, 'DELETE'); session = undefined;

  const ordinary = await request('/sessions', {}); assert.equal(ordinary.status, 201); session = ordinary.data;
  browser = await chromium.connectOverCDP(session.connectUrl); page = browser.contexts()[0].pages()[0];
  assert.equal((await page.goto('https://example.com')).status(), 200);
  assert.equal(session.policyDigest, undefined);
  passed.push('Ordinary interactive sessions and a genuine public URL retain existing behavior');
  console.log(JSON.stringify({ status: 'passed', passed, service: 'actual isolated browser service', browser: 'actual Chromium', model: false }));
} finally {
  await browser?.close().catch(() => {});
  if (session) await request(`/sessions/${session.sessionId}`, undefined, 'DELETE');
}
