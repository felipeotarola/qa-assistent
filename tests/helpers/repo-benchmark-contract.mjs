import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const repoHash = bytes => createHash('sha256').update(bytes).digest('hex');
export const repoScenarios = ['REPO-10', 'REPO-11', 'REPO-12'];

/** Freeze runtime pacing independently of authored source: changing an env
 * option changes the workload's timing even when the source hash is identical. */
export function freezeRepoModelPacing(protocol, runtime) {
  const interval = runtime?.modelRequestIntervalMs ?? 0;
  assert.ok(Number.isSafeInteger(interval) && interval >= 0 && interval <= 30000, 'Invalid runtime provider pacing');
  protocol.modelRequestIntervalMs ??= interval;
  assert.equal(protocol.modelRequestIntervalMs, interval, 'Provider pacing changed during repository trial');
  return interval;
}
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);

/** This is test authority, not a model prompt. A pinned SHA alone is not an
 * oracle, a transport attestation or permission to run an arbitrary target. */
export function validateRepoManifest(value, { runnable = false, scenario } = {}) {
  assert.equal(value?.version, 1); assert.equal(value?.kind, 'syna-repository-benchmark');
  assert.ok(['public-github', 'simulated-github-transport', 'unbound'].includes(value.transport?.kind));
  assert.ok(digest(value.oracleSha256));
  assert.equal(value.oracleNotServed, true); assert.equal(value.oracleNotInPrompt, true);
  assert.ok(Array.isArray(value.repositories) && value.repositories.length === 3);
  assert.deepEqual([...value.repositories.map(r => r.scenario)].sort(), repoScenarios);
  for (const repo of value.repositories) {
    assert.match(repo.url, /^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/);
    assert.match(repo.commit, /^[a-f0-9]{40}$/); assert.match(repo.tree, /^[a-f0-9]{40}$/);
    assert.ok(digest(repo.filesSha256)); assert.ok(digest(repo.lockfileSha256));
    assert.equal(repo.packageManager, 'npm'); assert.equal(repo.runtime, 'node24');
    assert.equal(repo.directory, '.'); assert.equal(repo.codeChangesAllowed, false);
  }
  if (scenario) assert.ok(repoScenarios.includes(scenario));
  if (!runnable) return value;
  assert.notEqual(value.transport.kind, 'unbound', 'No verified fetchable Git transport: no model request may be submitted');
  assert.ok(digest(value.transport.receiptSha256), 'Frozen transport receipt is required');
  assert.equal(value.transport.isolatedRuntime, value.runtime);
  assert.match(value.runtime, /^autonomy-test:[a-z0-9-]+$/);
  assert.ok(digest(value.workerReceiptSha256), 'Actual worker source/process/image receipt is required');
  if (value.transport.kind === 'simulated-github-transport') {
    assert.equal(value.transport.scope, 'exact-fixture-repositories-only');
    assert.equal(value.transport.productionDnsChanged, false);
  }
  if (scenario === 'REPO-12') {
    assert.ok(Array.isArray(value.prepared) && value.prepared.length === 3, 'Saved consent requires three independently prepared isolated workspaces');
    const workspaces = new Set();
    for (const entry of value.prepared) {
      for (const field of ['workspaceId', 'threadId', 'setupJobId', 'consentId', 'userId']) assert.ok(uuid(entry[field]), `Invalid prepared ${field}`);
      assert.ok(!workspaces.has(entry.workspaceId), 'Repetitions cannot share one prepared workspace'); workspaces.add(entry.workspaceId);
      assert.ok(digest(entry.planHash)); assert.ok(Number.isSafeInteger(entry.vaultRevision) && entry.vaultRevision > 0);
      assert.equal(entry.origin, 'ordinary-session-api'); assert.equal(entry.valuesKind, 'synthetic-local-only');
    }
  }
  return value;
}

export function repoPrompt(scenario, repo) {
  assert.ok(repoScenarios.includes(scenario));
  assert.match(repo.url, /^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/); assert.match(repo.commit, /^[a-f0-9]{40}$/);
  const goal = scenario === 'REPO-10'
    ? `Kolla ${repo.url} och testa bibliotekets viktigaste funktioner. Sammanfatta felen, men ändra ingen kod.`
    : scenario === 'REPO-11'
      ? `Starta ${repo.url} i en testmiljö, kontrollera startsidan och huvudnavigeringen och ge mig en rapport.`
      : `Förbered ${repo.url} med den testkonfiguration jag redan sparat, testa det som går och rapportera eventuella hinder.`;
  return `${goal} Använd version ${repo.commit}.`;
}

export function assertSavedConsent(state, prepared, { runtime, repo, names, now = Date.now() }) {
  const source = state.setups.find(row => row.id === prepared.setupJobId);
  assert.ok(source && source.runtime === runtime && source.workspace_id === prepared.workspaceId);
  assert.ok(['completed', 'needs_configuration'].includes(source.status));
  assert.equal(source.result?.environment?.repoUrl, repo.url); assert.equal(source.result?.environment?.commit, repo.commit);
  assert.equal(source.result?.environment?.probeKind, 'identity');
  assert.equal(source.result?.cleanup, 'confirmed'); assert.equal(source.result?.executorStopped, true);
  assert.ok(source.result.environment.executionProfile);
  const consent = state.consents.find(row => row.id === prepared.consentId);
  assert.ok(consent, 'Saved grant is absent');
  assert.equal(consent.user_id, prepared.userId); assert.equal(consent.workspace_id, prepared.workspaceId); assert.equal(consent.runtime, runtime);
  assert.equal(consent.repo_url, repo.url); assert.equal(consent.plan_hash, prepared.planHash);
  assert.equal(consent.grant_setup_job_id, prepared.setupJobId); assert.equal(consent.vault_revision, prepared.vaultRevision);
  assert.equal(consent.revoked_at, null); assert.ok(Date.parse(consent.expires_at) > now, 'Saved grant expired');
  assert.deepEqual([...consent.allowed_names].sort(), [...names].sort());
  const vault = state.vault.find(row => row.repo_url === repo.url);
  assert.equal(vault?.revision, prepared.vaultRevision, 'Saved Vault revision changed');
  assert.equal(vault?.environment, 'test');
  return { consentId: consent.id, revision: consent.revision, planHash: consent.plan_hash, vaultRevision: consent.vault_revision };
}
