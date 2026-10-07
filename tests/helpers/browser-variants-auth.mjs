import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ws as WebSocket } from 'playwright-core/lib/utilsBundle';
import { fakeAccount } from '../fixtures/browser-variants-extra-site.mjs';
import { isolatedProcessEnvironment } from './autonomy-isolation.mjs';
import { hash } from './browser-variants-protocol.mjs';

export function viewerLoginAddress(liveUrl, sessionId, origin) {
  assert.equal(origin, 'http://127.0.0.1:58092');
  const url = new URL(liveUrl); assert.equal(url.origin, origin); assert.equal(url.pathname, '/viewer'); assert.equal(url.search, '');
  assert.equal(url.username + url.password, ''); assert.match(sessionId, /^[a-f0-9-]{36}$/i);
  const [id, token, extra] = url.hash.slice(1).split(':'); assert.equal(id, sessionId); assert.equal(extra, undefined); assert.match(token, /^[a-f0-9]{64}$/);
  return `${origin.replace('http:', 'ws:')}/view/${id}?token=${token}`;
}

/** Fixture-specific human keyboard sequence through the same viewer transport
 * as the owner UI. No CDP/DOM access, automatic cookie insertion or model call.
 * Returned receipts deliberately exclude typed text, token and frame pixels. */
export async function submitFixtureLogin({ liveUrl, sessionId, origin }) {
  const address = viewerLoginAddress(liveUrl, sessionId, origin), startedAt = new Date().toISOString();
  const socket = new WebSocket(address, { origin, handshakeTimeout: 5000 });
  try {
    const frame = await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('No current human viewer frame')), 8000);
      const done = (error, value) => { clearTimeout(timer); error ? reject(error) : accept(value); };
      socket.once('error', () => done(new Error('Owned viewer connection failed')));
      socket.once('open', () => socket.send(JSON.stringify({ type: 'visibility', visible: true })));
      socket.on('message', data => {
        const value = JSON.parse(data.toString());
        if (value.type === 'frame') done(null, value);
      });
    });
    assert.equal(frame.control, 'human'); assert.ok(Number.isSafeInteger(frame.controlEpoch) && frame.controlEpoch > 0); assert.equal(typeof frame.image, 'string');
    socket.send(JSON.stringify({ type: 'visibility', visible: false }));
    // The immutable fixture has two fields in document tab order. Clicking
    // outside its centered form clears prior focus without inspecting the DOM.
    const actions = [{ type: 'click', x: 8, y: 8 }, { type: 'key', key: 'Tab' }, { type: 'text', text: fakeAccount.email },
      { type: 'key', key: 'Tab' }, { type: 'text', text: fakeAccount.password }, { type: 'key', key: 'Tab' }, { type: 'key', key: 'Enter' }];
    for (const action of actions) socket.send(JSON.stringify({ ...action, controlEpoch: frame.controlEpoch }));
    // A flush receipt is not a login verdict. The caller must independently read
    // actual fixture POST/redirect/cookie/GET receipts before returning control.
    await new Promise((accept, reject) => socket.send(JSON.stringify({ type: 'visibility', visible: false }), error => error ? reject(new Error('Viewer input flush failed')) : accept()));
    return { startedAt, submittedAt: new Date().toISOString(), controlEpoch: frame.controlEpoch, frameSha256: hash(frame.image), inputTypes: actions.map(row => row.type), transport: 'owner-viewer-keyboard', credentialsGivenToModel: false };
  } finally { socket.close(); }
}

/** Read-only private fixture ledger. The token is sent over stdin, never argv.
 * No app/API/cookie access and no unrestricted host or shell interpolation. */
export async function readFixtureAuthAudit(fixture) {
  isolatedProcessEnvironment(fixture);
  const base = resolve('.data/autonomy-isolation/linux'), linux = JSON.parse(await readFile(resolve(base, 'fixture.json'), 'utf8'));
  assert.match(linux.name, /^SynaAutonomy-[a-f0-9]{12}$/); assert.equal(resolve(linux.path), resolve(base, linux.name));
  const privateConfig = JSON.parse(await readFile(resolve(base, 'browser-variants-extra-auth.json'), 'utf8'));
  assert.equal(privateConfig.runtimeScope, fixture.runtimeScope); assert.match(privateConfig.adminToken, /^[a-f0-9]{64}$/);
  const code = "import http from 'node:http';let raw='';for await(const b of process.stdin)raw+=b;const {token}=JSON.parse(raw);const data=await new Promise((yes,no)=>{const q=http.get('http://192.0.2.12/__fixture/audit',{headers:{host:'qa-auth.test','x-fixture-administrator':token},signal:AbortSignal.timeout(5000)},r=>{let data='';r.on('data',b=>{data+=b;if(data.length>1000000)q.destroy(Error('size'));});r.on('end',()=>r.statusCode===200?yes(JSON.parse(data)):no(Error('status')));});q.on('error',no);});console.log(JSON.stringify(data));";
  return new Promise((accept, reject) => {
    const child = spawn('wsl.exe', ['-d', linux.name, '-u', 'root', '--exec', '/opt/syna-autonomy/node/bin/node', '--input-type=module', '-e', code], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
    let output = ''; child.stdout.on('data', b => { output += b; if (output.length > 1_000_000) child.kill(); }); child.stderr.resume();
    child.on('error', () => reject(new Error('Private fixture audit process failed')));
    child.on('close', code => { if (code) reject(new Error('Private fixture audit failed')); else { try { accept(JSON.parse(output)); } catch { reject(new Error('Invalid private fixture audit receipt')); } } });
    child.stdin.end(JSON.stringify({ token: privateConfig.adminToken }));
  });
}

export function validateHumanLogin(events, input, expectedRevision) {
  assert.equal(events.revision, expectedRevision);
  const rows = events.events.filter(row => Date.parse(row.at) >= Date.parse(input.startedAt));
  const logins = rows.filter(row => row.kind === 'login'); assert.equal(logins.length, 1, 'Expected one actual human login, without credential guessing');
  const login = logins[0]; assert.equal(login.accepted, true); assert.equal(login.method, 'POST'); assert.equal(login.status, 303); assert.equal(login.location, '/account'); assert.match(login.sessionHash, /^[a-f0-9]{64}$/);
  const read = rows.find(row => row.kind === 'account_read' && row.sequence > login.sequence && row.authenticated && row.cookiePresent && row.method === 'GET' && row.status === 200 && row.sessionHash === login.sessionHash);
  assert.ok(read, 'No authenticated GET using the cookie issued by the real POST');
  return { login, authenticatedRead: read };
}

export function auditAuthenticatedContinuation(state, fault, matches, events, expectedRevision, traces) {
  assert.ok(fault.loginInput && fault.answeredAt); const proof = validateHumanLogin(events, fault.loginInput, expectedRevision);
  const match = matches.find(row => row.oracleId === 'authenticated_profile'); assert.ok(match, 'Agent did not verify profile after return');
  const run = state.runs.find(row => row.id === match.runId); assert.ok(run?.browser_entry_receipt);
  assert.equal(run.browser_entry_receipt.sessionId, fault.sessionId, 'Login was verified in another physical browser');
  const wait = state.waits.find(row => row.id === fault.waitId && row.state === 'answered'); assert.ok(wait?.answered_at);
  assert.ok(Date.parse(run.finished_at) >= Date.parse(wait.answered_at), 'Profile result preceded owner return');
  const trace = traces.find(row => row.capture.item_id === match.traceItemId && row.capture.run_id === run.id)?.trace;
  assert.ok(trace && Date.parse(trace.startedAt) >= Date.parse(wait.answered_at), 'Profile observation preceded the actual saved owner return');
  return { ...proof, continuedRunId: run.id, physicalSessionPreserved: true };
}

export async function readHumanPolicyVerification(deployment) {
  const metadata = JSON.parse(await readFile('.data/autonomy-isolation/linux/browser-human-auth-verification.json', 'utf8'));
  assert.match(metadata.artifact, /^\.data\/autonomy-isolation\/browser-human-auth-[a-f0-9-]{36}\.json$/);
  const bytes = await readFile(metadata.artifact), proof = JSON.parse(bytes); assert.equal(hash(bytes), metadata.sha256);
  assert.equal(proof.protocol, 'browser-human-auth-v1'); assert.equal(proof.status, 'passed'); assert.equal(proof.model, false);
  assert.equal(proof.browserImage, deployment.browserImage); assert.equal(metadata.browserImage, proof.browserImage);
  assert.equal(proof.fixtureSha256, deployment.serverSha256); assert.equal(metadata.fixtureSha256, proof.fixtureSha256);
  assert.equal(proof.viewerInput.transport, 'owner-viewer-keyboard'); assert.equal(proof.viewerInput.credentialsGivenToModel, false);
  validateHumanLogin({ events: proof.events, revision: proof.fixtureSha256 }, proof.viewerInput, proof.fixtureSha256);
  return { artifact: metadata.artifact, sha256: metadata.sha256, verifiedAt: proof.verifiedAt, browserImage: proof.browserImage };
}
