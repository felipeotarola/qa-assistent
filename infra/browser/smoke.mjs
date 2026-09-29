// Run inside the service container when no user session is active.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
const base = 'http://127.0.0.1:8080';
const request = (path, method = 'GET', auth = true) => fetch(base + path, { method, headers: auth ? { authorization: `Bearer ${process.env.BROWSER_SERVICE_KEY}` } : {} });
assert.equal((await request('/health', 'GET', false)).status, 401);
const created = await request('/sessions', 'POST');
assert.equal(created.status, 201, await created.clone().text());
const session = await created.json();
let browser, viewer;
try {
  assert.equal((await request('/sessions', 'POST')).status, 409);
  browser = await chromium.connectOverCDP(session.connectUrl.replace(new URL(session.connectUrl).host, '127.0.0.1:8080'));
  const page = browser.contexts()[0].pages()[0];
  const privateProbe = await browser.contexts()[0].newPage();
  await assert.rejects(privateProbe.goto('http://127.0.0.1:8080/health'), /BLOCKED_BY_CLIENT|ERR_FAILED/);
  await privateProbe.close();
  await page.setContent('<h1>Browser pilot</h1><input aria-label="Test text"><button onclick="document.querySelector(\'h1\').textContent=\'Done\'">Save</button>');
  await page.locator('input').focus();
  const [id, token] = new URL(session.liveUrl).hash.slice(1).split(':');
  viewer = new WebSocket(`ws://127.0.0.1:8080/view/${id}?token=${token}`, { origin: new URL(process.env.BROWSER_PUBLIC_URL).origin });
  const frames = [];
  viewer.on('message', value => frames.push(JSON.parse(value.toString())));
  await new Promise((resolve, reject) => { viewer.once('open', resolve); viewer.once('error', reject); });
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.ok(frames.some(f => f.image?.length > 100));
  viewer.send(JSON.stringify({ type: 'text', text: 'blocked' }));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await page.locator('input').inputValue(), '');
  assert.equal((await request(`/sessions/${id}/human`, 'POST')).status, 200);
  viewer.send(JSON.stringify({ type: 'text', text: 'Manuell inmatning åäö' }));
  await page.waitForFunction(() => document.querySelector('input').value === 'Manuell inmatning åäö');
  assert.equal((await request(`/sessions/${id}/agent`, 'POST')).status, 200);
  await page.getByText('Save', { exact: true }).click();
  assert.equal(await page.locator('h1').innerText(), 'Done');
  assert.ok((await page.screenshot()).length > 100);
  console.log('PASS authenticated creation, single-session limit, CDP, live frames, takeover input, agent resume, screenshot');
} finally {
  viewer?.close();
  await browser?.close();
  assert.equal((await request(`/sessions/${session.sessionId}`, 'DELETE')).status, 200);
}
assert.equal((await request(`/sessions/${session.sessionId}/human`, 'POST')).status, 404);
const fresh = await (await request('/sessions', 'POST')).json();
try {
  const browser = await chromium.connectOverCDP(fresh.connectUrl.replace(new URL(fresh.connectUrl).host, '127.0.0.1:8080'));
  assert.equal(browser.contexts()[0].pages()[0].url(), 'about:blank');
  assert.equal((await browser.contexts()[0].cookies()).length, 0);
  await browser.close();
} finally { await request(`/sessions/${fresh.sessionId}`, 'DELETE'); }
console.log('PASS close, revoked session, fresh isolated profile');
