import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBrowserPolicy, browserPolicyDigest, browserRequestAllowed, admitBrowserRequest, humanInputAllowed } from '../infra/browser/policy.mjs';

const now = Date.parse('2026-10-05T12:00:00Z');
const policy = { version: 1, allowedOrigins: ['https://fixture.example'], readOnly: true, deadlineAt: '2026-10-05T12:10:00.000Z' };

test('browser service requires an exact bounded read-only policy and rejects widening fields', () => {
  assert.equal(parseBrowserPolicy(undefined, now), null, 'Historical interactive sessions keep their own policy');
  assert.deepEqual(parseBrowserPolicy(policy, now), policy);
  for (const update of [null, {}, { ...policy, readOnly: false }, { ...policy, allowWrites: true }, { ...policy, version: 2 }, { ...policy, deadlineAt: new Date(now).toISOString() }, { ...policy, deadlineAt: new Date(now + 25 * 3600000).toISOString() }, ...['*', 'https://fixture.example/', 'https://fixture.example/path', 'https://u:p@fixture.example', 'file:///tmp', 'https://*.example'].map(value => ({ ...policy, allowedOrigins: [value] })), { ...policy, allowedOrigins: [] }, { ...policy, allowedOrigins: [policy.allowedOrigins[0], policy.allowedOrigins[0]] }]) assert.throws(() => parseBrowserPolicy(update, now));
});

test('browser policy binds all navigation, rejects every write method and expires independently', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) assert.equal(browserRequestAllowed(policy, { url: 'https://fixture.example/page', method, navigation: true }, now), true);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT', 'TRACE']) assert.equal(browserRequestAllowed(policy, { url: 'https://fixture.example/api', method, navigation: false }, now), false);
  for (const url of ['https://outside.example', 'https://fixture.example.attacker.test', 'https://user:pass@fixture.example', 'file:///tmp']) assert.equal(browserRequestAllowed(policy, { url, method: 'GET', navigation: true }, now), false);
  assert.equal(browserRequestAllowed(policy, { url: 'https://cdn.example/img.png', method: 'GET', navigation: false }, now), true, 'Public subresources still require the caller SSRF check');
  assert.equal(browserRequestAllowed(policy, { url: 'https://fixture.example', method: 'GET', navigation: true }, Date.parse(policy.deadlineAt)), false);
});

test('receipt digest pins the normalized policy, including origin scope and deadline', () => {
  const a = parseBrowserPolicy({ ...policy, allowedOrigins: ['https://b.example', 'https://a.example'] }, now);
  const b = parseBrowserPolicy({ ...policy, allowedOrigins: ['https://a.example', 'https://b.example'] }, now);
  assert.equal(browserPolicyDigest(a), browserPolicyDigest(b));
  assert.notEqual(browserPolicyDigest(a), browserPolicyDigest(policy));
  assert.notEqual(browserPolicyDigest(policy), browserPolicyDigest({ ...policy, deadlineAt: '2026-10-05T12:11:00.000Z' }));
});

test('only explicit human control permits same-origin login POST, without widening agent permissions', () => {
  const request = { url: 'https://fixture.example/login', method: 'POST', navigation: true };
  assert.equal(browserRequestAllowed(policy, request, now, 'human'), true);
  assert.equal(browserRequestAllowed(policy, { ...request, navigation: false }, now, 'human'), true, 'SPA login is also possible');
  for (const control of ['agent', undefined, true, 'Human', 'human_control']) assert.equal(browserRequestAllowed(policy, request, now, control), false);
  assert.equal(browserRequestAllowed(policy, { ...request, control: 'human' }, now), false, 'Request content never owns control');
  for (const url of ['https://outside.example/login', 'https://fixture.example.attacker.test/login', 'https://user:pass@fixture.example/login', 'file:///tmp']) {
    assert.equal(browserRequestAllowed(policy, { ...request, url }, now, 'human'), false);
  }
  for (const method of ['PUT', 'PATCH', 'DELETE', 'CONNECT', 'TRACE']) assert.equal(browserRequestAllowed(policy, { ...request, method }, now, 'human'), false);
  assert.equal(browserRequestAllowed(policy, request, Date.parse(policy.deadlineAt), 'human'), false);
  assert.equal(browserRequestAllowed(policy, request, now, 'agent'), false, 'Returning control restores read-only admission');
});

test('destination admission still blocks human requests and every control change fences delayed requests', async () => {
  const request = { url: 'https://fixture.example/login', method: 'POST', navigation: true };
  const initial = { control: 'human', controlEpoch: 1, expiresAt: now + 1000, closing: false };
  assert.equal(await admitBrowserRequest(policy, request, () => initial, async () => false, () => now), false);
  assert.equal(await admitBrowserRequest(policy, request, () => initial, async () => true, () => now), true);
  assert.equal(await admitBrowserRequest(policy, request, () => undefined, async () => true, () => now), false);
  for (const change of [{ control: 'agent', controlEpoch: 2 }, { control: 'human', controlEpoch: 3 }, { closing: true }, { expiresAt: now }]) {
    let state = initial;
    assert.equal(await admitBrowserRequest(policy, request, () => state, async () => { state = { ...initial, ...change }; return true; }, () => now), false);
  }
  let clock = now;
  assert.equal(await admitBrowserRequest(policy, request, () => initial, async () => { clock += 1001; return true; }, () => clock), false);
});

test('queued human input loses authority after expiry, close or any handoff', () => {
  const state = { control: 'human', controlEpoch: 4, expiresAt: now + 1000, closing: false };
  assert.equal(humanInputAllowed(state, 4, now), true);
  for (const changed of [{ ...state, control: 'agent' }, { ...state, controlEpoch: 6 }, { ...state, closing: true }, { ...state, expiresAt: now }, undefined]) assert.equal(humanInputAllowed(changed, 4, now), false);
  for (const epoch of [undefined, '4', 3, NaN, Infinity]) assert.equal(humanInputAllowed(state, epoch, now), false);
});
