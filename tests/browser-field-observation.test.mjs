import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { savedFieldObservation, savedNavigationObservation } = await import('../server/utils/browser-action-trace.ts');
after(() => hook.deregister());
const predicates = { method: 'dom-value-and-css', valueMatchesRequested: true,
  nonEmpty: true, cssVisible: false, masking: 'masked', observedAt: '2026-10-06T03:00:00.000Z',
  limitation: 'CSS visibility does not prove viewport position, occlusion or rendered text. Masking checks input type and text-security only.' };
const trace = { action: 'fill', outcome: 'observed', filledField: { ...predicates,
  control: { label: 'untrusted private page label', tag: 'input', type: 'text' },
  value: 'never-return-actual-value', requested: 'never-return-requested-value' } };
test('saved fill projection preserves observed predicates and limits, excludes page text and values', () => {
  assert.deepEqual(savedFieldObservation(trace), predicates);
  assert.equal(Object.keys(savedFieldObservation(trace)).length, 7);
});
test('false and empty predicates remain false rather than becoming a test verdict', () => {
  const field = { ...trace.filledField, valueMatchesRequested: false, nonEmpty: false };
  assert.deepEqual(savedFieldObservation({ ...trace, filledField: field }), { ...predicates, valueMatchesRequested: false, nonEmpty: false });
});
test('failed action, unsupported field and non-fill action do not advertise a fill observation', () => {
  for (const candidate of [{ ...trace, outcome: 'action_failed' }, { ...trace, action: 'click' }, { ...trace, filledField: null }, { ...trace, filledField: undefined }]) {
    assert.equal(savedFieldObservation(candidate), null);
  }
});

test('navigation projection preserves exact status and failed-action outcome without leaking input or page data', () => {
  const observed = savedNavigationObservation({ httpStatus: 404, fromUrl: 'https://example.test/?q=private-value#secret', toUrl: 'https://example.test/missing', outcome: 'action_failed', finishedAt: '2026-10-06T06:00:00.000Z',
    observation: { text: 'untrusted page instruction' }, callId: 'internal-call', execution: { private: true } });
  assert.equal(observed.httpStatus, 404); assert.equal(observed.outcome, 'action_failed');
  assert.equal(observed.observedAt, '2026-10-06T06:00:00.000Z');
  assert.equal(new URL(observed.fromUrl).searchParams.get('q'), '[REDACTED]');
  assert.equal(new URL(observed.fromUrl).hash, '');
  assert.equal(observed.toUrl, 'https://example.test/missing');
  assert.ok(!/private-value|untrusted|internal-call|execution/.test(JSON.stringify(observed)));
  assert.equal(Object.keys(observed).length, 6);
});
test('a null navigation status stays unknown independently of successful tool outcome', () => {
  const observed = savedNavigationObservation({ httpStatus: null, fromUrl: null, toUrl: 'https://example.test/', outcome: 'observed', finishedAt: '2026-10-06T06:00:00.000Z' });
  assert.equal(observed.httpStatus, null); assert.equal(observed.fromUrl, null);
  assert.match(observed.limitation, /Null means no matching response/);
});
