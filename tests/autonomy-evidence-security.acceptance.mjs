// Read-contract SEC08 slice. Never submits a model request or drives a queue.
// Natural adversarial chat/model-context non-leakage remains a separate gate.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import postgres from 'postgres';
import { createServerClient } from '@supabase/ssr';
import { readIsolationFixture, isolatedProcessEnvironment } from './helpers/autonomy-isolation.mjs';
import { verifyIsolatedAppArtifacts } from './helpers/start-isolated-app.mjs';
import { observeEvidence } from './helpers/evidence-observer.mjs';
import { utcObservationTypes } from './helpers/utc-postgres-observation.mjs';
import { sha256, fingerprint } from './helpers/evidence-acceptance.mjs';
import { SECURITY_PROTOCOL, validateEvidenceSecurityManifest, validateSecurityOriginal, probeSecurityReports, securityContractGate, securityNaturalPrompt } from './helpers/evidence-security.mjs';

const modes = ['--validate', '--audit', '--execute'].filter(flag => process.argv.includes(flag)); assert.equal(modes.length, 1);
const mode = modes[0], root = resolve('.data/autonomy-isolation');
async function privateBytes(path) {
  const candidate = resolve(path), actual = await realpath(candidate), sub = relative(root, actual);
  assert.ok(sub && sub !== '..' && !sub.startsWith(`..${sep}`) && !isAbsolute(sub) && actual === candidate);
  const info = await stat(actual); assert.ok(info.isFile() && info.size <= 32 * 1024 * 1024); return readFile(actual);
}
const manifestBytes = await privateBytes(process.argv.find(a => a.startsWith('--manifest='))?.slice(11)), m = validateEvidenceSecurityManifest(JSON.parse(manifestBytes));
const output = resolve(root, `evidence-security-${randomUUID()}.json`);
const receipt = { protocol: SECURITY_PROTOCOL, catalogVersion: '2026-10-05', taskId: 'SEC-08', variant: m.variant, sourceHash: m.sourceHash, runtime: m.runtime,
  mode, repetitions: m.trials.length, manifestSha256: sha256(manifestBytes), harnessSha256: sha256(await readFile('tests/autonomy-evidence-security.acceptance.mjs')),
  oracleSha256: sha256(await readFile('tests/helpers/evidence-security.mjs')), startedAt: new Date().toISOString(), inputPreparation: m.preparation,
  modelCalls: 0, databaseWrites: 0, attempts: m.trials.map((t, i) => ({ repetition: i + 1, result: 'not_started',
    requesterId: t.requesterId, workspaceId: t.allowed.workspaceId, naturalPromptNotSubmitted: securityNaturalPrompt('http://127.0.0.1:58000', t) })),
  gate: false, naturalAdversarialChat: 'not_executed', modelContextNonLeakage: 'not_verified' };
if (mode === '--validate') console.log(JSON.stringify({ result: 'validated', protocol: SECURITY_PROTOCOL, modelCalls: 0, networkRequests: 0 }));
else {
  const f = await readIsolationFixture(); isolatedProcessEnvironment(f); assert.equal(f.runtimeScope, m.runtime); assert.equal(f.app.sourceSha256, m.sourceHash);
  assert.equal(f.app.origin, 'http://127.0.0.1:58000');
  const sql = postgres(f.databaseUrl, { max: 1, prepare: false, types: utcObservationTypes, connection: { default_transaction_read_only: 'on', TimeZone: 'UTC' } });
  const cookies = new Map();
  const persist = () => writeFile(output, JSON.stringify(receipt, null, 2));
  async function login(path, owner) {
    const account = JSON.parse(await privateBytes(path)); assert.equal(account.userId, owner);
    const jar = new Map(), auth = createServerClient(f.auth.url, f.auth.anonKey, { cookieOptions: { name: 'pat_supabase_auth', path: '/', sameSite: 'lax' },
      cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(c => jar.set(c.name, c.value)) } });
    const result = await auth.auth.signInWithPassword({ email: account.email, password: account.password });
    assert.equal(result.error, null, 'Ordinary SEC account sign-in failed'); assert.equal(result.data.user.id, owner); assert.equal(result.data.user.role, 'authenticated');
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; '); cookies.set(owner, cookie); return cookie;
  }
  async function read(path, cookie) {
    assert.match(path, /^\/api\/workspaces\/[a-zA-Z0-9_-]+\/reports\/[a-zA-Z0-9_-]+$/);
    const response = await fetch(f.app.origin + path, { headers: cookie ? { cookie } : {}, redirect: 'error', signal: AbortSignal.timeout(15000) });
    const chunks = [], reader = response.body.getReader(); let size = 0;
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; assert.ok(size <= 4 * 1024 * 1024); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    return { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
  }
  try {
    assert.equal((await sql`show transaction_read_only`)[0].transaction_read_only, 'on');
    if (mode === '--execute') { const build = await verifyIsolatedAppArtifacts(f, { requireRuntime: true }); assert.equal(build.sourceSha256, m.sourceHash); receipt.buildIntegrity = { sourceSha256: build.sourceSha256, dependencySha256: build.dependencySha256, workflowStore: build.workflowStore }; }
    await persist();
    for (const [index, trial] of m.trials.entries()) {
      const attempt = receipt.attempts[index]; attempt.startedAt = new Date().toISOString();
      try {
        attempt.stage = 'immutable_originals';
        for (const source of trial.originArtifacts) assert.equal(sha256(await privateBytes(source.path)), source.sha256, 'Original security preparation artifact changed');
        const before = [];
        for (const [kind, ref] of Object.entries({ allowed: trial.allowed, private: trial.private, foreignRuntime: trial.foreignRuntime })) {
          const [row] = await sql`select r.id as report_id,m.workspace_id,w.user_id,m.runtime,r.status,r.document,r.item_id,coalesce(m.lifecycle,m.status) as lifecycle from pat_mission_reports r join pat_missions m on m.id=r.mission_id join pat_workspaces w on w.id=m.workspace_id where r.id=${ref.reportId} and m.workspace_id=${ref.workspaceId}`;
          validateSecurityOriginal(row, ref, kind === 'private' ? trial.ownerId : trial.requesterId);
          const observed = await observeEvidence(sql, ref.workspaceId, ref.runtime); assert.equal(observed.claims.length, 0); assert.ok(observed.missions.every(m => m.lifecycle === 'closed' || m.lifecycle == null));
          before.push({ reference: ref, fingerprint: fingerprint(observed) });
        }
        attempt.originals = before.map(({ reference, fingerprint }) => ({ workspaceId: reference.workspaceId, reportId: reference.reportId, runtime: reference.runtime, documentHash: reference.documentHash, stateHash: fingerprint }));
        if (mode === '--audit') { attempt.result = 'audited'; continue; }
        attempt.stage = 'ordinary_auth';
        const requesterCookie = cookies.get(trial.requesterId) ?? await login(trial.requesterAccountFile, trial.requesterId);
        const ownerCookie = cookies.get(trial.ownerId) ?? await login(trial.ownerAccountFile, trial.ownerId);
        attempt.stage = 'private_read_probes'; attempt.probes = await probeSecurityReports({ trial, requesterCookie, ownerCookie, read });
        for (const original of before) assert.equal(fingerprint(await observeEvidence(sql, original.reference.workspaceId, original.reference.runtime)), original.fingerprint, 'A private read mutated an original workspace');
        attempt.result = 'passed'; attempt.proofLevel = 'actual ordinary-authenticated HTTP and read-only PostgreSQL owner/runtime contract';
      } catch (error) {
        attempt.result = 'failed'; attempt.error = error.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : `${error.name}: ${error.code ?? 'operation_failed'}`;
        process.exitCode = 1; break;
      } finally { attempt.finishedAt = new Date().toISOString(); attempt.elapsedMs = +new Date(attempt.finishedAt) - +new Date(attempt.startedAt); await persist(); }
    }
    Object.assign(receipt, securityContractGate(receipt.attempts)); receipt.result = receipt.attempts.some(t => t.result === 'failed') ? 'failed' : mode === '--audit' ? 'audited' : 'contract_completed';
  } finally { receipt.finishedAt = new Date().toISOString(); await persist(); await sql.end(); }
  console.log(JSON.stringify({ result: receipt.result, artifact: output, contractVerified: receipt.contractVerified, gate: false, modelCalls: 0 }));
}
