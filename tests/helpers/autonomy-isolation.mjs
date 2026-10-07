import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { providerPacingInterval } from '../../shared/provider-pacing.ts';

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Before any model is started, prove that API-created identities were persisted
 * in the exact database the observer validated. An empty mission list alone can
 * also mean the application is writing to a different database. */
export function assertIsolatedRoundTrip(expected, observed) {
  for (const field of ['workspaceId', 'threadId', 'userId']) assert.match(expected[field] ?? '', /^[a-f0-9-]{36}$/i, `Missing expected ${field}`);
  assert.deepEqual(observed.workspaces, [{ id: expected.workspaceId, user_id: expected.userId }], 'Workspace did not round-trip through the isolated database');
  assert.deepEqual(observed.threads, [{ id: expected.threadId, workspace_id: expected.workspaceId, user_id: expected.userId }], 'Thread did not round-trip through the isolated database');
}

/** Refuse shared databases before any integration connection or migration. */
export function assertIsolatedDatabaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('An explicit isolated PostgreSQL URL is required.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !loopbackHosts.has(url.hostname)
    || !/^\/syna_test_autonomy_[a-z0-9_]+$/.test(url.pathname)
    || !url.username || !url.password || !url.port
    || [...url.searchParams.keys()].some(key => !['sslmode'].includes(key))
    || (url.searchParams.has('sslmode') && url.searchParams.get('sslmode') !== 'disable')) {
    throw new Error('Autonomy integration tests require an explicit loopback PostgreSQL URL and a syna_test_autonomy_* database.');
  }
  return url.toString();
}

export async function readIsolationFixture(path = '.data/autonomy-isolation/fixture.json') {
  const fixture = JSON.parse(await readFile(resolve(path), 'utf8'));
  if (fixture.kind !== 'syna-autonomy-isolation' || fixture.version !== 1
    || !['docker', 'native-postgres'].includes(fixture.provider)
    || !/^autonomy-test:[a-z0-9-]+$/.test(fixture.runtimeScope || '')
    || typeof fixture.internalApiSecret !== 'string' || fixture.internalApiSecret.length < 32) {
    throw new Error('Invalid isolated test fixture.');
  }
  return { ...fixture, databaseUrl: assertIsolatedDatabaseUrl(fixture.databaseUrl) };
}

/** Construct child-process env from an allowlist, never merge the app's .env. */
export function isolatedProcessEnvironment(fixture, options = {}) {
  const databaseUrl = assertIsolatedDatabaseUrl(fixture.databaseUrl);
  if (!/^autonomy-test:[a-z0-9-]+$/.test(fixture.runtimeScope || '') || typeof fixture.internalApiSecret !== 'string' || fixture.internalApiSecret.length < 32) throw new Error('Invalid isolated runtime scope or internal secret');
  for (const service of ['auth', 'browser', 'runner']) {
    if (!fixture[service]) continue;
    const url = new URL(fixture[service].url);
    if (!loopbackHosts.has(url.hostname) || url.protocol !== 'http:' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error(`Isolated ${service} must use a loopback HTTP origin.`);
    }
  }
  const environment = {};
  const interval = options.modelRequestIntervalMs ?? 0;
  if (!Number.isSafeInteger(interval) || interval < 0) throw new Error('Invalid isolated model request interval');
  providerPacingInterval(String(interval));
  if (fixture.vault && !/^[a-f0-9]{64}$/.test(fixture.vault.key ?? '')) throw new Error('Isolated Vault requires its own 32-byte hexadecimal key');
  const platformKeys = /^(path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|appdata|localappdata|programfiles|programfiles\(x86\)|programdata|homedrive|homepath|home|lang|lc_all|number_of_processors|processor_architecture)$/i;
  for (const [key, value] of Object.entries(process.env)) {
    if (platformKeys.test(key) && value !== undefined) environment[key] = value;
  }
  Object.assign(environment, {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    POSTGRES_URL: databaseUrl,
    POSTGRESQL_URL: databaseUrl,
    PAT_RUNTIME_SCOPE: fixture.runtimeScope,
    SYNA_ISOLATED_STORAGE_ROOT: resolve('.data/autonomy-isolation', `evidence-${fixture.runtimeScope.split(':')[1]}`),
    SYNA_ISOLATED_MEMORY_ROOT: resolve('.data/autonomy-isolation', `memory-${fixture.runtimeScope.split(':')[1]}`),
    APP_URL: 'http://127.0.0.1:3000',
    INTERNAL_API_SECRET: fixture.internalApiSecret,
    ENV_VAULT_KEY: fixture.vault?.key || '',
    SUPABASE_URL: fixture.auth?.url || 'http://127.0.0.1:54321',
    NEXT_PUBLIC_SUPABASE_URL: fixture.auth?.url || 'http://127.0.0.1:54321',
    SUPABASE_PUBLISHABLE_KEY: fixture.auth?.anonKey || 'isolated-auth-not-started',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: fixture.auth?.anonKey || 'isolated-auth-not-started',
    SUPABASE_SERVICE_ROLE_KEY: fixture.auth?.serviceRoleKey || '',
    GRUNDEN_API_TOKEN: '',
    GRUNDEN_MIN_REQUEST_INTERVAL_MS: String(interval),
    WORKSPACE_BLOB_READ_WRITE_TOKEN: '',
    BLOB_READ_WRITE_TOKEN: '',
    REPO_RUNNER_URL: fixture.runner?.url || 'http://127.0.0.1:58090',
    REPO_RUNNER_KEY: fixture.runner?.key || '',
    BROWSER_PROVIDER: 'vps',
    BROWSER_SERVICE_URL: fixture.browser?.url || 'http://127.0.0.1:58080',
    BROWSER_SERVICE_KEY: fixture.browser?.key || '',
    CODEX_ACCESS_MODE: 'disabled',
    AUTONOMOUS_MISSIONS_ENABLED: options.autonomy === true ? 'true' : 'false',
    VERCEL: '',
    VERCEL_ENV: '',
    VERCEL_OIDC_TOKEN: '',
    VERCEL_TOKEN: '',
    RUN_MISSION_REPORT_TESTS: '0',
  });
  if (options.modelToken) environment.GRUNDEN_API_TOKEN = options.modelToken;
  if (options.sharedOtto === true) {
    if (fixture.runner?.url !== 'http://127.0.0.1:58091') throw new Error('Shared Otto requires the owned isolated Linux executor');
    environment.CODEX_ACCESS_MODE = 'shared';
  }
  return environment;
}
