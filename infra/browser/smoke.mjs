// Run inside the service container when no user session is active.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
import { allowedOrigins } from '../execution/http.mjs';
const base = process.env.BROWSER_TEST_URL || 'http://127.0.0.1:8080';
const connectUrl = url => url.replace(/^wss?:\/\/[^/]+/, base.replace(/^http/, 'ws'));
const request = (path, method = 'GET', auth = true) => fetch(base + path, { method, headers: auth ? { authorization: `Bearer ${process.env.BROWSER_SERVICE_KEY}` } : {} });
assert.equal((await request('/health', 'GET', false)).status, 401);
const viewerResponse = await request('/viewer', 'GET', false);
assert.equal(viewerResponse.status, 200);
const ancestors = viewerResponse.headers.get('content-security-policy').split(';').map(part => part.trim()).find(part => part.startsWith('frame-ancestors '));
assert.equal(ancestors, `frame-ancestors ${allowedOrigins().join(' ') || "'none'"}`, 'Viewer must allow the configured app domains without accepting arbitrary ancestors');
const created = await request('/sessions', 'POST');
assert.equal(created.status, 201, await created.clone().text());
const session = await created.json();
let browser, viewer;
const peers = [];
try {
  const health = await (await request('/health')).json();
  assert.ok(health.maxSessions >= 2, 'Concurrency smoke requires at least two slots');
  const createdPeers = await Promise.all(Array.from({ length: health.maxSessions - 1 }, () => request('/sessions', 'POST')));
  for (const response of createdPeers) {
    assert.equal(response.status, 201);
    peers.push(await response.json());
  }
  assert.equal((await request('/sessions', 'POST')).status, 409);
  const peerBrowser = await chromium.connectOverCDP(connectUrl(peers[0].connectUrl));
  try {
    const peerPage = peerBrowser.contexts()[0].pages()[0];
    await peerPage.setContent('<h1>Independent session</h1>');
    await peerBrowser.contexts()[0].addCookies([{ name: 'isolated', value: 'peer-only', domain: 'example.com', path: '/' }]);
  } finally { await peerBrowser.close(); }
  const wrongTokenUrl = new URL(connectUrl(peers[0].connectUrl));
  wrongTokenUrl.searchParams.set('token', new URL(session.connectUrl).searchParams.get('token'));
  const rejected = await new Promise(resolve => {
    const socket = new WebSocket(wrongTokenUrl);
    socket.on('error', () => resolve(true));
    socket.on('open', () => { socket.close(); resolve(false); });
  });
  assert.ok(rejected, 'Another session token must not grant access');
  browser = await chromium.connectOverCDP(connectUrl(session.connectUrl));
  let page = browser.contexts()[0].pages()[0];
  assert.equal(await page.locator('h1').count(), 0);
  assert.equal((await browser.contexts()[0].cookies()).length, 0);
  const privateProbe = await browser.contexts()[0].newPage();
  await assert.rejects(privateProbe.goto('http://127.0.0.1:8080/health'), /BLOCKED_BY_CLIENT|ERR_FAILED/);
  await privateProbe.close();
  await page.setContent('<h1>Browser pilot</h1><input aria-label="Test text"><button onclick="document.querySelector(\'h1\').textContent=\'Done\'">Save</button>');
  await page.locator('input').focus();
  const [id, token] = new URL(session.liveUrl).hash.slice(1).split(':');
  viewer = new WebSocket(`${base.replace(/^http/, 'ws')}/view/${id}?token=${token}`, { origin: new URL(process.env.BROWSER_PUBLIC_URL).origin });
  const frames = [];
  viewer.on('message', value => frames.push(JSON.parse(value.toString())));
  await new Promise((resolve, reject) => { viewer.once('open', resolve); viewer.once('error', reject); });
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.ok(frames.some(f => f.image?.length > 100));
  viewer.send(JSON.stringify({ type: 'text', text: 'blocked' }));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await page.locator('input').inputValue(), '');
  const takeover = await request(`/sessions/${id}/human?scoped=1`, 'POST');
  assert.equal(takeover.status, 200);
  const { controlEpoch, liveUrl } = await takeover.json();
  await assert.rejects(chromium.connectOverCDP(connectUrl(session.connectUrl)), /401|Unexpected|WebSocket/);
  viewer.send(JSON.stringify({ type: 'text', text: 'stale', controlEpoch: controlEpoch - 1 }));
  viewer.send(JSON.stringify({ type: 'text', text: 'read-only viewer blocked', controlEpoch }));
  viewer.close();
  const controllerToken = new URL(liveUrl).hash.slice(1).split(':')[1];
  viewer = new WebSocket(`${base.replace(/^http/, 'ws')}/view/${id}?token=${controllerToken}`, { origin: new URL(process.env.BROWSER_PUBLIC_URL).origin });
  await new Promise((resolve, reject) => { viewer.once('open', resolve); viewer.once('error', reject); });
  viewer.send(JSON.stringify({ type: 'text', text: 'Manuell inmatning åäö', controlEpoch }));
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal((await request(`/sessions/${id}/agent`, 'POST')).status, 200);
  browser = await chromium.connectOverCDP(connectUrl(session.connectUrl));
  page = browser.contexts()[0].pages()[0];
  assert.equal(await page.locator('input').inputValue(), 'Manuell inmatning åäö');
  await page.getByText('Save', { exact: true }).click();
  assert.equal(await page.locator('h1').innerText(), 'Done');
  assert.ok((await page.screenshot()).length > 100);
  const peer = await chromium.connectOverCDP(connectUrl(peers[0].connectUrl));
  try { assert.equal(await peer.contexts()[0].pages()[0].locator('h1').innerText(), 'Independent session'); }
  finally { await peer.close(); }
  console.log('PASS concurrent isolated processes, capacity, cross-session token rejection, CDP, live frames, takeover input, agent resume, screenshot');
} finally {
  viewer?.close();
  await browser?.close();
  assert.equal((await request(`/sessions/${session.sessionId}`, 'DELETE')).status, 200);
  for (const peer of peers) {
    assert.equal((await request(`/sessions/${peer.sessionId}/human`, 'POST')).status, 200, 'Closing one session must leave peers alive');
    await request(`/sessions/${peer.sessionId}`, 'DELETE');
  }
}
assert.equal((await request(`/sessions/${session.sessionId}/human`, 'POST')).status, 404);
const fresh = await (await request('/sessions', 'POST')).json();
try {
  const browser = await chromium.connectOverCDP(connectUrl(fresh.connectUrl));
  assert.equal(browser.contexts()[0].pages()[0].url(), 'about:blank');
  assert.equal((await browser.contexts()[0].cookies()).length, 0);
  await browser.close();
} finally { await request(`/sessions/${fresh.sessionId}`, 'DELETE'); }
console.log('PASS close, revoked session, fresh isolated profile');
