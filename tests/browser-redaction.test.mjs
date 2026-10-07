import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionRedaction, REDACTION_LIMITS, requireRedactionSession, redactionPage } from '../infra/browser/redaction.mjs';
import { browserPolicyDigest } from '../infra/browser/policy.mjs';

const raw = (text, fields = []) => ({ title: text, headings: [text], text, fields, links: [], linksTruncated: false });
const policy = { version: 1, readOnly: true, allowedOrigins: ['https://example.test'], deadlineAt: '2026-10-05T10:30:00Z' };
const digest = browserPolicyDigest(policy), now = Date.parse('2026-10-05T10:00:00Z');

test('redaction remembers exact values across observations without serializing the dictionary', () => {
  const state = new SessionRedaction(), value = 'private-value-123';
  state.register([value]);
  const first = state.observation(raw(`First ${value}`, [value]));
  const afterNavigation = state.observation(raw(`Still ${value}`));
  assert.equal(first.text, 'First [REDACTED]');
  assert.equal(afterNavigation.text, 'Still [REDACTED]');
  assert.equal(state.receipt(digest).registeredCount, 1);
  assert.equal(JSON.stringify(state), '{}');
  assert.equal(JSON.stringify([first, afterNavigation, state.receipt(digest)]).includes(value), false);
  state.clear();
  assert.equal(state.receipt(digest).registeredCount, 0);
});

test('current input fields are registered before text is returned and long echoes are cleaned before truncation', () => {
  const state = new SessionRedaction(), value = 'private-long-'.repeat(650);
  assert.ok(value.length > 6000 && value.length <= REDACTION_LIMITS.valueLength);
  const result = state.observation(raw(`prefix ${value} suffix`, [value]));
  assert.equal(result.text, 'prefix [REDACTED] suffix');
  assert.equal(result.title, 'prefix [REDACTED] suffix');
  assert.deepEqual(result.headings, ['prefix [REDACTED] suffix']);
  assert.equal(result.truncated, true);
  assert.equal(state.receipt(digest).registeredCount, 1);
});

test('regex characters are literal and short values cannot recursively expand redaction markers', () => {
  const state = new SessionRedaction();
  state.register(['a.*[x](y)$\\', 'R', 'E']);
  assert.equal(state.observation(raw('a.*[x](y)$\\ R E')).text, '[REDACTED] [REDACTED] [REDACTED]');
});

test('bounded registration is atomic and never evicts old values', () => {
  const state = new SessionRedaction();
  state.register(['original-value']);
  for (const values of [[...Array.from({ length: 64 }, (_, i) => `value-${i}`)], ['x'.repeat(10001)], [null], Array(513).fill('same')]) {
    assert.throws(() => state.register(values), error => error.status === 413);
    assert.equal(state.receipt(digest).registeredCount, 1);
    assert.equal(state.observation(raw('original-value')).text, '[REDACTED]');
  }
  state.register(['', 'original-value']);
  assert.equal(state.receipt(digest).registeredCount, 1);
  const bytes = new SessionRedaction();
  assert.throws(() => bytes.register(Array.from({ length: 8 }, (_, i) => `${i}${'å'.repeat(9999)}`)), error => error.status === 413);
  assert.equal(bytes.receipt(digest).registeredCount, 0);
});

test('oversize observations fail closed, and receipts explicitly limit the guarantee to exact text', () => {
  const state = new SessionRedaction();
  assert.throws(() => state.observation(raw('x'.repeat(REDACTION_LIMITS.observationLength + 1))), error => error.status === 413);
  assert.throws(() => state.observation({ tooLarge: true }), error => error.status === 413);
  const receipt = state.receipt(digest);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.policyDigest, digest);
  assert.equal(receipt.exactValues, true);
  assert.match(receipt.limitation, /not general DLP or screenshot redaction/);
});

test('policy, control epoch and physical session expiry must all match', () => {
  const session = { policy, expiresAt: now + 60000, control: 'agent', controlEpoch: 2 };
  assert.equal(requireRedactionSession(session, digest, 2, now), digest);
  for (const override of [{ policy: null }, { control: 'human' }, { controlEpoch: 3 }, { expiresAt: now }, { closing: true }, { policy: { ...policy, deadlineAt: new Date(now).toISOString() } }]) {
    assert.throws(() => requireRedactionSession({ ...session, ...override }, digest, 2, now), error => error.status === 409);
  }
  assert.throws(() => requireRedactionSession(session, 'wrong', 2, now), error => error.status === 409);
  assert.throws(() => requireRedactionSession(null, digest, 2, now), error => error.status === 409);
});

test('the exact CDP target is selected even when a different tab is foreground; sessions always detach', async () => {
  const first = { id: 'first' }, foreground = { id: 'second' }, detached = [];
  const context = { pages: () => [foreground, first], newCDPSession: async page => ({ send: async () => ({ targetInfo: { targetId: page.id } }), detach: async () => detached.push(page.id) }) };
  assert.equal(await redactionPage(context, first.id), first);
  assert.deepEqual(detached, ['second', 'first']);
  await assert.rejects(redactionPage(context, 'missing'), error => error.status === 404);
  await assert.rejects(redactionPage(context, '../bad'), error => error.status === 400);
});
