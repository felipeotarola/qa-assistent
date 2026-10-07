import assert from 'node:assert/strict';
import test from 'node:test';
import { ref } from 'vue';
import { createEnvironmentConsentClient, usableEnvironmentConsent } from '../app/composables/useEnvironmentConsent.ts';

const now = Date.parse('2026-10-05T19:00:00Z');
const plan = { version: 1, repoUrl: 'https://github.com/owner/project', root: '/workspace/project', directory: '/workspace/project/app', commit: 'a'.repeat(40), command: 'npm start', port: 3000,
  variables: [{ name: 'REQUIRED_KEY', required: true }, { name: 'OPTIONAL_KEY', required: false }] };
const status = () => ({ setupJobId: 'job', plan, planHash: 'b'.repeat(64), vaultRevision: 3, configuredNames: ['OPTIONAL_KEY', 'REQUIRED_KEY'], missingNames: [], consents: [] });
const consent = (extra = {}) => ({ id: 'consent', revision: 1, grantSetupJobId: 'job', repoUrl: plan.repoUrl, environment: 'test', plan, planHash: 'b'.repeat(64), allowedNames: ['REQUIRED_KEY'], vaultRevision: 3,
  expiresAt: new Date(now + 3600000).toISOString(), revokedAt: null, createdAt: new Date(now).toISOString(), status: 'active', ...extra });
function fixture() {
  const states = ref({}), reads = [], writes = []; let id = 0;
  const behavior = { read: async () => status(), post: async () => consent() };
  const client = createEnvironmentConsentClient({ states, now: () => now, makeId: () => `request-${++id}`,
    read: async (url, options) => { reads.push({ url, options }); return behavior.read(); },
    post: async (url, options) => { writes.push(structuredClone({ url, options })); return behavior.post(); },
  });
  return { ...client, states, reads, writes, behavior };
}

test('opening/refreshing only reads; explicit grant binds plan, Vault, exact names and expiry', async () => {
  const f = fixture(); await f.load('workspace', 'job');
  assert.equal(f.writes.length, 0);
  assert.equal((await f.grant('workspace', 'job', ['REQUIRED_KEY'], 1)).id, 'consent');
  assert.deepEqual(f.writes[0], { url: '/api/workspaces/workspace/setup-jobs/job/consent', options: { method: 'POST', retry: 0, body: {
    requestId: 'request-1', expectedPlanHash: 'b'.repeat(64), expectedVaultRevision: 3, allowedNames: ['REQUIRED_KEY'], expiresAt: new Date(now + 3600000).toISOString(),
  } } });
  assert.equal(f.reads.length, 2); assert.equal(f.state('workspace', 'job').pending, undefined);
});

test('uncertain grant retains identical body/request ID across status changes and ignores double click', async () => {
  const f = fixture(); await f.load('workspace', 'job');
  f.behavior.post = async () => { throw new Error('Network lost after commit'); };
  assert.equal(await f.grant('workspace', 'job', ['REQUIRED_KEY']), null);
  assert.equal(f.state('workspace', 'job').pending.state, 'uncertain');
  await f.load('workspace', 'job'); assert.equal(f.writes.length, 1);
  assert.equal(await f.grant('workspace', 'job', ['REQUIRED_KEY', 'OPTIONAL_KEY']), null);
  assert.equal(await f.retry('other-workspace', 'job'), null);
  f.behavior.post = async () => consent();
  assert.equal((await f.retry('workspace', 'job')).id, 'consent');
  assert.deepEqual(f.writes[1], f.writes[0]);
});

test('an in-flight grant cannot be retried or replaced and snapshots reactive plan data', async () => {
  const f = fixture(); await f.load('workspace', 'job');
  let release; f.behavior.post = () => new Promise(resolve => { release = resolve; });
  const first = f.grant('workspace', 'job', ['REQUIRED_KEY']);
  assert.equal(await f.grant('workspace', 'job', ['REQUIRED_KEY']), null);
  assert.equal(await f.retry('workspace', 'job'), null);
  assert.equal(f.writes.length, 1); assert.equal(f.state('workspace', 'job').pending.plan.commit, plan.commit);
  release(consent()); await first;
});

test('409 refreshes current status without automatically granting the new plan', async () => {
  const f = fixture(); await f.load('workspace', 'job');
  f.behavior.post = async () => { throw { statusCode: 409 }; };
  f.behavior.read = async () => ({ ...status(), vaultRevision: 4 });
  assert.equal(await f.grant('workspace', 'job', ['REQUIRED_KEY']), null);
  assert.equal(f.writes.length, 1); assert.equal(f.reads.length, 2);
  assert.equal(f.state('workspace', 'job').pending, undefined);
  assert.match(f.state('workspace', 'job').notice, /har ändrats/);
  assert.equal(await f.retry('workspace', 'job'), null);
});

test('confirmed grant plus failed status read never becomes an uncertain or automatic second write', async () => {
  const f = fixture(); await f.load('workspace', 'job');
  f.behavior.read = async () => { throw new Error('Read failed'); };
  assert.equal(await f.grant('workspace', 'job', ['REQUIRED_KEY']), null);
  assert.equal(f.state('workspace', 'job').granted.id, 'consent');
  assert.equal(f.state('workspace', 'job').pending, undefined);
  assert.equal(await f.retry('workspace', 'job'), null); assert.equal(f.writes.length, 1);
});

test('invalid names, absent plan, missing Vault revision and stale/revoked receipts never continue', async () => {
  const f = fixture(); assert.equal(await f.grant('workspace', 'job', ['REQUIRED_KEY']), null);
  await f.load('workspace', 'job');
  for (const names of [[], ['OPTIONAL_KEY'], ['REQUIRED_KEY', 'UNKNOWN']]) assert.equal(await f.grant('workspace', 'job', names), null);
  assert.equal(f.writes.length, 0);
  for (const changed of [{ status: 'expired' }, { status: 'revoked' }, { status: 'outdated' }, { expiresAt: new Date(now).toISOString() }, { vaultRevision: 2 }, { planHash: 'c'.repeat(64) }, { allowedNames: ['OPTIONAL_KEY'] }]) assert.equal(usableEnvironmentConsent(consent(changed), status(), now), false);
  f.behavior.post = async () => consent({ status: 'revoked' });
  assert.equal(await f.grant('workspace', 'job', ['REQUIRED_KEY']), null);
  f.behavior.read = async () => ({ ...status(), vaultRevision: 0 }); await f.load('workspace', 'job');
  assert.equal(await f.grant('workspace', 'job', ['REQUIRED_KEY']), null);
});

test('late or cross-job read cannot replace the newest selected plan', async () => {
  const f = fixture(); let release;
  f.behavior.read = () => new Promise(resolve => { release = resolve; });
  const first = f.load('workspace', 'job');
  f.behavior.read = async () => ({ ...status(), vaultRevision: 4 }); await f.load('workspace', 'job');
  release(status()); await first; assert.equal(f.state('workspace', 'job').status.vaultRevision, 4);
  f.behavior.read = async () => ({ ...status(), setupJobId: 'wrong' });
  await f.load('workspace', 'job'); assert.equal(f.state('workspace', 'job').status, null); assert.equal(f.writes.length, 0);
});
