import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { securityContextDigest as hash } from './helpers/security-context-provider.mjs';
import { securityContextFiles, securityContextIntegrationFiles, SECURITY_CONTEXT_SCOPE } from './helpers/security-context-runtime.mjs';
import { securityContextStartup, createSecurityContextRuntime, verifySecurityContextRuntime, armSecurityContextTrial, finishSecurityContextTrial } from './helpers/security-context-startup.mjs';
import { securityContextPaths } from './helpers/security-context-control.mjs';
import { SECURITY_CHAT_PROTOCOL, SECURITY_CHAT_CODE_FILES, securityChatPrompt } from './helpers/evidence-security-chat.mjs';
import { SECURITY_PROTOCOL } from './helpers/evidence-security.mjs';
import { isolatedAppEnvironment } from './helpers/start-isolated-app.mjs';

async function fixture(t) {
  const privateRoot = await realpath(resolve('.data/autonomy-isolation')), root = resolve(privateRoot, `security-context-startup-unit-${randomUUID()}`);
  await mkdir(root);
  t.after(async () => { const actual = await realpath(root), sub = relative(privateRoot, actual); assert.ok(sub.startsWith('security-context-startup-unit-') && !sub.includes(sep)); await rm(actual, { recursive: true }); });
  const ref = (name, runtime) => ({ workspaceId: `workspace_${name}`, reportId: `report_${name}`, runtime, documentHash: 'a'.repeat(64), marker: `evidence-owner-marker-${Buffer.from(name).toString('hex').padEnd(32, '0')}` });
  const sources = { protocol: SECURITY_PROTOCOL, taskId: 'SEC-08', variant: 'owner-runtime-anonymous-contract', sourceHash: 'a'.repeat(64), runtime: 'autonomy-test:context', preparation: 'synthetic-golden',
    trials: [0, 1, 2].map(i => ({ requesterAccountFile: 'a.json', ownerAccountFile: 'b.json', requesterId: 'owner_a', ownerId: 'owner_b',
      allowed: ref(`a${i}`, 'autonomy-test:context'), private: ref(`b${i}`, 'autonomy-test:context'), foreignRuntime: ref(`c${i}`, 'autonomy-test:other'), originArtifacts: [{ path: 'prep.json', sha256: 'a'.repeat(64) }] })) };
  const sourceBytes = JSON.stringify(sources), sourcesPath = resolve(root, 'sources.json'); await writeFile(sourcesPath, sourceBytes);
  const helperHashes = {}, code = {};
  for (const file of securityContextIntegrationFiles) helperHashes[file] = hash(await readFile(file));
  for (const [key, file] of Object.entries(SECURITY_CHAT_CODE_FILES)) code[key] = hash(await readFile(file));
  const manifest = { protocol: SECURITY_CHAT_PROTOCOL, taskId: 'SEC-08', sourceHash: sources.sourceHash, runtime: sources.runtime, model: 'zai/glm-5.3', reasoning: 'low', modelRequestIntervalMs: 6000,
    observationSeconds: 600, sources: { path: sourcesPath, sha256: hash(sourceBytes) }, code,
    trials: ['other-owner', 'other-runtime'].flatMap(variant => [1, 2, 3].map(repetition => ({ variant, repetition, sourceTrial: repetition - 1, workspaceId: `chat_${variant}_${repetition}` }))),
    contextObservation: { version: 1, scope: SECURITY_CONTEXT_SCOPE, helperHashes } };
  const manifestFile = resolve(root, 'manifest.json'); await writeFile(manifestFile, JSON.stringify(manifest));
  for (const service of ['web', 'eve']) for (const file of securityContextFiles) {
    const path = resolve(root, service, file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, await readFile(file));
  }
  const f = { runtimeScope: sources.runtime, app: { root, sourceSha256: sources.sourceHash, origin: 'http://127.0.0.1:58000' } }, source = { sourceSha256: sources.sourceHash, files: securityContextFiles };
  return { root, sources, manifest, manifestFile, f, source, startup: await securityContextStartup(manifestFile, f, source, root) };
}

const runtimeFor = securityContext => ({ mode: 'application', modelRequestIntervalMs: 6000, securityContext });
async function syntheticReady(recorded, root, identities) {
  for (const service of ['web', 'eve']) {
    const saved = recorded.services[service], config = JSON.parse(await readFile(saved.path)), listener = identities[service].listener;
    const binding = { service, pid: listener.pid, parentPid: identities[service].main.pid, runtime: config.runtime, sourceHash: config.sourceHash,
      manifestHash: config.manifestHash, nonce: config.nonce, configHash: saved.configHash, preloadHash: config.helperHashes['tests/helpers/security-context-preload.mjs'],
      helperHashes: config.helperHashes, deadlineAt: config.deadlineAt, canariesHash: hash(JSON.stringify(config.canaries)), trialPromptHashes: config.trialPromptHashes };
    const data = { sequence: 1, previous: '0'.repeat(64), at: new Date().toISOString(), kind: 'ready', binding }, path = securityContextPaths({ ...binding, serviceRoot: resolve(root, service) }).output;
    await writeFile(path, JSON.stringify({ ...data, hash: hash(JSON.stringify(data)) }) + '\n');
  }
}

test('normal child environment ignores ambient observer flags; explicit hook is application-only and owned', () => {
  const f = { kind: 'syna-autonomy-isolation', provider: 'native-postgres', version: 1, databaseUrl: 'postgres://local:local@127.0.0.1:54321/syna_test_autonomy_context', runtimeScope: 'autonomy-test:context', internalApiSecret: 'x'.repeat(48) };
  const root = resolve('.data/autonomy-isolation/application-context'), manifestFile = resolve('.data/autonomy-isolation/context.json');
  const config = { manifestFile, services: Object.fromEntries(['web', 'eve'].map(service => [service, { path: resolve(root, `security-context-${'a'.repeat(64)}.json`), configHash: 'a'.repeat(64) }])) };
  const old = process.env.SYNA_SECURITY_CONTEXT_PRELOAD; process.env.SYNA_SECURITY_CONTEXT_PRELOAD = '1';
  try {
    for (const service of ['web', 'eve']) {
      const normal = isolatedAppEnvironment(f, service); assert.equal(normal.SYNA_SECURITY_CONTEXT_PRELOAD, undefined); assert.ok(!normal.NODE_OPTIONS.includes('security-context'));
      const explicit = isolatedAppEnvironment(f, service, { securityContextManifestFile: manifestFile }, null, config);
      assert.equal(explicit.SYNA_SECURITY_CONTEXT_PRELOAD, '1'); assert.equal(explicit.SYNA_SECURITY_CONTEXT_CONFIG, config.services[service].path);
      assert.ok(explicit.NODE_OPTIONS.indexOf('isolation-module-fence') < explicit.NODE_OPTIONS.indexOf('security-context-preload'));
    }
    assert.throws(() => isolatedAppEnvironment(f, 'web', {}, null, config), /explicit/);
    assert.throws(() => isolatedAppEnvironment(f, 'web', { securityContextManifestFile: manifestFile, healthSmoke: {} }, null, config));
    assert.throws(() => isolatedAppEnvironment(f, 'web', { securityContextManifestFile: manifestFile }, {}, config));
    const wrong = structuredClone(config); wrong.services.web.path = resolve(root, '../wrong.json');
    assert.throws(() => isolatedAppEnvironment(f, 'web', { securityContextManifestFile: manifestFile }, null, wrong), /outside/);
  } finally { if (old === undefined) delete process.env.SYNA_SECURITY_CONTEXT_PRELOAD; else process.env.SYNA_SECURITY_CONTEXT_PRELOAD = old; }
});

test('opt-in freezes source, private manifest, prompts and both services; no config alone claims coverage', async t => {
  const x = await fixture(t), created = await createSecurityContextRuntime(x.startup);
  assert.equal(created.services.web.nonce === created.services.eve.nonce, false);
  assert.ok(!JSON.stringify(created).includes(x.sources.trials[0].private.marker));
  assert.equal(created.coverage, undefined);
  for (const service of ['web', 'eve']) {
    const bytes = await readFile(created.services[service].path), value = JSON.parse(bytes);
    assert.equal(hash(bytes), created.services[service].configHash); assert.equal(value.manifestHash, x.startup.manifestHash);
    assert.equal(value.trialPromptHashes.length, 6); assert.equal(value.canaries.length, 9);
    assert.equal(value.trialPromptHashes[0], hash(securityChatPrompt(x.f.app.origin, 'other-owner', x.sources.trials[0])));
  }
  await assert.rejects(verifySecurityContextRuntime(x.startup, runtimeFor(created), {}));
  const old = structuredClone(x.manifest); delete old.contextObservation; await writeFile(x.manifestFile, JSON.stringify(old));
  await assert.rejects(securityContextStartup(x.manifestFile, x.f, x.source, x.root), /explicit locked opt-in/);
  await writeFile(x.manifestFile, JSON.stringify(x.manifest));
  await assert.rejects(securityContextStartup(x.manifestFile, { ...x.f, runtimeScope: 'autonomy-test:other' }, x.source, x.root));
  await writeFile(resolve(x.root, 'eve/tests/helpers/security-context-provider.mjs'), '// changed snapshot');
  await assert.rejects(securityContextStartup(x.manifestFile, x.f, x.source, x.root), /Frozen observer differs/);
});

test('ready receipt must bind actual listener PID and exact config, not Eve launcher or stale process', async t => {
  const x = await fixture(t), created = await createSecurityContextRuntime(x.startup), runtime = runtimeFor(created);
  const createdAt = new Date(Date.now() - 1000).toISOString(), identities = { web: { main: { pid: 101 }, listener: { pid: 101, createdAt } }, eve: { main: { pid: 201 }, listener: { pid: 202, createdAt } } };
  await syntheticReady(created, x.root, identities);
  const result = await verifySecurityContextRuntime(x.startup, runtime, identities);
  assert.equal(result.coverage, 'unknown'); assert.equal(result.gate, false); assert.equal(result.processes.find(p => p.service === 'eve').pid, 202);
  await assert.rejects(verifySecurityContextRuntime(x.startup, runtime, { ...identities, eve: { ...identities.eve, listener: { pid: 201, createdAt } } }));
  await assert.rejects(verifySecurityContextRuntime(x.startup, runtime, { ...identities, web: { ...identities.web, listener: { pid: 101, createdAt: new Date(Date.now() + 10000).toISOString() } } }), /predates/);
  const wrong = structuredClone(runtime); wrong.securityContext.services.eve = created.services.web;
  await assert.rejects(verifySecurityContextRuntime(x.startup, wrong, identities));
  await assert.rejects(verifySecurityContextRuntime(x.startup, { ...runtime, reportFault: {} }, identities));
});

test('expired observer may be read historically but cannot be started or armed afresh', async t => {
  const x = await fixture(t), now = Date.now() - 10000;
  const created = await createSecurityContextRuntime(x.startup, { now, deadlineAt: new Date(now + 1000).toISOString() });
  const createdAt = new Date(now).toISOString(), identities = { web: { main: { pid: 301 }, listener: { pid: 301, createdAt } }, eve: { main: { pid: 401 }, listener: { pid: 402, createdAt } } };
  await syntheticReady(created, x.root, identities);
  await assert.rejects(verifySecurityContextRuntime(x.startup, runtimeFor(created), identities));
  const observation = await verifySecurityContextRuntime(x.startup, runtimeFor(created), identities, { allowExpired: true });
  assert.equal(observation.coverage, 'unknown'); await assert.rejects(armSecurityContextTrial(observation, x.startup.trialPromptHashes[0]));
  await assert.rejects(createSecurityContextRuntime(x.startup, { deadlineAt: new Date(Date.now() + 72000000).toISOString() }));
});

test('two network-free real child preloads yield bounded trial chains; missing physical calls remain unknown', { timeout: 20000 }, async t => {
  const children = [], identities = {};
  t.after(async () => { for (const child of children) if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } });
  const x = await fixture(t), created = await createSecurityContextRuntime(x.startup), runtime = runtimeFor(created);
  const prompt = securityChatPrompt(x.f.app.origin, 'other-owner', x.sources.trials[0]);
  for (const service of ['web', 'eve']) {
    const cwd = resolve(x.root, service), stub = resolve(cwd, 'stub.mjs'), main = resolve(cwd, 'fixture.mjs');
    await writeFile(stub, "globalThis.fetch = async () => new Response('{}', {status:200});\n");
    await writeFile(main, `process.send({kind:'ready'}); process.on('message', async m => { if(m.kind==='go') { const firstSubmissionAt=Date.now(); await fetch('https://api.grunden.ai/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'synthetic',messages:[{role:'user',content:m.prompt}]})}); process.send({kind:'done',firstSubmissionAt,lastTerminalAt:Date.now()}); } });\n`);
    const createdAt = new Date().toISOString(), child = spawn(process.execPath, ['--import', pathToFileURL(stub).href, '--import', pathToFileURL(resolve(cwd, 'tests/helpers/security-context-preload.mjs')).href, main],
      { cwd, env: { ...process.env, SYNA_SECURITY_CONTEXT_PRELOAD: '1', SYNA_SECURITY_CONTEXT_CONFIG: created.services[service].path, PAT_RUNTIME_SCOPE: x.f.runtimeScope }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child); let errors = ''; child.stderr.on('data', b => { errors += b; });
    const [message] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(`Fixture child exited: ${errors}`); })]);
    assert.equal(message.kind, 'ready'); identities[service] = { main: { pid: child.pid }, listener: { pid: child.pid, createdAt } };
  }
  const observation = await verifySecurityContextRuntime(x.startup, runtime, identities), trialPromptHash = hash(prompt);
  let arms = await armSecurityContextTrial(observation, trialPromptHash), done = once(children[1], 'message'); children[1].send({ kind: 'go', prompt });
  const [window] = await done;
  let result = await finishSecurityContextTrial(observation, arms, { ...window, trialPromptHash, terminalObserved: true, providerSteps: 1 });
  assert.equal(result.coverage, 'complete'); assert.equal(result.canaryNonLeakage, 'observed_absent'); assert.equal(result.gate, false);
  assert.equal(result.processes[0].audit.calls, 0); assert.equal(result.processes[1].audit.calls, 1);
  assert.ok(!JSON.stringify(result).includes(prompt)); assert.ok(!JSON.stringify(result).includes(x.sources.trials[0].private.marker));
  arms = await armSecurityContextTrial(observation, trialPromptHash); done = once(children[1], 'message'); children[1].send({ kind: 'go', prompt });
  const [second] = await done;
  result = await finishSecurityContextTrial(observation, arms, { ...second, trialPromptHash, terminalObserved: true, providerSteps: 2 });
  assert.equal(result.coverage, 'unknown'); assert.equal(result.canaryNonLeakage, 'not_verified'); assert.equal(result.countsAgree, false);
});
