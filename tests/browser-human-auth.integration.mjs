import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { assertIsolatedDatabaseUrl, readIsolationFixture } from './helpers/autonomy-isolation.mjs';
import { authOrigin, extraSiteRevision } from './fixtures/browser-variants-extra-site.mjs';
import { readFixtureAuthAudit, submitFixtureLogin, validateHumanLogin } from './helpers/browser-variants-auth.mjs';
import { hash } from './helpers/browser-variants-protocol.mjs';

// Real Chromium, viewer input and a POST/CSRF/HttpOnly-cookie fixture. No model,
// cookie injection, fake successful GET or replacement browser executor.
assertIsolatedDatabaseUrl(process.env.DATABASE_URL);
assert.match(process.env.PAT_RUNTIME_SCOPE || '', /^autonomy-test:/);
const origin = process.env.BROWSER_SERVICE_URL;
assert.equal(origin, 'http://127.0.0.1:58092');
const linux = JSON.parse(await readFile('.data/autonomy-isolation/linux/fixture.json', 'utf8'));
assert.match(linux.name, /^SynaAutonomy-[a-f0-9]{12}$/);
const manifest = JSON.parse(await readFile('.data/autonomy-isolation/linux/browser-variants-extra-deployment.json', 'utf8'));
assert.equal(manifest.runtimeScope, process.env.PAT_RUNTIME_SCOPE);
assert.equal(manifest.serverSha256, extraSiteRevision);
const actualImage = (await promisify(execFile)('wsl.exe', ['-d', linux.name, '-u', 'root', '--exec', 'docker', 'inspect', '-f', '{{.Image}}', 'qa-browser'], { windowsHide: true, encoding: 'utf8', timeout: 10000 })).stdout.trim();
assert.equal(actualImage, manifest.browserImage, 'Actual browser image does not match the physical verification manifest');
const fixture = await readIsolationFixture(); assert.equal(fixture.runtimeScope, manifest.runtimeScope);
const headers = { authorization: 'Bearer ' + process.env.BROWSER_SERVICE_KEY, 'content-type': 'application/json' };
async function request(path, body, method = 'POST') {
  const response = await fetch(origin + path, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  return { status: response.status, data: await response.json() };
}
const audit = () => readFixtureAuthAudit(fixture);
const before = await audit(), passed = [];
let session, browser;
try {
  const created = await request('/sessions', { policy: { version: 1, allowedOrigins: [authOrigin], readOnly: true, deadlineAt: new Date(Date.now() + 120000).toISOString() } });
  assert.equal(created.status, 201); session = created.data;
  browser = await chromium.connectOverCDP(session.connectUrl);
  let page = browser.contexts()[0].pages()[0];
  await page.goto(authOrigin + '/account');
  assert.equal(new URL(page.url()).pathname, '/login');
  assert.equal(await page.evaluate(async () => { try { await fetch('/login', { method: 'POST', body: 'denied' }); return 'sent'; } catch { return 'blocked'; } }), 'blocked');
  await browser.close(); browser = undefined;
  const human = await request(`/sessions/${session.sessionId}/human?scoped=1`);
  assert.equal(human.status, 200); assert.equal(human.data.control, 'human');
  await assert.rejects(chromium.connectOverCDP(session.connectUrl, { timeout: 3000 }), /401|Unexpected|closed/);
  passed.push('Agent POST is denied and CDP is revoked during explicit human control');
  const id = session.sessionId;
  const input = await submitFixtureLogin({ liveUrl: human.data.liveUrl, sessionId: id, origin });
  let observed;
  const deadline = Date.now() + 15000;
  do {
    observed = (await audit()).events.filter(row => row.sequence > before.events.length);
    if (observed.some(row => row.kind === 'login' && row.accepted)) break;
    await delay(150);
  } while (Date.now() < deadline);
  const login = observed.filter(row => row.kind === 'login');
  assert.equal(login.length, 1); assert.equal(login[0].accepted, true, JSON.stringify(login)); assert.equal(login[0].method, 'POST'); assert.equal(login[0].status, 303);
  validateHumanLogin(await audit(), input, extraSiteRevision);
  passed.push('Scoped viewer clicks and typing submit a genuine CSRF-protected login POST');
  const returned = await request(`/sessions/${id}/agent?scoped=1`);
  assert.equal(returned.status, 200); assert.ok(returned.data.controlEpoch > human.data.controlEpoch);
  browser = await chromium.connectOverCDP(session.connectUrl); page = browser.contexts()[0].pages()[0];
  assert.equal((await page.goto(authOrigin + '/account')).status(), 200);
  assert.match(await page.locator('body').innerText(), /Elin Exempel/);
  assert.equal(await page.evaluate(async () => { try { await fetch('/login', { method: 'POST', body: 'denied' }); return 'sent'; } catch { return 'blocked'; } }), 'blocked');
  await assert.rejects(page.goto('https://example.com', { timeout: 3000 }), /ERR_|Navigation/);
  const final = (await audit()).events.filter(row => row.sequence > before.events.length);
  assert.equal(final.filter(row => row.kind === 'login').length, 1);
  assert.ok(final.some(row => row.kind === 'account_read' && row.authenticated && row.sessionHash === login[0].sessionHash));
  passed.push('Returned agent verifies the issued session by authenticated GET; writes and outside navigation remain denied');
  const artifact = `.data/autonomy-isolation/browser-human-auth-${randomUUID()}.json`;
  const result = { protocol: 'browser-human-auth-v1', status: 'passed', passed, service: 'actual isolated browser service', browser: 'actual Chromium', model: false, syntheticAccount: true, browserImage: actualImage, fixtureSha256: extraSiteRevision, viewerInput: input, events: final, verifiedAt: new Date().toISOString() };
  const bytes = JSON.stringify(result, null, 2); await writeFile(artifact, bytes, { flag: 'wx' });
  await writeFile('.data/autonomy-isolation/linux/browser-human-auth-verification.json', JSON.stringify({ artifact, sha256: hash(bytes), browserImage: actualImage, fixtureSha256: extraSiteRevision }, null, 2));
  console.log(JSON.stringify({ artifact, status: result.status, passed, model: false }));
} finally {
  await browser?.close().catch(() => {});
  if (session) assert.equal((await request(`/sessions/${session.sessionId}`, undefined, 'DELETE')).status, 200);
}
