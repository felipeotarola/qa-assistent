// Explicit --import only. Ordinary imports do not install an observer.
import assert from 'node:assert/strict';
import { openSync, writeSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { securityContextDigest, securityContextFetch } from './security-context-provider.mjs';
import { loadSecurityContextConfig } from './security-context-runtime.mjs';
import { securityContextPaths } from './security-context-control.mjs';

export async function installSecurityContextPreload(path) {
  assert.equal(process.env.SYNA_SECURITY_CONTEXT_PRELOAD, '1');
  const { value: config, configHash } = await loadSecurityContextConfig(path, { cwd: process.cwd(), runtime: process.env.PAT_RUNTIME_SCOPE });
  const output = resolve(dirname(config.serviceRoot), `security-context-${config.service}-${config.nonce}-${process.pid}.jsonl`);
  const fd = openSync(output, 'wx', 0o600); let sequence = 0, previous = '0'.repeat(64), failed = false, writtenBytes = 0;
  function record(data) {
    try {
      const event = { sequence: sequence + 1, previous, at: new Date().toISOString(), ...data };
      const line = { ...event, hash: securityContextDigest(JSON.stringify(event)) }, bytes = Buffer.from(JSON.stringify(line) + '\n');
      assert.ok(sequence < 9990 && writtenBytes + bytes.length < 8 * 1024 * 1024 - 4096 || data.kind === 'checkpoint' && sequence < 10000 && writtenBytes + bytes.length <= 8 * 1024 * 1024, 'Observer receipt limit reached');
      let offset = 0; while (offset < bytes.length) { const written = writeSync(fd, bytes, offset); assert.ok(written > 0); offset += written; }
      sequence++; writtenBytes += bytes.length; previous = line.hash;
    } catch (error) { failed = true; throw error; }
  }
  const binding = { service: config.service, pid: process.pid, parentPid: process.ppid, runtime: config.runtime, sourceHash: config.sourceHash,
    manifestHash: config.manifestHash, nonce: config.nonce, configHash, preloadHash: config.helperHashes['tests/helpers/security-context-preload.mjs'],
    helperHashes: config.helperHashes, deadlineAt: config.deadlineAt, canariesHash: securityContextDigest(JSON.stringify(config.canaries)), trialPromptHashes: config.trialPromptHashes };
  const observed = securityContextFetch(globalThis.fetch.bind(globalThis), { ...config, record });
  // The complete ready receipt precedes installation and all app imports.
  record({ kind: 'ready', binding }); globalThis.fetch = observed.fetch;
  const checkpoint = (nonce, extra = {}) => {
    assert.equal(nonce, config.nonce);
    record({ kind: 'checkpoint', ...observed.state(), sinkFailed: failed || observed.state().sinkFailed,
      wrapperCurrent: globalThis.fetch === observed.fetch, withinDeadline: Date.now() <= Date.parse(config.deadlineAt), ...extra });
    return { pid: process.pid, nonce, sequence, hash: previous, output };
  };
  // Future private launcher must provide IPC to the ACTUAL web/Eve process and
  // verify its PID, creation time and frozen output first. No network listener.
  // Without a fresh parent-requested checkpoint the audit remains unknown.
  if (typeof process.send === 'function') process.on('message', message => {
    if (message?.kind !== 'security-context-checkpoint' || message.nonce !== config.nonce) return;
    try { process.send?.({ kind: 'security-context-checkpoint', ...checkpoint(message.nonce) }); }
    catch { process.send?.({ kind: 'security-context-checkpoint-failed', pid: process.pid, nonce: config.nonce }); }
  });
  const paths = securityContextPaths({ ...config, pid: process.pid }), seen = new Map();
  let arm = null, timer, delay = 50;
  function poll() {
    if (Date.now() > Date.parse(config.deadlineAt)) return;
    let handled = false;
    try {
      assert.equal(realpathSync(paths.control), paths.control); const info = statSync(paths.control);
      assert.ok(info.isFile() && info.size <= 2048);
      const bytes = readFileSync(paths.control), request = JSON.parse(bytes), digest = securityContextDigest(bytes);
      assert.deepEqual(Object.keys(request).sort(), ['version', 'nonce', 'pid', 'requestNonce', 'action', 'trialPromptHash', 'armNonce', 'deadlineAt'].sort());
      assert.equal(request.version, 1); assert.equal(request.nonce, config.nonce); assert.equal(request.pid, process.pid);
      assert.match(request.requestNonce, /^[a-f0-9]{64}$/); assert.ok(['arm', 'checkpoint'].includes(request.action));
      assert.ok(config.trialPromptHashes.includes(request.trialPromptHash));
      if (!seen.has(request.requestNonce)) {
        const end = Date.parse(request.deadlineAt); assert.ok(end > Date.now() && end <= Date.parse(config.deadlineAt) && end <= Date.now() + 10000);
        assert.ok(seen.size < 64); seen.set(request.requestNonce, digest); handled = true;
        const state = observed.state(); let accepted = !failed && !state.sinkFailed && state.pending === 0 && globalThis.fetch === observed.fetch;
        if (request.action === 'arm') {
          accepted &&= arm === null && request.armNonce === null;
          if (accepted) arm = { nonce: request.requestNonce, trialPromptHash: request.trialPromptHash };
        } else accepted &&= arm?.nonce === request.armNonce && arm?.trialPromptHash === request.trialPromptHash;
        checkpoint(config.nonce, { action: request.action, requestNonce: request.requestNonce, trialPromptHash: request.trialPromptHash,
          armNonce: request.action === 'arm' ? request.requestNonce : request.armNonce, accepted });
        if (accepted && request.action === 'checkpoint') arm = null;
      } else if (seen.get(request.requestNonce) !== digest) { failed = true; }
    } catch (error) {
      // Missing/invalid requests never fabricate a reply. Invalid existing
      // control bytes poison coverage; ordinary absence is just idle polling.
      if (error.code !== 'ENOENT') failed = true;
    }
    delay = handled ? 50 : Math.min(500, delay * 2);
    timer = setTimeout(poll, Math.min(delay, Math.max(1, Date.parse(config.deadlineAt) - Date.now()))); timer.unref();
  }
  timer = setTimeout(poll, delay); timer.unref();
  return { binding, output, checkpoint };
}
if (process.env.SYNA_SECURITY_CONTEXT_PRELOAD === '1') {
  assert.ok(process.env.SYNA_SECURITY_CONTEXT_CONFIG, 'Explicit private observer configuration is required');
  await installSecurityContextPreload(process.env.SYNA_SECURITY_CONTEXT_CONFIG);
}
