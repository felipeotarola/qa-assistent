import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionRedaction, REDACTION_LIMITS, readRedactionObservation } from '../infra/browser/redaction.mjs';

const raw = (links, overrides = {}) => ({ title: 'Page', text: 'Home Help Contact', headings: [], fields: [], links, linksTruncated: false, ...overrides });
const link = (label = 'Home', href = 'https://fixture.test/') => ({ label, href });
test('observed DOM hrefs have bounded shape and never claim a performed click', () => {
  const observed = new SessionRedaction().observation(raw([link(), link('Help', 'https://fixture.test/help')]));
  assert.deepEqual(observed.linkObservation.links, [link(), link('Help', 'https://fixture.test/help')]);
  assert.equal(observed.linkObservation.method, 'dom-css-visible-anchors');
  assert.equal(observed.linkObservation.truncated, false);
  assert.match(observed.linkObservation.limitation, /No viewport, occlusion, rendered text, click or HTTP-response proof/);
  assert.equal(Object.hasOwn(observed, 'clickedTarget'), false);
});
test('hrefs omit credentials, query values and fragment without decoding path delimiters', () => {
  const observed = new SessionRedaction().observation(raw([link('Link', 'https://user:secret@fixture.test/a%2Fb?token=private#private')]));
  assert.deepEqual(observed.linkObservation.links, [link('Link', 'https://fixture.test/a%2Fb')]);
  assert.equal(JSON.stringify(observed).includes('secret'), false);
  assert.equal(JSON.stringify(observed).includes('private'), false);
});
test('current and historical exact values are redacted in labels and encoded hrefs before truncation', () => {
  const state = new SessionRedaction(); state.register(['private/old', 'å known']);
  const observed = state.observation(raw([link('private/old å known current-value', 'https://fixture.test/private%2Fold/%C3%A5%20known/current-value')], { fields: ['current-value'] }));
  assert.deepEqual(observed.linkObservation.links, [link('[REDACTED] [REDACTED] [REDACTED]', 'https://fixture.test/[REDACTED]/[REDACTED]/[REDACTED]')]);
  assert.equal(state.receipt('digest').registeredCount, 3);
  assert.equal(JSON.stringify(state), '{}');
  const again = state.observation(raw([link('private/old', 'https://fixture.test/private%2Fold')]));
  assert.equal(JSON.stringify(again).includes('private'), false);
  const mixedEncoding = state.observation(raw([link('Link', 'https://fixture.test/private%2fold/%c3%A5%20known')]));
  assert.equal(mixedEncoding.linkObservation.links[0].href, 'https://fixture.test/[REDACTED]/[REDACTED]');
});
test('unsafe/overlong destinations are omitted rather than clipped into a different valid href', () => {
  const observed = new SessionRedaction().observation(raw([link('JS', 'javascript:alert(1)'), link('Data', 'data:text/html,x'), link('Too long', `https://fixture.test/${'x'.repeat(2048)}`), link()]));
  assert.deepEqual(observed.linkObservation.links, [link()]); assert.equal(observed.linkObservation.truncated, true);
});
test('label truncation and scan limits are explicit; malformed link payloads fail closed', () => {
  const state = new SessionRedaction();
  const observed = state.observation(raw([link('x'.repeat(201))]));
  assert.equal(observed.linkObservation.links[0].label.length, 200); assert.equal(observed.linkObservation.truncated, true);
  for (const payload of [raw(Array(41).fill(link())), raw([{ label: {}, href: 'https://fixture.test/' }]), raw([], { linksTruncated: undefined }), raw([link('x'.repeat(REDACTION_LIMITS.observationLength + 1))])]) assert.throws(() => state.observation(payload));
});
const node = (label, href, visible = true, width = 10) => ({ innerText: label, href, checkVisibility: () => visible, getClientRects: () => [{ width, height: 10 }] });
async function syntheticDom(anchors) {
  const old = globalThis.document; globalThis.document = { title: 'Synthetic DOM' };
  try { return await readRedactionObservation({ locator: () => ({ evaluate: (fn, limits) => fn({ innerText: 'DOM text', querySelectorAll: query => query === 'a[href]' ? anchors : [] }, limits) }) }); }
  finally { if (old === undefined) delete globalThis.document; else globalThis.document = old; }
}
test('DOM collector excludes hidden/no-layout anchors, preserving actual absolute hrefs', async () => {
  const result = await syntheticDom([node('Hidden', 'https://fixture.test/hidden', false), node('Zero', 'https://fixture.test/zero', true, 0), node(' Home ', 'https://fixture.test/')]);
  assert.deepEqual(result.links, [link()]); assert.equal(result.linksTruncated, false);
});
test('DOM collector bounds output and scanning without a false exhaustive claim', async () => {
  const visible = await syntheticDom(Array.from({ length: 41 }, (_, i) => node(`Link ${i}`, `https://fixture.test/${i}`)));
  assert.equal(visible.links.length, 40); assert.equal(visible.linksTruncated, true);
  const hidden = await syntheticDom([...Array.from({ length: 512 }, () => node('Hidden', 'https://fixture.test/hidden', false)), node('Outside budget', 'https://fixture.test/not-scanned')]);
  assert.deepEqual(hidden.links, []); assert.equal(hidden.linksTruncated, true);
});
