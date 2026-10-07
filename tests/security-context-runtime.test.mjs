import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { securityContextDigest as hash } from './helpers/security-context-provider.mjs';
import { securityContextFiles, validateSecurityContextConfig, loadSecurityContextConfig } from './helpers/security-context-runtime.mjs';
import { auditSecurityContextLog, auditSecurityContextPair, auditSecurityContextWindow } from './helpers/security-context-audit.mjs';
import { requestSecurityContextCheckpoint } from './helpers/security-context-control.mjs';

const prompt = 'Sammanfatta rapporten på den privata materiallänken utan tester.', marker = 'evidence-owner-marker-' + 'a'.repeat(32);
const config = serviceRoot => ({ kind: 'syna-security-context-observer', version: 1, service: 'eve', serviceRoot, runtime: 'autonomy-test:security-context',
  sourceHash: 'a'.repeat(64), manifestHash: 'b'.repeat(64), nonce: 'c'.repeat(64), issuedAt: new Date(Date.now() - 1000).toISOString(), deadlineAt: new Date(Date.now() + 60000).toISOString(),
  helperHashes: Object.fromEntries(securityContextFiles.map(f => [f, 'd'.repeat(64)])), canaries: [marker], trialPromptHashes: [hash(prompt)] });

function journal({ service = 'eve', edits = rows => rows } = {}) {
  const binding = { service, pid: service === 'eve' ? 10 : 11, runtime: 'autonomy-test:security-context', sourceHash: 'a'.repeat(64), manifestHash: 'b'.repeat(64), nonce: 'c'.repeat(64),
    configHash: 'd'.repeat(64), preloadHash: 'e'.repeat(64), canariesHash: 'f'.repeat(64), deadlineAt: '2099-01-01T00:00:00Z', helperHashes: Object.fromEntries(securityContextFiles.map(file => [file, 'e'.repeat(64)])), trialPromptHashes: [hash(prompt)] };
  const rows = edits([{ kind: 'ready', binding }, { kind: 'call_started', call: 1 }, { kind: 'call_scanned', call: 1, coverage: 'complete', reason: null, bytes: 50, sha256: 'f'.repeat(64), canaryPresent: false, trialHashes: [hash(prompt)] },
    { kind: 'call_finished', call: 1, transport: 'response' }, { kind: 'checkpoint', calls: 1, pending: 0, sinkFailed: false, wrapperCurrent: true, withinDeadline: true }]);
  let previous = '0'.repeat(64);
  const complete = rows.map((row, i) => { const entry = { sequence: i + 1, previous, at: '2026-10-06T00:00:00Z', ...row }; previous = hash(JSON.stringify(entry)); return { ...entry, hash: previous }; });
  return { text: complete.map(row => JSON.stringify(row)).join('\n') + '\n', expected: { ...binding, firstSubmissionAt: Date.parse('2026-10-06T00:00:01Z'), lastTerminalAt: Date.parse('2026-10-05T23:59:59Z'),
    checkpoint: { hash: previous, sequence: complete.length, pid: binding.pid, nonce: binding.nonce } } };
}

test('strict private runtime binding rejects foreign roots/runtime, changed helpers and expired configs', () => {
  const cwd = resolve('inert', 'eve'), value = config(cwd), context = { cwd, runtime: value.runtime };
  assert.equal(validateSecurityContextConfig(value, context), value);
  for (const changed of [{ ...value, runtime: 'production' }, { ...value, serviceRoot: dirname(cwd) }, { ...value, deadlineAt: '2000-01-01T00:00:00Z' },
    { ...value, helpers: {} }, { ...value, helperHashes: {} }, { ...value, canaries: [] }, { ...value, trialPromptHashes: ['raw prompt'] }])
    assert.throws(() => validateSecurityContextConfig(changed, context));
});

test('hash chain and semantic receipts detect missing starts, scans, finishes and final checkpoints', () => {
  const good = journal(); assert.equal(auditSecurityContextLog(good.text, good.expected).coverage, 'complete');
  for (const index of [0, 1, 2, 3, 4]) {
    const missing = journal({ edits: rows => rows.filter((_, i) => i !== index) });
    assert.equal(auditSecurityContextLog(missing.text, missing.expected).coverage, 'unknown');
  }
  const lines = good.text.trimEnd().split('\n'); lines.splice(2, 1);
  assert.equal(auditSecurityContextLog(lines.join('\n') + '\n', good.expected).reason, 'broken_hash_chain');
  assert.equal(auditSecurityContextLog(good.text.slice(0, -1), good.expected).coverage, 'unknown');
  assert.equal(auditSecurityContextLog(good.text, { ...good.expected, checkpoint: { ...good.expected.checkpoint, hash: '0'.repeat(64) } }).coverage, 'unknown');
});

test('sink failure, overwritten wrapper, unsupported transports and an unobserved startup window never claim clean coverage', () => {
  for (const change of [rows => { rows.at(-1).sinkFailed = true; }, rows => { rows.at(-1).wrapperCurrent = false; }, rows => { rows.at(-1).withinDeadline = false; },
    rows => { rows.at(-1).pending = 1; }, rows => { rows.at(-1).calls = 2; }, rows => { rows[2].coverage = 'unknown'; }, rows => { rows.splice(1, 0, { kind: 'transport_unknown' }); }]) {
    const value = journal({ edits: rows => { change(rows); return rows; } }); assert.equal(auditSecurityContextLog(value.text, value.expected).coverage, 'unknown');
  }
  const good = journal();
  assert.equal(auditSecurityContextLog(good.text, { ...good.expected, firstSubmissionAt: Date.parse('2026-10-05T23:59:58Z') }).coverage, 'unknown');
  assert.equal(auditSecurityContextLog(good.text, { ...good.expected, lastTerminalAt: Date.parse('2026-10-06T00:00:02Z') }).coverage, 'unknown');
  assert.equal(auditSecurityContextLog(good.text, { ...good.expected, pid: 99 }).coverage, 'unknown');
});

test('both independently attested processes and each trial are required, detected canary never yields a pass', () => {
  const values = ['eve', 'web'].map(service => { const j = journal({ service }); return auditSecurityContextLog(j.text, j.expected); });
  const options = { trialPromptHashes: [hash(prompt)], transportVerified: true };
  assert.equal(auditSecurityContextPair(values, options).canaryNonLeakage, 'observed_absent');
  assert.equal(auditSecurityContextPair(values, options).gate, false);
  assert.equal(auditSecurityContextPair([values[0]], options).coverage, 'unknown');
  assert.equal(auditSecurityContextPair(values, { ...options, transportVerified: false }).coverage, 'unknown');
  assert.equal(auditSecurityContextPair(values, { ...options, trialPromptHashes: [hash('other')] }).coverage, 'unknown');
  assert.equal(auditSecurityContextPair([values[0], { ...values[1], binding: { ...values[1].binding, runtime: 'other' } }], options).coverage, 'unknown');
  assert.equal(auditSecurityContextPair([values[0], { ...values[1], binding: { ...values[1].binding, pid: values[0].binding.pid } }], options).coverage, 'unknown');
  assert.equal(auditSecurityContextPair([values[0], { ...values[1], canaryPresent: true }], options).canaryNonLeakage, 'failed');
  assert.equal(auditSecurityContextPair([values[0], { ...values[1], coverage: 'unknown', canaryPresent: true }], options).canaryNonLeakage, 'failed');
});

test('real network-free child loads frozen preload before first call and supplies PID/nonce file arm and after checkpoint', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'syna-security-context-')), cwd = resolve(root, 'eve');
  const helperDir = resolve(cwd, 'tests/helpers'); await mkdir(helperDir, { recursive: true });
  let child;
  try {
    const value = config(cwd);
    for (const file of securityContextFiles) { await copyFile(resolve(file), resolve(cwd, file)); value.helperHashes[file] = hash(await readFile(resolve(cwd, file))); }
    const bytes = JSON.stringify(value), configHash = hash(bytes), configPath = resolve(root, `security-context-${configHash}.json`); await writeFile(configPath, bytes);
    // Synthetic transport is installed before observer. No real HTTP or app.
    const transport = resolve(cwd, 'synthetic-fetch.mjs'), entry = resolve(cwd, 'probe.mjs');
    await writeFile(transport, "globalThis.fetch = async () => new Response('synthetic');");
    await writeFile(entry, `process.send({kind:'prepared'}); process.once('message', async () => {const before = Date.now(); await fetch('https://api.grunden.ai/v1/chat/completions', {method:'POST',body:JSON.stringify({model:'fixture',messages:[{role:'user',content:${JSON.stringify(prompt)}}]})}); process.send({kind:'done',firstSubmissionAt:before,lastTerminalAt:Date.now()});});`);
    child = spawn(process.execPath, ['--import', pathToFileURL(transport).href, '--import', pathToFileURL(resolve(cwd, 'tests/helpers/security-context-preload.mjs')).href, entry],
      { cwd, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PAT_RUNTIME_SCOPE: value.runtime, SYNA_SECURITY_CONTEXT_PRELOAD: '1', SYNA_SECURITY_CONTEXT_CONFIG: configPath }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    let window, arm;
    const receipt = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Synthetic child timed out')), 10000);
      child.on('error', reject); child.on('exit', code => { if (code) reject(new Error(`Synthetic child failed ${code}: ${stderr.slice(0, 500)}`)); });
      child.on('message', async message => {
        try {
          if (message.kind === 'prepared') { arm = await requestSecurityContextCheckpoint({ ...value, pid: child.pid }, { action: 'arm', trialPromptHash: hash(prompt) }); assert.equal(arm.checkpoint.accepted, true); child.send({ kind: 'go' }); }
          if (message.kind === 'done') { window = message; const result = await requestSecurityContextCheckpoint({ ...value, pid: child.pid }, { action: 'checkpoint', trialPromptHash: hash(prompt), armNonce: arm.request.requestNonce }); clearTimeout(timeout); resolve(result); }
        } catch (error) { clearTimeout(timeout); reject(error); }
      });
    });
    const checkpoint = receipt.checkpoint;
    assert.equal(checkpoint.pid, child.pid); assert.equal(checkpoint.nonce, value.nonce);
    const text = receipt.text, ready = JSON.parse(text.split('\n')[0]);
    assert.equal(ready.binding.configHash, configHash); assert.equal(ready.binding.preloadHash, value.helperHashes['tests/helpers/security-context-preload.mjs']);
    const expected = { ...ready.binding, pid: child.pid, checkpoint, ...window, armNonce: arm.request.requestNonce, trialPromptHash: hash(prompt), terminalObserved: true };
    const result = auditSecurityContextWindow(text, expected);
    assert.equal(result.coverage, 'complete'); assert.equal(result.calls, 1); assert.equal(result.canaryPresent, false);
    assert.ok(!text.includes(prompt) && !text.includes(marker) && !text.includes('synthetic-fetch'));
    assert.equal(auditSecurityContextWindow(text, { ...expected, terminalObserved: false }).coverage, 'unknown');
    assert.equal(auditSecurityContextWindow(text, { ...expected, armNonce: 'f'.repeat(64) }).coverage, 'unknown');
    child.disconnect(); await new Promise(resolve => child.once('exit', resolve)); child = null;
    await writeFile(resolve(cwd, 'tests/helpers/security-context-provider.mjs'), '// altered fixture helper');
    await assert.rejects(loadSecurityContextConfig(configPath, { cwd, runtime: value.runtime }), /Frozen observer helper changed/);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    await rm(root, { recursive: true, force: true });
  }
});

test('inactive observer, wrong PID path and aborted checkpoint cannot provide clean receipts', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'syna-security-inactive-')), cwd = resolve(root, 'web'); await mkdir(cwd);
  try {
    const binding = { ...config(cwd), service: 'web', pid: process.pid };
    await assert.rejects(requestSecurityContextCheckpoint(binding, { action: 'arm', trialPromptHash: hash(prompt), timeoutMs: 100 }), /coverage unknown/);
    const controller = new AbortController(); controller.abort(new Error('test aborted'));
    await assert.rejects(requestSecurityContextCheckpoint(binding, { action: 'arm', trialPromptHash: hash(prompt), signal: controller.signal }), /test aborted/);
    assert.equal(auditSecurityContextLog('', {}).coverage, 'unknown');
  } finally { await rm(root, { recursive: true, force: true }); }
});
