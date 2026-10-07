// Explicit, separately measured test preparation via ordinary user APIs only.
// No direct writes to mission/setup/consent tables, no controller drain/rescue.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, open, realpath } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import postgres from 'postgres';
import { Client } from 'eve/client';
import { createServerClient } from '@supabase/ssr';
import { readIsolationFixture, isolatedProcessEnvironment, assertIsolatedRoundTrip } from './autonomy-isolation.mjs';
import { verifyIsolatedAppArtifacts } from './start-isolated-app.mjs';
import { utcObservationTypes } from './utc-postgres-observation.mjs';
import { repoHash, validateRepoManifest, assertSavedConsent, freezeRepoModelPacing } from './repo-benchmark-contract.mjs';
import { observeRepoWorker, observeRepoResources } from './repo-worker-integrity.mjs';
import { observeRepoPreparation, observeRepoMission } from './repo-acceptance-observer.mjs';
import { runTransportPlan } from './repo-transport.mjs';

const args = process.argv.slice(2), execute = args.includes('--execute');
assert.ok(args.includes('--validate') !== execute, 'Choose --validate or explicit --execute');
assert.ok(args.every(x => ['--execute', '--validate'].includes(x) || x.startsWith('--manifest=')));
const file = resolve(args.find(x => x.startsWith('--manifest='))?.slice(11) || ''), base = dirname(file);
assert.ok(file.startsWith(resolve('.data/autonomy-isolation/repo-fixtures') + sep)); assert.equal(await realpath(file), file);
const manifest = validateRepoManifest(JSON.parse(await readFile(file, 'utf8')), { runnable: execute }); assert.ok(!manifest.faultGateway, 'Prepare using the original direct runtime before any fault gateway');
assert.ok(!manifest.prepared?.length, 'Preparation creates three fresh workspaces, never replaces a previous prepared set');
const oracleBytes = await readFile('tests/fixtures/repo-benchmark/oracle.json'); assert.equal(repoHash(oracleBytes), manifest.oracleSha256);
const repo = manifest.repositories.find(r => r.scenario === 'REPO-12'), names = [...JSON.parse(oracleBytes).scenarios['REPO-12'].requiredNames].sort();
const prompt = `Förbered ${repo.url} i en testmiljö och ta reda på vilken konfiguration som behövs. Starta inte appen förrän jag har lämnat konfigurationen. Använd version ${repo.commit}.`;
if (!execute) console.log(JSON.stringify({ validation: 'passed', modelCalls: 0, mutations: 0, scenario: 'REPO-12', repetitions: 3, manifestSha256: repoHash(JSON.stringify(manifest)), prompt,
  limitation: 'Validation only. Execution uses real preparation models and ordinary cancel/Vault/grant APIs; no prepared receipt exists yet.' }));
else await main();

async function main() {
  const fixture = await readIsolationFixture(); isolatedProcessEnvironment(fixture, { sharedOtto: true }); assert.equal(manifest.runtime, fixture.runtimeScope);
  assert.equal(fixture.app.origin, 'http://127.0.0.1:58000'); assert.equal(fixture.runner.url, 'http://127.0.0.1:58091');
  const root = resolve('.data/autonomy-isolation', `application-${fixture.runtimeScope.split(':')[1]}`); assert.equal(resolve(fixture.app.root), root);
  const protocol = { version: 1, kind: 'repository-consent-preparation', scenario: 'REPO-12', id: randomUUID(), runtime: fixture.runtimeScope, sourceHash: fixture.app.sourceSha256,
    prompt, model: 'glm-5.3-flash', reasoning: 'low', repetitions: 3, startedAt: new Date().toISOString(), attempts: [], prepared: [],
    usageScope: 'Separate preparation only. Excluded from the subsequent QA acceptance totals; no end-to-end token or monetary claim.' };
  const output = resolve('.data/autonomy-isolation', `repository-consent-preparation-${protocol.id}.json`), secrets = new Set([fixture.databaseUrl, fixture.internalApiSecret, fixture.auth.anonKey, fixture.auth.serviceRoleKey, fixture.browser.key, fixture.runner.key].filter(Boolean));
  const redact = text => { let result = String(text); for (const value of secrets) result = result.split(value).join('[REDACTED]'); return result.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED JWT]'); };
  const persist = () => writeFile(output, redact(JSON.stringify(protocol, null, 2)) + '\n');
  const sql = postgres(fixture.databaseUrl, { max: 2, prepare: false, types: utcObservationTypes, connection: { TimeZone: 'UTC', default_transaction_read_only: 'on' } });
  const lock = await open(resolve(base, 'consent-preparation.lock'), 'wx'); let cookie, frozen;
  const api = async (method, path, body) => { const response = await fetch(fixture.app.origin + path, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(20000) }); assert.ok(response.ok, `Ordinary ${method} API status ${response.status}`); const value = await response.json(); assert.ok(value && typeof value === 'object'); return value; };
  async function freeze() {
    const build = await verifyIsolatedAppArtifacts(fixture, { requireRuntime: true }), worker = await observeRepoWorker(fixture);
    const modelRequestIntervalMs = freezeRepoModelPacing(protocol, build.runtime);
    assert.equal(build.sourceSha256, protocol.sourceHash); assert.equal(repoHash(JSON.stringify(worker)), manifest.workerReceiptSha256);
    const bytes = await readFile(resolve(base, 'transport.json')); assert.equal(repoHash(bytes), manifest.transport.receiptSha256); const transport = JSON.parse(bytes);
    assert.match(transport.planPath, /^transport-[a-f0-9-]{36}\/plan\.json$/); const planPath = resolve(base, transport.planPath);
    assert.equal(repoHash(await readFile(resolve(dirname(planPath), 'fetch-receipt.json'))), transport.fetchReceiptSha256);
    const observed = await runTransportPlan('verify', planPath); assert.deepEqual(observed, transport.verifiedTransport); assert.equal(observed.executionImage, worker.executionImage);
    const value = { build, modelRequestIntervalMs, worker, transport: observed }; if (frozen) assert.deepEqual(value, frozen); else frozen = value; protocol.buildIntegrity = value;
  }
  try {
    await freeze(); assert.equal((await sql`show transaction_read_only`)[0].transaction_read_only, 'on');
    protocol.harnessSha256 = repoHash(await readFile('tests/helpers/repo-prepare-consent.mjs'));
    const account = JSON.parse(await readFile('.data/autonomy-isolation/ordinary-user.json', 'utf8')); secrets.add(account.password);
    const cookies = new Map(), auth = createServerClient(fixture.auth.url, fixture.auth.anonKey, { cookieOptions: { name: 'pat_supabase_auth', path: '/', sameSite: 'lax' }, cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: entries => entries.forEach(c => cookies.set(c.name, c.value)) } });
    const login = await auth.auth.signInWithPassword({ email: account.email, password: account.password }); assert.equal(login.error, null); assert.equal(login.data.user.id, account.userId); assert.equal(login.data.user.role, 'authenticated');
    secrets.add(login.data.session.access_token); secrets.add(login.data.session.refresh_token); cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; '); secrets.add(cookie);
    await persist();
    for (let repetition = 1; repetition <= 3; repetition++) {
      const trial = { repetition, startedAt: new Date().toISOString(), snapshots: [] }; protocol.attempts.push(trial); await persist(); await freeze();
      const workspace = (await api('POST', '/api/workspaces', { name: `Repo consent preparation ${protocol.id.slice(0, 8)}-${repetition}` })).workspace;
      assert.match(workspace?.id, /^[a-f0-9-]{36}$/); trial.workspaceId = workspace.id; await persist();
      const thread = (await api('POST', '/api/threads', { workspaceId: workspace.id, title: 'Förbered testkonfiguration' })).thread;
      assert.match(thread?.id, /^[a-f0-9-]{36}$/);
      Object.assign(trial, { workspaceId: workspace.id, threadId: thread.id });
      assertIsolatedRoundTrip({ workspaceId: workspace.id, threadId: thread.id, userId: account.userId }, { workspaces: [...await sql`select id,user_id from pat_workspaces where id=${workspace.id}`], threads: [...await sql`select id,workspace_id,user_id from pat_threads where id=${thread.id}`] });
      trial.messageId = randomUUID(); await persist();
      const client = new Client({ host: fixture.app.origin, redirect: 'error', headers: { cookie, 'x-pat-browser-thread': thread.id, 'x-pat-message-id': trial.messageId, 'x-pat-chat-model': protocol.model, 'x-pat-reasoning': protocol.reasoning } });
      const accepted = await client.sessions.create({ message: prompt }); trial.sessionId = accepted.session.state.sessionId; trial.acceptedAt = new Date().toISOString(); await persist();
      let prepared, mission;
      for (const deadline = Date.now() + 30 * 60000; Date.now() < deadline;) {
        const state = await observeRepoMission(sql, workspace.id, fixture.runtimeScope, trial.startedAt);
        const latest = JSON.stringify(state); if (latest !== JSON.stringify(trial.snapshots.at(-1)?.state)) { trial.snapshots.push({ at: new Date().toISOString(), state }); await persist(); }
        assert.equal(state.runs.length, 0, 'Preparation unexpectedly ran functional tests'); assert.ok(!state.setups.some(x => x.autonomy?.environmentExecution?.phase === 'apply'), 'Preparation unexpectedly applied credentials or started the app');
        const selected = state.setups.filter(x => x.autonomy?.environmentExecution?.phase === 'prepare' && ['needs_configuration', 'completed'].includes(x.status) && x.result?.cleanup === 'confirmed' && x.result.executorStopped === true);
        if (selected.length) {
          assert.equal(selected.length, 1); assert.equal(state.missions.length, 1); prepared = selected[0];
          assert.equal(prepared.result.environment.repoUrl, repo.url); assert.equal(prepared.result.environment.commit, repo.commit); assert.equal(prepared.result.environment.probeKind, 'identity');
          const [row] = await sql`select id,lifecycle,mandate_revision from pat_missions where id=${state.missions[0].id} and workspace_id=${workspace.id} and runtime=${fixture.runtimeScope}`; assert.ok(row); mission = row; break;
        }
        if (state.missions.length && state.missions.every(x => x.lifecycle === 'closed')) throw new Error('Preparation closed without a verified plan');
        await new Promise(done => setTimeout(done, 1000));
      }
      assert.ok(prepared && mission, 'No real verified preparation before the bounded deadline'); trial.setupJobId = prepared.id;
      if (mission.lifecycle !== 'closed') {
        trial.cancelRequest = { action: 'cancel', missionId: mission.id, requestId: randomUUID(), expectedMandateRevision: mission.mandate_revision, reason: 'Förberedelsen är klar. Det sparade medgivandet ska användas i ett separat nytt QA-uppdrag.' };
        await persist();
        trial.cancelReceipt = await api('POST', `/api/workspaces/${workspace.id}/autonomy`, { threadId: thread.id, input: trial.cancelRequest }); await persist();
      }
      let settled;
      for (const deadline = Date.now() + 10 * 60000; Date.now() < deadline;) {
        const state = await observeRepoPreparation(sql, workspace.id, fixture.runtimeScope);
        if (!state.activeMissions.length && !state.claims.length) { settled = state; break; }
        await new Promise(done => setTimeout(done, 1000));
      }
      assert.ok(settled, 'Preparation cancellation did not physically settle; no Vault write or grant performed');
      const resources = await observeRepoResources(fixture); assert.ok(!resources.some(x => x.name.endsWith(prepared.autonomy.resourceId)), 'Preparation sandbox remains');
      trial.settledAt = new Date().toISOString(); trial.finalSnapshot = await observeRepoMission(sql, workspace.id, fixture.runtimeScope, trial.startedAt);
      await freeze();
      const values = { SERVICE_BASE_URL: `https://repo-fixture.invalid/${randomUUID()}`, SERVICE_ACCESS_TOKEN: `syna-fixture-${randomUUID()}` }; for (const value of Object.values(values)) secrets.add(value);
      const valuesPath = resolve(base, 'values.private.json'); let historical = {};
      try { historical = JSON.parse(await readFile(valuesPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.ok(!historical[workspace.id]); historical[workspace.id] = values;
      const temporary = valuesPath + '.' + randomUUID() + '.tmp'; await writeFile(temporary, JSON.stringify(historical), { flag: 'wx', mode: 0o600 }); await rename(temporary, valuesPath);
      trial.vaultRequest = { path: `/api/workspaces/${workspace.id}/vault`, repoUrl: repo.url, expectedRevision: 0, names, privateValuesFile: valuesPath, status: 'about_to_submit' }; await persist();
      const vault = await api('PUT', `/api/workspaces/${workspace.id}/vault`, { repoUrl: repo.url, expectedRevision: 0, values, forget: [] }); assert.equal(vault.revision, 1); assert.deepEqual([...vault.configuredNames].sort(), names);
      trial.vaultReceipt = vault; await persist();
      const status = await api('GET', `/api/workspaces/${workspace.id}/setup-jobs/${prepared.id}/consent`); assert.ok(status.planHash); assert.deepEqual(status.missingNames, []); assert.equal(status.vaultRevision, 1);
      assert.equal(status.plan.repoUrl, repo.url); assert.equal(status.plan.commit, repo.commit); assert.equal(status.plan.executionProfile.imageDigest, frozen.worker.executionImage);
      trial.consentRequest = { requestId: randomUUID(), expectedPlanHash: status.planHash, expectedVaultRevision: vault.revision, allowedNames: names }; await persist();
      const consent = await api('POST', `/api/workspaces/${workspace.id}/setup-jobs/${prepared.id}/consent`, trial.consentRequest);
      assert.equal(consent.status, 'active'); assert.equal(consent.planHash, status.planHash);
      const entry = { workspaceId: workspace.id, threadId: thread.id, setupJobId: prepared.id, consentId: consent.id, userId: account.userId, planHash: status.planHash, vaultRevision: vault.revision, origin: 'ordinary-session-api', valuesKind: 'synthetic-local-only' };
      assertSavedConsent(await observeRepoPreparation(sql, workspace.id, fixture.runtimeScope), entry, { runtime: fixture.runtimeScope, repo, names, now: Date.now() + 75 * 60000 });
      protocol.prepared.push(entry); trial.result = 'prepared'; trial.finishedAt = new Date().toISOString(); await persist();
      console.log(JSON.stringify({ preparationId: protocol.id, repetition, result: 'prepared', artifact: output }));
    }
    const bound = validateRepoManifest({ ...manifest, prepared: protocol.prepared, preparationArtifact: output, preparationId: protocol.id }, { runnable: true, scenario: 'REPO-12' });
    const path = resolve(base, `prepared-manifest-${protocol.id}.json`); await writeFile(path, JSON.stringify(bound, null, 2) + '\n', { flag: 'wx' });
    protocol.result = 'prepared'; protocol.manifestPath = path; protocol.finishedAt = new Date().toISOString(); await persist();
    await lock.close(); await rename(resolve(base, 'consent-preparation.lock'), resolve(base, `consent-preparation-${protocol.id}.completed.lock`));
    console.log(JSON.stringify({ result: 'prepared', path, artifact: output, modelCalls: 'Actual preparation calls; inspect preserved snapshots', excludedFromQaAcceptance: true }));
  } catch (error) {
    protocol.result = 'failed'; protocol.error = redact(error?.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : `${error.name}: ${error.code ?? 'Preparation failed; inspect the private artifact'}`).slice(0, 600); protocol.finishedAt = new Date().toISOString(); await persist();
    await lock.close(); console.log(JSON.stringify({ result: 'failed', artifact: output, error: protocol.error, recovery: 'Owned preparation lock preserved. Observe the original mission; never blindly resubmit.' })); process.exitCode = 1;
  } finally { await sql.end(); }
}
