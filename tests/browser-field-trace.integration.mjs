import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Real isolated Chromium; values are synthetic test data, never user credentials.
assert.equal(process.env.BROWSER_SERVICE_URL, 'http://127.0.0.1:58092');
const app = await isolatedApp();
const { traceFilledField } = await import('../server/utils/browser-action-trace.ts');
const origin = process.env.BROWSER_SERVICE_URL;
const headers = { authorization: `Bearer ${process.env.BROWSER_SERVICE_KEY}`, 'content-type': 'application/json' };
let browser, session;
const passed = [];
try {
  const response = await fetch(`${origin}/sessions`, { method: 'POST', headers, body: JSON.stringify({ policy: { version: 1, allowedOrigins: ['http://qa-fixture.test'], readOnly: true, deadlineAt: new Date(Date.now() + 120000).toISOString() } }) });
  assert.equal(response.status, 201); session = await response.json();
  browser = await chromium.connectOverCDP(session.connectUrl);
  const page = browser.contexts()[0].pages()[0];
  await page.setContent('<input id="normal"><textarea id="area"></textarea><input id="password" type="password"><input id="masked" style="-webkit-text-security:disc"><input id="transparent" style="color:transparent"><input id="small" style="font-size:0"><input id="hidden" style="display:none"><div style="opacity:0"><input id="parent-hidden"></div><div id="editable" contenteditable></div><input id="offscreen" style="position:absolute;left:-2000px"><div style="position:relative"><input id="covered"><div style="position:absolute;inset:0;background:white"></div></div><input id="text-fill" style="-webkit-text-fill-color:transparent"><input id="alpha" style="color:rgba(1,2,3,0)">');
  const privateValue = 'synthetic-input-not-for-evidence';
  const expected = { method: 'dom-value-and-css', valueMatchesRequested: true, nonEmpty: true, cssVisible: true, masking: 'not-detected', limitation: 'CSS visibility does not prove viewport position, occlusion or rendered text. Masking checks input type and text-security only.' };
  for (const id of ['normal', 'area']) {
    const field = page.locator(`#${id}`); await field.fill(privateValue);
    const trace = await traceFilledField(field, privateValue);
    const { control, observedAt, ...predicates } = trace;
    assert.deepEqual(predicates, expected); assert.ok(!JSON.stringify(trace).includes(privateValue));
    assert.deepEqual(control, { tag: id === 'area' ? 'textarea' : 'input', type: id === 'area' ? 'textarea' : 'text', label: '' });
    assert.ok(Number.isFinite(Date.parse(observedAt)));
  }
  passed.push('Real input and textarea yield predicates without their value');
  const field = page.locator('#normal');
  assert.equal((await traceFilledField(field, 'different')).valueMatchesRequested, false);
  await field.fill(''); const empty = await traceFilledField(field, '');
  assert.equal(empty.nonEmpty, false); assert.equal(empty.valueMatchesRequested, true);
  passed.push('Mismatch and empty input are not claimed as a successful nonempty match');
  for (const id of ['password', 'masked']) {
    const field = page.locator(`#${id}`); await field.fill(privateValue);
    const { control, observedAt, ...predicates } = await traceFilledField(field, privateValue);
    assert.equal(control.tag, 'input'); assert.ok(Number.isFinite(Date.parse(observedAt)));
    assert.deepEqual(predicates, { ...expected, masking: 'masked' });
  }
  passed.push('Password and CSS-masked input are explicitly masked');
  for (const id of ['transparent', 'small', 'offscreen', 'covered', 'text-fill', 'alpha']) {
    const field = page.locator(`#${id}`); await field.evaluate((node, value) => { node.value = value; }, privateValue);
    const trace = await traceFilledField(field, privateValue);
    assert.equal(trace.masking, 'not-detected');
    assert.match(trace.limitation, /does not prove viewport position, occlusion or rendered text/);
  }
  passed.push('Transparent, zero-font, offscreen and covered fields retain explicit limits; no readable or visible text claim');
  for (const id of ['hidden', 'parent-hidden']) {
    const field = page.locator(`#${id}`); await field.evaluate((node, value) => { node.value = value; }, privateValue);
    assert.equal((await traceFilledField(field, privateValue)).cssVisible, false);
  }
  passed.push('Hidden element and transparent ancestor are observed as not visible');
  assert.equal(await traceFilledField(page.locator('#editable'), privateValue), null);
  passed.push('Unsupported contenteditable has no inferred field receipt');
  await field.evaluate((node, value) => node.setAttribute('aria-label', `Search ${value}`), privateValue);
  assert.equal((await traceFilledField(field, privateValue)).control.label, 'Search [REDACTED]');
  passed.push('Observed control label is bounded and redacts requested text independently of the model claim');
  console.log(JSON.stringify({ status: 'passed', passed, browser: 'actual isolated Chromium', model: false }));
} finally {
  await browser?.close().catch(() => {});
  if (session) await fetch(`${origin}/sessions/${session.sessionId}`, { method: 'DELETE', headers });
  await app.close();
}
