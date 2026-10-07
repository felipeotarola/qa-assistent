import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

let response;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './vps-browser') return { url: 'data:text/javascript,export const vpsBrowserRequest = (...args) => globalThis.linkAdapterResponse(...args);', shortCircuit: true };
  if (specifier === '../../shared/mission') return next(new URL('../shared/mission.ts', import.meta.url).href, context);
  return next(specifier, context);
} });
globalThis.linkAdapterResponse = async (path, method, _preview, body) => {
  assert.equal(path, '/sessions/physical-session/observation'); assert.equal(method, 'POST');
  assert.deepEqual(body, { expectedPolicyDigest: 'digest', targetId: 'exact-target' }); return response;
};
const { readBrowserTraceObservation } = await import('../server/utils/browser-trace-privacy.ts'); hook.deregister();
const page = { context: () => ({ newCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId: 'exact-target' } }), detach: async () => {} }) }) };
const legacy = { title: 'Page', headings: [], text: 'Home', truncated: false };
const linkObservation = { method: 'dom-css-visible-anchors', links: [{ label: 'Home', href: 'https://fixture.test/' }], truncated: false, limitation: 'DOM evidence only' };
const use = observation => { response = { observation, redaction: { version: 1, policyDigest: 'digest', exactValues: true, registeredCount: 0, limitation: 'Exact values', targetId: 'exact-target' } }; return readBrowserTraceObservation('physical-session', 'digest', page); };
test('exact-target service observation keeps the bounded link shape and old absence stays unknown', async () => {
  assert.deepEqual(await use(legacy), legacy);
  const actual = await use({ ...legacy, linkObservation });
  assert.deepEqual(actual.linkObservation, linkObservation);
  assert.equal(Object.hasOwn(await use(legacy), 'linkObservation'), false);
});
test('link adapter fails closed for raw values, unsupported methods, destinations and over-budget arrays', async () => {
  for (const bad of [
    { ...linkObservation, method: 'clicked' }, { ...linkObservation, rawValue: 'must-not-export' },
    { ...linkObservation, links: Array(41).fill(linkObservation.links[0]) },
    ...['javascript:alert(1)', 'https://fixture.test/?input=x', 'https://fixture.test/#secret', 'https://user:pass@fixture.test/'].map(href => ({ ...linkObservation, links: [{ label: 'Home', href }] })),
    { ...linkObservation, links: [{ label: 'x'.repeat(201), href: 'https://fixture.test/' }] },
    { ...linkObservation, links: [{ label: 'Home', href: 'https://fixture.test/', value: 'unexpected' }] },
  ]) await assert.rejects(use({ ...legacy, linkObservation: bad }));
});
test('generic credential-format redaction still covers labels after service-owned exact-value sanitization', async () => {
  const result = await use({ ...legacy, linkObservation: { ...linkObservation, links: [{ label: 'Bearer secret-auth-value', href: 'https://fixture.test/' }] } });
  assert.equal(result.linkObservation.links[0].label, 'Bearer [REDACTED]');
});
