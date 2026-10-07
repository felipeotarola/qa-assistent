import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserPolicyDigest } from '../infra/browser/policy.mjs';

// Prepared physical probe; run only in the parent's explicit empty browser
// window after installing the source-hashed browser image. No model or DB.
const base = process.env.BROWSER_SERVICE_URL, key = process.env.BROWSER_SERVICE_KEY;
assert.equal(base, 'http://127.0.0.1:58092');
assert.ok(process.env.PAT_RUNTIME_SCOPE?.startsWith('autonomy-test:')); assert.ok(key?.length >= 32);
assert.equal(process.env.SYNA_BROWSER_LINK_PROBE, 'explicit-stopped-window');
let session, browser;
const checks = [];
const request = async (path, body, method = 'POST') => {
  const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
};
const targetId = async page => { const cdp = await page.context().newCDPSession(page); try { return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; } finally { await cdp.detach(); } };
try {
  const policy = { version: 1, readOnly: true, allowedOrigins: ['http://qa-fixture.test'], deadlineAt: new Date(Date.now() + 90000).toISOString() };
  const expectedPolicyDigest = browserPolicyDigest(policy), created = await request('/sessions', { policy });
  assert.equal(created.status, 201); session = created.data; browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0], page = context.pages()[0], path = `/sessions/${session.sessionId}`;
  await page.setContent('<base href="http://qa-fixture.test/"><title>Link evidence</title><h1>Original page</h1><a href="/">Home</a><a href="/help?input=private-query#private-fragment">Help</a><a hidden href="/hidden">Hidden</a><a style="opacity:0" href="/invisible">Invisible</a><a href="/current-private">current-private</a><input value="current-private"><a href="javascript:alert(1)">Script</a>');
  const target = await targetId(page), other = await context.newPage();
  await other.setContent('<a href="http://qa-fixture.test/wrong-tab">Wrong tab</a>'); await other.bringToFront();
  const first = await request(`${path}/observation`, { expectedPolicyDigest, targetId: target });
  assert.equal(first.status, 200); assert.equal(first.data.redaction.targetId, target);
  assert.deepEqual(first.data.observation.linkObservation.links, [
    { label: 'Home', href: 'http://qa-fixture.test/' }, { label: 'Help', href: 'http://qa-fixture.test/help' },
    { label: '[REDACTED]', href: 'http://qa-fixture.test/[REDACTED]' },
  ]);
  assert.equal(first.data.observation.linkObservation.truncated, true); // unsupported JS href omitted
  assert.equal(JSON.stringify(first.data).includes('current-private'), false);
  assert.equal(JSON.stringify(first.data).includes('private-query'), false);
  checks.push('Actual Chromium exact page, visible DOM hrefs, hidden omission, URL sanitization and current-field redaction');
  await page.setContent(`<base href="http://qa-fixture.test/"><a href="/current-private">current-private</a>${Array.from({ length: 45 }, (_, i) => `<a href="/item-${i}">Item ${i}</a>`).join('')}`);
  await browser.close(); browser = await chromium.connectOverCDP(session.connectUrl);
  const after = await request(`${path}/observation`, { expectedPolicyDigest, targetId: target });
  assert.equal(after.status, 200); assert.equal(after.data.observation.linkObservation.links.length, 40);
  assert.equal(after.data.observation.linkObservation.truncated, true);
  assert.deepEqual(after.data.observation.linkObservation.links[0], { label: '[REDACTED]', href: 'http://qa-fixture.test/[REDACTED]' });
  checks.push('Bounded actual anchor list and private dictionary survive replacement app CDP connection');
  assert.equal((await request(`${path}/observation`, { expectedPolicyDigest, targetId: 'missing-target' })).status, 404);
  assert.equal((await request(`${path}/human`, {})).status, 200);
  assert.equal((await request(`${path}/observation`, { expectedPolicyDigest, targetId: target })).status, 409);
  checks.push('Missing target and human takeover cannot substitute an observation');
  console.log(JSON.stringify({ passed: checks.length, checks, browser: 'actual Chromium', source: 'synthetic DOM fixture', models: 0, databaseWrites: 0, production: false }));
} finally {
  await browser?.close().catch(() => {});
  if (session) { const removed = await request(`/sessions/${session.sessionId}`, undefined, 'DELETE'); assert.ok([200, 204, 404].includes(removed.status)); }
}
