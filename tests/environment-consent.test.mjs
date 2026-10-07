import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalEnvironmentPlan, environmentPlanIdentity } from '../shared/environment-plan-identity.mjs';
import { grantEnvironmentConsentSchema, revokeEnvironmentConsentSchema, authorizeEnvironmentConsentSchema, ENVIRONMENT_CONSENT_DEFAULT_MS, ENVIRONMENT_CONSENT_MAX_MS } from '../shared/project-environment-consent.ts';

const plan = () => ({ repoUrl: 'https://github.com/fixture/repo', root: '/workspace/repo', directory: '/workspace/repo/web', commit: 'a'.repeat(40), command: 'npm run dev -- --host 0.0.0.0', port: 3000, processId: randomUUID(), httpStatus: 500, variables: [{ name: 'APP_URL', required: true, reason: 'Application URL' }, { name: 'API_KEY', required: false, reason: 'Optional integration' }] });
const grant = () => ({ requestId: randomUUID(), expectedPlanHash: 'b'.repeat(64), expectedVaultRevision: 2, allowedNames: ['APP_URL', 'API_KEY'] });

test('startup identity binds every execution-relevant field and ignores transient observations', () => {
  const current = plan(), baseline = canonicalEnvironmentPlan(current);
  for (const changed of [
    { repoUrl: 'https://github.com/fixture/another' }, { root: '/workspace/another', directory: '/workspace/another/web' },
    { directory: '/workspace/repo' }, { commit: 'b'.repeat(40) }, { command: 'npm run other' }, { port: 4000 },
    { variables: [{ name: 'APP_URL', required: false }] },
  ]) assert.notEqual(canonicalEnvironmentPlan({ ...current, ...changed }), baseline);
  assert.equal(canonicalEnvironmentPlan({ ...current, repoUrl: `${current.repoUrl}.git/`, processId: randomUUID(), httpStatus: 200, updatedAt: 'later', variables: [...current.variables].reverse().map(variable => ({ ...variable, reason: 'New explanation' })) }), baseline);
  assert.deepEqual(Object.keys(environmentPlanIdentity(current)), ['version', 'repoUrl', 'root', 'directory', 'commit', 'command', 'port', 'variables']);
  assert.deepEqual(environmentPlanIdentity(current).variables.map(variable => variable.name), ['API_KEY', 'APP_URL']);
  assert.ok(!baseline.includes('reason')); assert.ok(!baseline.includes('processId'));
});

test('invalid paths, commits, reserved names and unbounded plans fail closed', () => {
  for (const changed of [
    { root: '/workspace/../outside' }, { directory: '/workspace/other' }, { commit: 'main' },
    { command: ' ' }, { port: 80 }, { repoUrl: 'https://attacker.example/repo' },
    { variables: [{ name: 'NODE_OPTIONS', required: true }] },
    { variables: [{ name: 'API_KEY', required: true }, { name: 'API_KEY', required: false }] },
    { commit: ['a'.repeat(40)] }, { variables: [{ name: ['API_KEY'], required: true }] },
  ]) assert.throws(() => canonicalEnvironmentPlan({ ...plan(), ...changed }));
});

test('grant contract is explicit, names-only and rejects caller-supplied plans or values', () => {
  const input = grant();
  assert.deepEqual(grantEnvironmentConsentSchema.parse(input).allowedNames, ['API_KEY', 'APP_URL']);
  for (const changed of [
    { values: { API_KEY: 'never-accepted' } }, { plan: plan() }, { userId: randomUUID() },
    { expectedVaultRevision: 0 }, { allowedNames: [] }, { allowedNames: ['API_KEY', 'API_KEY'] },
    { expectedPlanHash: 'invented' }, { expiresAt: 'whenever' },
  ]) assert.equal(grantEnvironmentConsentSchema.safeParse({ ...input, ...changed }).success, false);
  assert.equal(ENVIRONMENT_CONSENT_DEFAULT_MS, 86400000); assert.equal(ENVIRONMENT_CONSENT_MAX_MS, 604800000);
});

test('revocation and ref-only authorization require their current identities', () => {
  assert.equal(revokeEnvironmentConsentSchema.safeParse({ expectedRevision: 1 }).success, true);
  assert.equal(revokeEnvironmentConsentSchema.safeParse({ expectedRevision: 0 }).success, false);
  const input = { consentId: randomUUID(), consentRevision: 1, setupJobId: randomUUID(), expectedPlanHash: 'b'.repeat(64), vaultRevision: 1 };
  assert.equal(authorizeEnvironmentConsentSchema.safeParse(input).success, true);
  for (const changed of [{ values: {} }, { consentRevision: 0 }, { setupJobId: 'other' }, { runtime: 'production' }]) assert.equal(authorizeEnvironmentConsentSchema.safeParse({ ...input, ...changed }).success, false);
});
