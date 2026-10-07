// Explicit public Internet supplement, never fixture WEB-01 parity.
// One sessions.create per fresh workspace; no followup, restart or queue call.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import postgres from 'postgres';
import { Client } from 'eve/client';
import { createServerClient } from '@supabase/ssr';
import { readIsolationFixture, isolatedProcessEnvironment, assertIsolatedRoundTrip } from './helpers/autonomy-isolation.mjs';
import { verifyIsolatedAppArtifacts } from './helpers/start-isolated-app.mjs';
import { utcObservationTypes } from './helpers/utc-postgres-observation.mjs';
import { sha256, frozenWebReviewerPolicy } from './helpers/autonomy-web-audit.mjs';
import { PUBLIC_URL_PROTOCOL, PUBLIC_CODE_FILES, publicUrlOptions, publicBrowserSourceIdentity, publicIrisLedgerPolicy, observePublicUrl, auditPublicBytes, auditPublicCompletion } from './helpers/public-url-acceptance.mjs';

const options = publicUrlOptions(process.argv.slice(2)); // Refuse before fixture/auth access.
const root = resolve('.data/autonomy-isolation'), fixture = await readIsolationFixture();
isolatedProcessEnvironment(fixture); // Loopback auth/browser/runner before credentials.
assert.equal(fixture.app.origin, 'http://127.0.0.1:58000'); assert.equal(fixture.browser.url, 'http://127.0.0.1:58092');
const appRoot = resolve(root, `application-${fixture.runtimeScope.split(':')[1]}`); assert.equal(resolve(fixture.app.root), appRoot);
const privateJson = async path => { const actual = resolve(path), part = relative(root, actual); assert.ok(part && !part.startsWith('..') && !isAbsolute(part)); assert.equal(await realpath(actual), actual); assert.ok((await stat(actual)).size <= 1024 * 1024); return JSON.parse(await readFile(actual, 'utf8')); };
const codeHashes = Object.fromEntries(await Promise.all(PUBLIC_CODE_FILES.map(async file => [file, sha256(await readFile(file))])));
const output = resolve(root, `public-url-acceptance-${randomUUID()}.json`);
const receipt = { protocol: PUBLIC_URL_PROTOCOL, taskId: 'PUBLIC-URL', variant: 'read-only-homepage', sourceHash: fixture.app.sourceSha256,
  runtime: fixture.runtimeScope, codeHashes, mode: options.mode, model: 'glm-5.3-flash', reasoning: 'low',
  url: options.url, prompt: options.prompt, repetitions: options.repetitions, observationSeconds: options.observationSeconds,
  startedAt: new Date().toISOString(), attempts: Array.from({ length: options.repetitions }, (_, i) => ({ repetition: i + 1, result: 'not_started' })),
  timestampObservation: 'utc-oid1114-v1', siteScope: 'Actual public HTTPS origin; page is not immutable or version-pinned. This is not the simulated-origin fixture matrix.',
  observerScope: 'Chat disconnected immediately after sessions.create; subsequent workload observation is read-only PostgreSQL. Saved bytes/report are opened only after closure.',
  allowedExternalEffects: 'Public page reads only. No authentication, link-following, form submission, external writes or purchases authorized.',
  reportProseReview: 'independent_review_pending', automatedGate: false, gate: false, costUsd: null };
const secrets = new Set([fixture.internalApiSecret, fixture.databaseUrl, fixture.auth.anonKey, fixture.auth.serviceRoleKey, fixture.browser.key, fixture.runner?.key, fixture.vault?.key].filter(Boolean));
const redact = text => { for (const value of secrets) text = text.split(value).join('[REDACTED]'); return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED JWT]'); };
await writeFile(output, redact(JSON.stringify(receipt, null, 2)), { flag: 'wx', mode: 0o600 });
const persist = () => writeFile(output, redact(JSON.stringify(receipt, null, 2)));
const sql = postgres(fixture.databaseUrl, { max: 1, prepare: false, types: utcObservationTypes, connection: { TimeZone: 'UTC', default_transaction_read_only: 'on', statement_timeout: 10000 } });
async function freeze() {
  for (const [file, digest] of Object.entries(codeHashes)) assert.equal(sha256(await readFile(file)), digest, 'Locked public URL helper changed');
  const built = await verifyIsolatedAppArtifacts(fixture, { requireRuntime: true }); assert.equal(built.sourceSha256, receipt.sourceHash);
  assert.ok(!built.runtime.reportFault && !built.runtime.securityContext, 'Public supplement requires normal uninstrumented runtime');
  const policyBytes = await Promise.all(['web', 'eve'].map(service => readFile(resolve(appRoot, service, 'shared/result-assessment.ts'))));
  assert.deepEqual(policyBytes[0], policyBytes[1]); const reviewerPolicy = frozenWebReviewerPolicy(policyBytes[0]);
  const irisLedgerPolicy = publicIrisLedgerPolicy(await readFile('shared/browser-job.ts'),
    await readFile(resolve(appRoot, 'web/shared/browser-job.ts')), await readFile(resolve(appRoot, 'eve/shared/browser-job.ts')));
  const identity = { irisLedgerPolicy, sourceSha256: built.sourceSha256, dependencySha256: built.dependencySha256, services: built.services, workflowStore: built.workflowStore,
    processIdentity: built.processIdentity, modelRequestIntervalMs: built.runtime.modelRequestIntervalMs ?? 0, reviewerPolicy };
  receipt.buildIntegrity ??= identity; assert.deepEqual(identity, receipt.buildIntegrity, 'Public test runtime/source/pacing changed');
  return reviewerPolicy;
}
async function browserIdentity() {
  const linux = await privateJson(resolve(root, 'linux/fixture.json')), build = await privateJson(resolve(root, 'linux/browser-policy-build.json'));
  assert.match(linux.name, /^SynaAutonomy-[a-f0-9]{12}$/); assert.equal(resolve(linux.path), resolve(root, 'linux', linux.name));
  const read = async args => (await promisify(execFile)('wsl.exe', ['-d', linux.name, '-u', 'root', '--exec', ...args], { windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 })).stdout.trim();
  const image = await read(['docker', 'inspect', '-f', '{{.Image}}', 'qa-browser']); assert.equal(image, build.image);
  assert.deepEqual(build.files.map(file => file.file).sort(), ['Dockerfile', 'policy.mjs', 'redaction.mjs', 'server.mjs']);
  const hosts = await read(['docker', 'exec', 'qa-browser', 'cat', '/etc/hosts']); assert.ok(!/\bexample\.com\b/i.test(hosts), 'Public origin must not be a local hosts fixture');
  const runtimeFiles = ['server.mjs', 'policy.mjs', 'redaction.mjs'];
  const physicalLines = (await read(['docker', 'exec', 'qa-browser', 'sha256sum', ...runtimeFiles.map(file => `/app/${file}`)])).split('\n');
  assert.equal(physicalLines.length, runtimeFiles.length);
  const physical = new Map(physicalLines.map((line, index) => {
    const match = /^([a-f0-9]{64}) {2}(\/app\/[a-z-]+\.mjs)$/.exec(line);
    assert.ok(match); assert.equal(match[2], `/app/${runtimeFiles[index]}`); return [runtimeFiles[index], match[1]];
  }));
  const sourceVerification = [];
  for (const file of build.files) {
    assert.match(file.file, /^(?:server\.mjs|policy\.mjs|redaction\.mjs|Dockerfile)$/);
    const source = publicBrowserSourceIdentity(await readFile(resolve('infra/browser', file.file)), file.sha256);
    if (physical.has(file.file)) assert.equal(physical.get(file.file), source.normalizedSha256, 'Physical browser source differs from its image build receipt');
    sourceVerification.push({ file: file.file, ...source, containerSha256: physical.get(file.file) ?? null });
  }
  const identity = { image, files: build.files, sourceVerification, hostsSha256: sha256(hosts), publicHostOverride: false };
  receipt.browserIntegrity ??= identity; assert.deepEqual(identity, receipt.browserIntegrity, 'Physical browser image or host configuration changed');
}
async function login() {
  const account = await privateJson(resolve(root, 'ordinary-user.json')); secrets.add(account.password);
  const jar = new Map(), auth = createServerClient(fixture.auth.url, fixture.auth.anonKey, { cookieOptions: { name: 'pat_supabase_auth', path: '/', sameSite: 'lax' }, cookies: {
    getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(c => jar.set(c.name, c.value)) } });
  const logged = await auth.auth.signInWithPassword({ email: account.email, password: account.password }); assert.equal(logged.error, null);
  assert.equal(logged.data.user.id, account.userId); assert.equal(logged.data.user.role, 'authenticated');
  secrets.add(logged.data.session.access_token); secrets.add(logged.data.session.refresh_token);
  const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; '); secrets.add(cookie); return { cookie, userId: account.userId };
}
async function localApi(path, cookie, body) {
  assert.ok(/^\/api\/(?:workspaces(?:\/|$)|threads$)/.test(path));
  return fetch(fixture.app.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(30000) });
}
async function savedBytes(state, workspaceId, cookie) {
  const captures = state.captures.filter(c => c.item_id && !c.deleted_at && ['browser-action', 'test-capture'].includes(c.provenance?.producer));
  assert.ok(captures.length <= 120); const byteEvidence = new Set(), traces = [], reads = []; let total = 0;
  for (const capture of captures) {
    assert.ok(Number.isSafeInteger(capture.content.size) && capture.content.size > 0 && capture.content.size <= 4 * 1024 * 1024 && total + capture.content.size <= 32 * 1024 * 1024);
    const response = await localApi(`/api/workspaces/${workspaceId}/items/${capture.item_id}/file`, cookie); assert.equal(response.status, 200);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; assert.ok(size <= capture.content.size); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks); total += size; const trace = auditPublicBytes(capture, bytes, state); if (trace) traces.push(trace);
    byteEvidence.add(capture.item_id); reads.push({ itemId: capture.item_id, version: capture.version, bytes: size, sha256: sha256(bytes), producer: capture.provenance.producer });
  }
  return { byteEvidence, traces, reads, totalBytes: total };
}
try {
  assert.equal((await sql`show transaction_read_only`)[0].transaction_read_only, 'on');
  await freeze(); await browserIdentity(); await persist();
  if (options.mode === '--audit') {
    await observePublicUrl(sql, `audit-${randomUUID()}`, fixture.runtimeScope);
    receipt.result = 'audited'; receipt.auditScope = 'Frozen app/browser and read-only schema only; zero authentication, external target HTTP, model or QA submissions.';
  } else {
    const { cookie, userId } = await login();
    for (const attempt of receipt.attempts) {
      attempt.startedAt = new Date().toISOString(); attempt.snapshots = [];
      try {
        const reviewerPolicy = await freeze(); await browserIdentity();
        const createWorkspace = await localApi('/api/workspaces', cookie, { name: `Public URL QA ${randomUUID().slice(0, 8)}` }); assert.ok(createWorkspace.ok);
        const { workspace } = await createWorkspace.json(); attempt.workspaceId = workspace.id;
        const createThread = await localApi('/api/threads', cookie, { workspaceId: workspace.id, title: 'Kontrollera publik startsida' }); assert.ok(createThread.ok);
        const { thread } = await createThread.json(); attempt.threadId = thread.id;
        assertIsolatedRoundTrip({ workspaceId: workspace.id, threadId: thread.id, userId }, {
          workspaces: [...await sql`select id,user_id from pat_workspaces where id=${workspace.id}`], threads: [...await sql`select id,workspace_id,user_id from pat_threads where id=${thread.id}`] });
        const empty = await observePublicUrl(sql, workspace.id, fixture.runtimeScope); assert.ok(Object.values(empty).every(rows => rows.length === 0));
        attempt.databaseRoundTripAt = new Date().toISOString(); await persist();
        const client = new Client({ host: fixture.app.origin, redirect: 'error', headers: { cookie, 'x-pat-browser-thread': thread.id, 'x-pat-message-id': randomUUID(), 'x-pat-chat-model': receipt.model, 'x-pat-reasoning': receipt.reasoning } });
        attempt.submissionAttemptedAt = new Date().toISOString(); await persist();
        const submitted = await client.sessions.create({ message: options.prompt, signal: AbortSignal.timeout(30000) });
        attempt.sessionId = submitted.session.state.sessionId; attempt.acceptedAt = new Date().toISOString(); await persist();
        // Deliberately do not attach/result/subscribe/read the chat after submit.
        const deadline = Date.now() + options.observationSeconds * 1000; let previous;
        while (Date.now() < deadline) {
          const state = await observePublicUrl(sql, workspace.id, fixture.runtimeScope), serialized = JSON.stringify(state);
          if (serialized !== previous) { previous = serialized; attempt.snapshots.push({ at: new Date().toISOString(), ...state }); await persist(); }
          if (state.missions.length && state.missions.every(m => m.lifecycle === 'closed')) { attempt.closedAt = new Date().toISOString(); break; }
          await new Promise(done => setTimeout(done, 1000));
        }
        assert.ok(attempt.closedAt, 'Fixed observation window ended before autonomous closure');
        await freeze(); await browserIdentity(); const state = attempt.snapshots.at(-1), reads = await savedBytes(state, workspace.id, cookie);
        attempt.evidenceReads = reads.reads; attempt.evidenceBytes = reads.totalBytes;
        attempt.oracle = auditPublicCompletion(state, { runtime: fixture.runtimeScope, ...reads, history: attempt.snapshots, reviewerPolicy });
        const response = await localApi(`/api/workspaces/${workspace.id}/reports/${attempt.oracle.reportId}`, cookie); assert.equal(response.status, 200);
        const opened = await response.json(), report = state.reports.find(r => r.id === attempt.oracle.reportId);
        assert.deepEqual(opened.document, report.document); assert.equal(opened.itemId, report.item_id); assert.equal(opened.stale, false);
        const logPath = resolve(appRoot, 'scheduled-http.jsonl'); assert.ok((await stat(logPath)).size <= 32 * 1024 * 1024);
        const logs = (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        const paths = ['/api/internal/autonomy/drain', '/api/internal/result-reviews/drain', '/api/internal/mission-reports/drain'];
        attempt.scheduler = logs.filter(log => log.timestamp >= attempt.acceptedAt && log.timestamp <= attempt.closedAt && paths.includes(log.path));
        for (const path of paths) assert.ok(attempt.scheduler.some(log => log.path === path && log.method === 'POST' && log.status === 200), 'Missing real scheduler receipt');
        attempt.result = 'automated_subset_passed';
      } catch (error) { attempt.result = 'failed'; attempt.error = redact(error.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : `${error.name}: ${error.code ?? 'operation_failed'}`).slice(0, 500); }
      attempt.finishedAt = new Date().toISOString(); await persist();
      if (attempt.result === 'failed') break; // Never rescue, cancel or resubmit.
    }
    receipt.automatedGate = receipt.attempts.every(t => t.result === 'automated_subset_passed');
    receipt.result = receipt.automatedGate ? 'observed' : 'failed'; if (!receipt.automatedGate) process.exitCode = 1;
  }
} catch (error) { receipt.result = 'failed'; receipt.error = redact(error.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : `${error.name}: ${error.code ?? 'operation_failed'}`); process.exitCode = 1; }
finally { receipt.finishedAt = new Date().toISOString(); await persist(); await sql.end(); }
console.log(JSON.stringify({ artifact: output, result: receipt.result, automatedGate: receipt.automatedGate, gate: false }));
