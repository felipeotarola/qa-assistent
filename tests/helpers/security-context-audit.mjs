// Pure receipt verification. This never promotes the SEC harness's gate.
import { securityContextDigest } from './security-context-provider.mjs';
import { securityContextFiles } from './security-context-runtime.mjs';

export function auditSecurityContextLog(text, expected) {
  const fail = reason => ({ coverage: 'unknown', reason, calls: null, canaryPresent: null, trialHashes: [] });
  if (typeof text !== 'string' || Buffer.byteLength(text) > 8 * 1024 * 1024 || !text.endsWith('\n')) return fail('incomplete_or_oversize_log');
  let rows;
  try { rows = text.trimEnd().split('\n').map(line => JSON.parse(line)); } catch { return fail('invalid_jsonl'); }
  if (rows.length < 2 || rows.length > 10000 || rows[0]?.kind !== 'ready' || rows.at(-1)?.kind !== 'checkpoint') return fail('missing_start_or_checkpoint');
  let previous = '0'.repeat(64), lastAt = -Infinity;
  for (const [index, row] of rows.entries()) {
    const { hash, ...data } = row;
    if (row.sequence !== index + 1 || row.previous !== previous || hash !== securityContextDigest(JSON.stringify(data))) return fail('broken_hash_chain');
    const at = Date.parse(row.at); if (!Number.isFinite(at) || at < lastAt) return fail('invalid_observation_clock'); lastAt = at;
    previous = hash;
  }
  const binding = rows[0].binding;
  if (!binding || !['web', 'eve'].includes(binding.service) || !Number.isSafeInteger(binding.pid) || binding.pid <= 0
    || !/^autonomy-test:[a-z0-9-]+$/.test(binding.runtime)
    || JSON.stringify(Object.keys(binding.helperHashes ?? {}).sort()) !== JSON.stringify([...securityContextFiles].sort())
    || Object.values(binding.helperHashes).some(value => !/^[a-f0-9]{64}$/.test(value))
    || binding.preloadHash !== binding.helperHashes['tests/helpers/security-context-preload.mjs']) return fail('invalid_start_binding');
  for (const key of ['service', 'pid', 'runtime', 'sourceHash', 'manifestHash', 'nonce', 'configHash', 'preloadHash', 'canariesHash', 'deadlineAt'])
    if (expected[key] == null || binding?.[key] !== expected[key]) return fail('binding_mismatch');
  if (JSON.stringify(binding.helperHashes) !== JSON.stringify(expected.helperHashes)
    || JSON.stringify(binding.trialPromptHashes) !== JSON.stringify(expected.trialPromptHashes)) return fail('binding_mismatch');
  if (expected.checkpoint?.hash !== rows.at(-1).hash || expected.checkpoint.sequence !== rows.at(-1).sequence
    || expected.checkpoint.pid !== binding.pid || expected.checkpoint.nonce !== binding.nonce) return fail('checkpoint_not_attested');
  if (!(Date.parse(rows[0].at) <= expected.firstSubmissionAt) || !(Date.parse(rows.at(-1).at) >= expected.lastTerminalAt)) return fail('observation_window_not_covered');
  const calls = new Map(), hashes = new Set(); let uncertain = false, leaked = false;
  for (const row of rows.slice(1, -1)) {
    if (row.kind === 'checkpoint') continue;
    if (row.kind === 'transport_unknown') { uncertain = true; continue; }
    if (!Number.isSafeInteger(row.call) || row.call < 1) return fail('invalid_call');
    const call = calls.get(row.call) ?? {};
    if (row.kind === 'call_started' && !call.started) call.started = true;
    else if (row.kind === 'call_scanned' && call.started && !call.scanned && !call.finished) {
      call.scanned = true; uncertain ||= row.coverage !== 'complete'; leaked ||= row.canaryPresent === true;
      if (row.coverage === 'complete' && (!Number.isSafeInteger(row.bytes) || row.bytes < 1 || !/^[a-f0-9]{64}$/.test(row.sha256)
        || typeof row.canaryPresent !== 'boolean' || row.trialHashes?.length !== 1 || !binding.trialPromptHashes.includes(row.trialHashes[0]))) return fail('invalid_scan_receipt');
      for (const hash of row.trialHashes ?? []) hashes.add(hash);
    } else if (row.kind === 'call_finished' && call.scanned && !call.finished && ['response', 'rejected'].includes(row.transport)) call.finished = true;
    else return fail('missing_or_duplicate_call_event');
    calls.set(row.call, call);
  }
  const end = rows.at(-1);
  if (end.sinkFailed || !end.wrapperCurrent || !end.withinDeadline || end.pending !== 0 || end.calls !== calls.size
    || [...calls].some(([id, call]) => id > calls.size || !call.finished)) return fail('incomplete_transport_or_observer');
  return { coverage: uncertain ? 'unknown' : 'complete', reason: uncertain ? 'unscannable_request' : null, calls: calls.size,
    canaryPresent: leaked, trialHashes: [...hashes].sort(), binding: { service: binding.service, pid: binding.pid, sourceHash: binding.sourceHash,
      runtime: binding.runtime, manifestHash: binding.manifestHash, canariesHash: binding.canariesHash, trialPromptHashes: binding.trialPromptHashes } };
}

export function auditSecurityContextPair(processes, { trialPromptHashes, transportVerified }) {
  if (transportVerified !== true || processes.length !== 2 || !['web', 'eve'].every(service => processes.filter(p => p.binding?.service === service).length === 1)
    || new Set(processes.map(p => p.binding.pid)).size !== 2
    || ['sourceHash', 'runtime', 'manifestHash', 'canariesHash'].some(key => new Set(processes.map(p => p.binding[key])).size !== 1)
    || new Set(processes.map(p => JSON.stringify(p.binding.trialPromptHashes))).size !== 1
    || processes.some(p => trialPromptHashes.some(hash => !p.binding.trialPromptHashes.includes(hash))))
    return { coverage: 'unknown', canaryNonLeakage: 'not_verified', gate: false };
  if (processes.some(p => p.canaryPresent)) return { coverage: processes.some(p => p.coverage !== 'complete') ? 'unknown' : 'complete', canaryNonLeakage: 'failed', gate: false };
  if (processes.some(p => p.coverage !== 'complete')) return { coverage: 'unknown', canaryNonLeakage: 'not_verified', gate: false };
  if (!trialPromptHashes.length || trialPromptHashes.some(hash => !processes.some(p => p.trialHashes.includes(hash))))
    return { coverage: 'unknown', canaryNonLeakage: 'not_verified', gate: false };
  return { coverage: 'complete', canaryNonLeakage: 'observed_absent', calls: processes.reduce((n, p) => n + p.calls, 0), gate: false,
    limitation: 'Exact fixture canaries in observed physical request JSON only; no assertion about arbitrary paraphrases or the overall SEC gate.' };
}

/** Adds an exact before/after arm window to the cumulative integrity audit.
 * terminalObserved comes from the independent SEC durable-stream observer;
 * a fetch response receipt alone only proves headers, not a finished model. */
export function auditSecurityContextWindow(text, expected) {
  const base = auditSecurityContextLog(text, expected);
  if (base.coverage !== 'complete') return base;
  const rows = text.trimEnd().split('\n').map(line => JSON.parse(line)), end = rows.at(-1);
  const arms = rows.filter(row => row.kind === 'checkpoint' && row.action === 'arm' && row.requestNonce === expected.armNonce);
  const fail = () => ({ ...base, coverage: 'unknown', reason: 'arm_window_not_attested' });
  if (expected.terminalObserved !== true || arms.length !== 1 || !arms[0].accepted || arms[0].pending !== 0 || arms[0].sinkFailed
    || !arms[0].wrapperCurrent || !arms[0].withinDeadline || Date.parse(arms[0].at) > expected.firstSubmissionAt
    || end.action !== 'checkpoint' || !end.accepted || end.armNonce !== expected.armNonce || end.trialPromptHash !== expected.trialPromptHash
    || arms[0].trialPromptHash !== expected.trialPromptHash) return fail();
  const scoped = rows.filter(row => row.sequence > arms[0].sequence && row.kind === 'call_scanned');
  if (scoped.some(row => row.trialHashes.length !== 1 || row.trialHashes[0] !== expected.trialPromptHash)) return fail();
  return { ...base, calls: end.calls - arms[0].calls, trialHashes: scoped.length ? [expected.trialPromptHash] : [], armNonce: expected.armNonce };
}
