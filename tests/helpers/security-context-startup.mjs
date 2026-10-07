// Explicit SEC-only startup/receipt adapter. No HTTP, app, DB or model imports.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityContextDigest } from './security-context-provider.mjs';
import { securityContextFiles, securityContextIntegrationFiles, loadSecurityContextConfig, validateSecurityContextConfig } from './security-context-runtime.mjs';
import { securityContextPaths, requestSecurityContextCheckpoint } from './security-context-control.mjs';
import { auditSecurityContextWindow, auditSecurityContextPair } from './security-context-audit.mjs';
import { SECURITY_CHAT_CODE_FILES, validateSecurityChatManifest, securityChatPrompt } from './evidence-security-chat.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const owned = (base, path) => { const sub = relative(base, path); return sub && sub !== '..' && !sub.startsWith(`..${sep}`) && !isAbsolute(sub); };
async function physicalBytes(path, root, limit) {
  const actual = resolve(path); assert.ok(owned(resolve(root), actual)); assert.equal(await realpath(actual), actual);
  const info = await stat(actual); assert.ok(info.isFile() && info.size <= limit);
  const bytes = await readFile(actual); assert.ok(bytes.length <= limit); return bytes;
}

/** Validation does not install or certify an observer. Config creation is a
 * separate step performed only after the caller's stopped-process guard. */
export async function securityContextStartup(manifestFile, fixture, source, root) {
  const privateRoot = resolve(repository, '.data/autonomy-isolation');
  assert.ok(owned(privateRoot, resolve(root))); assert.equal(await realpath(root), resolve(root));
  const bytes = await physicalBytes(manifestFile, privateRoot, 1024 * 1024), manifest = JSON.parse(bytes);
  const sourceBytes = await physicalBytes(manifest.sources.path, privateRoot, 32 * 1024 * 1024);
  assert.equal(securityContextDigest(sourceBytes), manifest.sources.sha256);
  const sources = JSON.parse(sourceBytes); validateSecurityChatManifest(manifest, sources);
  assert.ok(manifest.contextObservation, 'SEC provider observation requires an explicit locked opt-in');
  assert.equal(manifest.sourceHash, source.sourceSha256); assert.equal(manifest.sourceHash, fixture.app.sourceSha256);
  assert.equal(manifest.runtime, fixture.runtimeScope); assert.equal(resolve(fixture.app.root), resolve(root));
  assert.equal(fixture.app.origin, 'http://127.0.0.1:58000');
  for (const [key, file] of Object.entries(SECURITY_CHAT_CODE_FILES))
    assert.equal(securityContextDigest(await readFile(resolve(repository, file))), manifest.code[key], 'SEC harness differs from the locked manifest');
  for (const file of securityContextIntegrationFiles) {
    const expected = manifest.contextObservation.helperHashes[file];
    assert.equal(securityContextDigest(await readFile(resolve(repository, file))), expected, 'Observer integration differs from locked manifest');
    if (securityContextFiles.includes(file)) for (const service of ['web', 'eve']) {
      assert.ok(source.files.includes(file), 'Observer is absent from the frozen source');
      assert.equal(securityContextDigest(await physicalBytes(resolve(root, service, file), root, 1024 * 1024)), expected, 'Frozen observer differs from locked manifest');
    }
  }
  return { manifest, manifestFile: resolve(manifestFile), manifestHash: securityContextDigest(bytes), root: resolve(root),
    canaries: sources.trials.flatMap(t => [t.allowed.marker, t.private.marker, t.foreignRuntime.marker]),
    trialPromptHashes: manifest.trials.map(t => securityContextDigest(securityChatPrompt(fixture.app.origin, t.variant, sources.trials[t.sourceTrial]))) };
}

export async function createSecurityContextRuntime(startup, { now = Date.now(), deadlineAt = new Date(now + 7200000).toISOString() } = {}) {
  const { manifest, root, manifestHash } = startup;
  const common = { version: 1, scope: manifest.contextObservation.scope, manifestFile: startup.manifestFile, manifestHash,
    sourceHash: manifest.sourceHash, runtime: manifest.runtime, helperHashes: manifest.contextObservation.helperHashes, deadlineAt };
  const services = {};
  for (const service of ['web', 'eve']) {
    const value = validateSecurityContextConfig({ kind: 'syna-security-context-observer', version: 1, service, serviceRoot: resolve(root, service),
      runtime: manifest.runtime, sourceHash: manifest.sourceHash, manifestHash, nonce: randomBytes(32).toString('hex'),
      issuedAt: new Date(now).toISOString(), deadlineAt, helperHashes: Object.fromEntries(securityContextFiles.map(file => [file, common.helperHashes[file]])),
      canaries: startup.canaries, trialPromptHashes: startup.trialPromptHashes }, { cwd: resolve(root, service), runtime: manifest.runtime, now });
    const bytes = JSON.stringify(value, null, 2), configHash = securityContextDigest(bytes), path = resolve(root, `security-context-${configHash}.json`);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    services[service] = { path, configHash, nonce: value.nonce };
  }
  return { ...common, services };
}

/** Uses the ACTUAL verified listener PID, not the Eve CLI launcher PID. Ready
 * alone is not context proof: each trial still needs fresh arm/end receipts. */
export async function verifySecurityContextRuntime(startup, runtime, identities, { allowExpired = false } = {}) {
  const { manifest, root } = startup, recorded = runtime.securityContext;
  assert.ok(recorded && runtime.mode === 'application' && !runtime.reportFault, 'SEC observer cannot share a fault/smoke runtime');
  assert.equal(recorded.version, 1); assert.equal(recorded.scope, manifest.contextObservation.scope);
  assert.equal(recorded.manifestFile, startup.manifestFile); assert.equal(recorded.manifestHash, startup.manifestHash);
  assert.equal(recorded.sourceHash, manifest.sourceHash); assert.equal(recorded.runtime, manifest.runtime);
  assert.deepEqual(recorded.helperHashes, manifest.contextObservation.helperHashes);
  assert.equal(runtime.modelRequestIntervalMs ?? 0, manifest.modelRequestIntervalMs);
  assert.deepEqual(Object.keys(recorded.services).sort(), ['eve', 'web']);
  const processes = [];
  for (const service of ['web', 'eve']) {
    const saved = recorded.services[service], serviceRoot = resolve(root, service);
    const { value, configHash } = await loadSecurityContextConfig(saved.path, { cwd: serviceRoot, runtime: manifest.runtime, allowExpired });
    assert.equal(configHash, saved.configHash); assert.equal(value.nonce, saved.nonce);
    assert.equal(value.sourceHash, manifest.sourceHash); assert.equal(value.manifestHash, startup.manifestHash); assert.equal(value.deadlineAt, recorded.deadlineAt);
    assert.deepEqual(value.canaries, startup.canaries); assert.deepEqual(value.trialPromptHashes, startup.trialPromptHashes);
    assert.deepEqual(value.helperHashes, Object.fromEntries(securityContextFiles.map(file => [file, recorded.helperHashes[file]])));
    const listener = identities?.[service]?.listener; assert.ok(listener && Number.isSafeInteger(listener.pid) && listener.pid > 0);
    const binding = { serviceRoot, service, pid: listener.pid, nonce: value.nonce, deadlineAt: value.deadlineAt };
    const paths = securityContextPaths(binding), bytes = await physicalBytes(paths.output, root, 8 * 1024 * 1024);
    const line = bytes.toString('utf8').split('\n')[0], ready = JSON.parse(line), { hash, ...data } = ready;
    assert.equal(ready.kind, 'ready'); assert.equal(ready.sequence, 1); assert.equal(ready.previous, '0'.repeat(64)); assert.equal(hash, securityContextDigest(JSON.stringify(data)));
    const expected = { ...binding, runtime: value.runtime, sourceHash: value.sourceHash, manifestHash: value.manifestHash, configHash,
      preloadHash: value.helperHashes['tests/helpers/security-context-preload.mjs'], helperHashes: value.helperHashes,
      canariesHash: securityContextDigest(JSON.stringify(value.canaries)), trialPromptHashes: value.trialPromptHashes };
    for (const [key, field] of Object.entries(expected)) if (key !== 'serviceRoot') assert.deepEqual(ready.binding[key], field, 'SEC startup does not match the exact process/config');
    assert.ok(Date.parse(ready.at) >= Date.parse(listener.createdAt) - 1000 && Date.parse(ready.at) <= Date.now(), 'SEC ready receipt predates the verified process');
    // Process identity comes from the caller's CIM/executable/argv/listener
    // guard. This records its binding; it does not trust a self-reported PID.
    processes.push({ ...expected, processIdentity: listener, readyHash: hash, output: paths.output });
  }
  return { version: 1, scope: recorded.scope, manifestHash: startup.manifestHash, processes, coverage: 'unknown', gate: false };
}

export async function armSecurityContextTrial(observation, trialPromptHash) {
  const arms = [];
  for (const process of observation.processes) {
    const reply = await requestSecurityContextCheckpoint(process, { action: 'arm', trialPromptHash });
    assert.equal(reply.checkpoint.accepted, true, 'SEC process could not arm; do not submit a model request');
    arms.push({ service: process.service, pid: process.pid, armNonce: reply.request.requestNonce, checkpoint: reply.checkpoint });
  }
  return arms;
}

/** Never infers completion from config/startup. Both live hash chains, exact
 * trial windows, and a settled independent event prefix must agree. This
 * sidecar never changes the legacy SEC oracle or certifies overall PASS. */
export async function finishSecurityContextTrial(observation, arms, { trialPromptHash, firstSubmissionAt, lastTerminalAt, terminalObserved, providerSteps }) {
  const processes = [], receipts = [];
  for (const process of observation.processes) {
    const arm = arms.find(a => a.service === process.service && a.pid === process.pid);
    try {
      assert.ok(arm);
      const reply = await requestSecurityContextCheckpoint(process, { action: 'checkpoint', trialPromptHash, armNonce: arm.armNonce });
      const audited = auditSecurityContextWindow(reply.text, { ...process, checkpoint: reply.checkpoint, armNonce: arm.armNonce,
        trialPromptHash, firstSubmissionAt, lastTerminalAt, terminalObserved });
      processes.push(audited);
      receipts.push({ service: process.service, pid: process.pid, processIdentity: process.processIdentity, readyHash: process.readyHash,
        arm, checkpoint: reply.checkpoint, output: process.output, receiptPrefix: reply.text, receiptPrefixHash: securityContextDigest(reply.text), audit: audited });
    } catch { processes.push({ coverage: 'unknown', reason: 'process_checkpoint_unavailable', canaryPresent: null, trialHashes: [] });
      receipts.push({ service: process.service, pid: process.pid, coverage: 'unknown', reason: 'process_checkpoint_unavailable' }); }
  }
  // Default SDK fetch is verified by the installed-SDK regression. In this
  // particular SEC protocol no secondary web model is allowed. Also require
  // physical Eve request counts to agree with the independent step prefix;
  // a bypass, retry, child turn or missing receipt remains unknown.
  const countsAgree = terminalObserved === true && Number.isSafeInteger(providerSteps) && providerSteps > 0
    && processes.find(p => p.binding?.service === 'web')?.calls === 0
    && processes.find(p => p.binding?.service === 'eve')?.calls === providerSteps;
  const pair = auditSecurityContextPair(processes, { trialPromptHashes: [trialPromptHash], transportVerified: countsAgree });
  // A positively observed leak is still a finding when some OTHER call or
  // process is unobservable; incomplete coverage cannot excuse that finding.
  if (processes.some(p => p.canaryPresent === true)) pair.canaryNonLeakage = 'failed';
  return { version: 1, scope: observation.scope, manifestHash: observation.manifestHash, trialPromptHash, firstSubmissionAt, lastTerminalAt,
    terminalObserved, providerSteps, countsAgree, processes: receipts, ...pair, independentReview: 'pending', gate: false };
}
