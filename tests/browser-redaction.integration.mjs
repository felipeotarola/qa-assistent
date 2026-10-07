import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { browserPolicyDigest } from '../infra/browser/policy.mjs';

// Run only after the owned isolated Linux browser image has been rebuilt. No
// app DB, model, production endpoint or persistent dictionary is involved.
const base = process.env.BROWSER_SERVICE_URL, key = process.env.BROWSER_SERVICE_KEY;
assert.equal(base, 'http://127.0.0.1:58092');
assert.ok(process.env.PAT_RUNTIME_SCOPE?.startsWith('autonomy-test:'));
assert.ok(key?.length >= 32);
let session, browser;
const passed = [];
async function request(path, body, token = key, method = 'POST') {
  const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
async function targetId(page) {
  const cdp = await page.context().newCDPSession(page);
  try { return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; }
  finally { await cdp.detach(); }
}
try {
  const policy = { version: 1, readOnly: true, allowedOrigins: ['http://qa-fixture.test'], deadlineAt: new Date(Date.now() + 120000).toISOString() };
  const expectedPolicyDigest = browserPolicyDigest(policy);
  const created = await request('/sessions', { policy });
  assert.equal(created.status, 201); session = created.data;
  const path = `/sessions/${session.sessionId}`;
  assert.equal((await request(`${path}/redaction`, { expectedPolicyDigest, values: ['private-echo'] }, 'not-service-key')).status, 401);
  assert.equal((await request(`${path}/redaction`, { expectedPolicyDigest: 'wrong', values: ['private-echo'] })).status, 409);
  const registered = await request(`${path}/redaction`, { expectedPolicyDigest, values: ['private-echo'] });
  assert.equal(registered.status, 200); assert.equal(registered.data.redaction.registeredCount, 1);
  assert.equal(JSON.stringify(registered.data).includes('private-echo'), false);
  passed.push('Only authenticated policy-matching callers can register, and receipts contain no values');

  browser = await chromium.connectOverCDP(session.connectUrl);
  let page = browser.contexts()[0].pages()[0];
  await page.setContent('<title>private-echo</title><h1>private-echo</h1><p>private-echo</p><input value="current-private-value">');
  let target = await targetId(page);
  const second = await browser.contexts()[0].newPage();
  await second.setContent('<h1>Other tab</h1>'); await second.bringToFront();
  const observed = await request(`${path}/observation`, { expectedPolicyDigest, targetId: target });
  assert.equal(observed.status, 200); assert.equal(observed.data.redaction.targetId, target);
  assert.equal(observed.data.observation.title, '[REDACTED]');
  assert.equal(JSON.stringify(observed.data).includes('private-echo'), false);
  assert.equal(observed.data.redaction.registeredCount, 2);
  assert.equal((await request(`${path}/observation`, { expectedPolicyDigest, targetId: 'missing-target' })).status, 404);
  passed.push('Two-tab observation binds the exact target and auto-registers current fields, with no foreground fallback');

  await page.goto('about:blank');
  await page.setContent('<h1>After navigation</h1><p>private-echo current-private-value</p>');
  await browser.close(); browser = null;
  browser = await chromium.connectOverCDP(session.connectUrl);
  // Identity is read afresh after the app's CDP connection was replaced.
  const pages = browser.contexts()[0].pages();
  page = null;
  for (const candidate of pages) if ((await targetId(candidate)) === target) page = candidate;
  assert.ok(page, 'The original physical page must survive app reconnection');
  target = await targetId(page);
  const recovered = await request(`${path}/observation`, { expectedPolicyDigest, targetId: target });
  assert.equal(recovered.status, 200); assert.match(recovered.data.observation.text, /After navigation/);
  assert.equal(JSON.stringify(recovered.data).includes('private-echo'), false);
  assert.equal(JSON.stringify(recovered.data).includes('current-private-value'), false);
  const status = await request(path, undefined, key, 'GET');
  assert.equal(JSON.stringify(status.data).includes('private-echo'), false);
  assert.equal('redaction' in status.data, false);
  passed.push('Session-owned redaction survives navigation and a replaced app CDP connection without entering snapshots');

  const long = 'private-long-'.repeat(650);
  assert.equal((await request(`${path}/redaction`, { expectedPolicyDigest, values: [long] })).status, 200);
  await page.setContent('<p id="echo"></p>'); await page.locator('#echo').evaluate((node, value) => { node.textContent = value; }, long);
  const longResult = await request(`${path}/observation`, { expectedPolicyDigest, targetId: target });
  assert.equal(longResult.status, 200); assert.equal(longResult.data.observation.text, '[REDACTED]');
  assert.equal(JSON.stringify(longResult.data).includes('private-long-'), false);
  const overflow = await request(`${path}/redaction`, { expectedPolicyDigest, values: Array.from({ length: 64 }, (_, n) => `overflow-${n}`) });
  assert.equal(overflow.status, 413);
  assert.equal((await request(`${path}/redaction`, { expectedPolicyDigest, values: [] })).data.redaction.registeredCount, 3);
  passed.push('Long exact echoes are redacted before truncation; excess registration fails atomically');

  assert.equal((await request(`${path}/human`, {})).status, 200);
  assert.equal((await request(`${path}/observation`, { expectedPolicyDigest, targetId: target })).status, 409);
  assert.equal((await request(`${path}/redaction`, { expectedPolicyDigest, values: ['human-owned'] })).status, 409);
  passed.push('Human control fences registration and observation');
  await request(path, undefined, key, 'DELETE'); session = null;
  assert.equal((await request(`${path}/observation`, { expectedPolicyDigest, targetId: target })).status, 404);
  passed.push('Closing the physical session makes its dictionary and observations inaccessible');

  const shortPolicy = { ...policy, deadlineAt: new Date(Date.now() + 1500).toISOString() };
  const short = await request('/sessions', { policy: shortPolicy });
  assert.equal(short.status, 201); session = short.data;
  await delay(Math.max(0, Date.parse(shortPolicy.deadlineAt) - Date.now()) + 20);
  const expired = await request(`/sessions/${session.sessionId}/redaction`, { expectedPolicyDigest: browserPolicyDigest(shortPolicy), values: ['expired-value'] });
  assert.ok([404, 409].includes(expired.status));
  passed.push('The physical policy deadline independently blocks late registration');
  console.log(JSON.stringify({ passed: passed.length, checks: passed }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  if (session) await request(`/sessions/${session.sessionId}`, undefined, key, 'DELETE');
}
