import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Execute exact entry bodies with local fake ports. Never import its top-level
// SQL/authentication/HTTP/worker lifecycle or submit a real user message.
const entry = await readFile(resolve(process.env.SYNA_REPO_FAULT_DEADLINE_ENTRY ?? 'tests/autonomy-repository-faults.acceptance.mjs'), 'utf8');
const { requireWebDeadline, observeWebBeforeDeadline } = await import(pathToFileURL(resolve('tests/helpers/autonomy-web-restart.mjs')).href);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
function between(start, end) {
  const a = entry.indexOf(start), b = entry.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'Exact repository-fault entry body required');
  return entry.slice(a, b);
}
const completion = between('const accepted = await client.sessions.create(', '\n      } catch (error) { trial.result');
const finalPersistence = between('trial.finishedAt = new Date().toISOString(); await persist();', '\n      console.log(JSON.stringify(');
const expired = error => error.code === 'WEB_OBSERVATION_EXPIRED';
function ports({ delayed, variant = 'runner_ack_lost', lateAt = 11000, terminal = true, noFaultUntilFinal = false } = {}) {
  let time = 1000, observed = 0, faultReads = 0, posts = 0, continuations = 0, saves = 0, checked = 0;
  let persistedIntent = false, persistedRevoke = false, persistedFault = false, persistedSnapshot = false;
  const saved = [], RealDate = Date;
  class Clock extends RealDate {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  }
  const delay = label => { if (delayed === label) time = lateAt; };
  const trial = { snapshots: [], measuredFrom: new RealDate(0).toISOString() };
  const state = { missions: [{ id: 'original-mission', lifecycle: terminal ? 'closed' : 'running' }], claims: [], repositories: [], setups: [], runs: [] };
  const pending = { id: 'fault', consentId: 'consent', revision: 2 };
  const report = { id: 'original-report', document: { title: 'Actual saved report' }, item_id: 'original-material' };
  const deps = {
    assert, Date: Clock, deadline: null, trial, prompt: 'unchanged natural prompt', protocol: { observationSeconds: 10, protocol: 'unchanged-fault-protocol' },
    manifest: { faultGateway: {} }, faultArm: variant === 'missing_key_no_answer' ? null : { id: 'fault' }, variant,
    savedConsent: { consentId: 'consent', revision: 2 }, workspace: { id: 'workspace' }, fixture: { runtimeScope: 'runtime' }, sql: {},
    worker: { executionImage: 'unchanged-image' }, selectedRepo: {}, oracle: {}, scenario: 'REPO-12', root: '.', resolve,
    requireWebDeadline: d => requireWebDeadline(d, time),
    observeWebBeforeDeadline: (d, observe) => observeWebBeforeDeadline(d, observe, () => time),
    client: { sessions: { create: async () => ({ session: { state: { sessionId: 'original-session' } } }) } },
    persist: async () => {
      saves++;
      if (saves === 1) delay('accepted-persist');
      else if (trial.revocationRequest && !persistedIntent) { persistedIntent = true; delay('revoke-intent-persist'); }
      else if (trial.revocation && !persistedRevoke) { persistedRevoke = true; delay('revoke-receipt-persist'); }
      else if (trial.faultReceipt && !persistedFault) { persistedFault = true; delay('fault-receipt-persist'); }
      else if (trial.snapshots.length && !persistedSnapshot) { persistedSnapshot = true; delay('snapshot-persist'); }
      saved.push(JSON.parse(JSON.stringify(trial)));
    },
    readRepoFault: async () => {
      faultReads++; delay(faultReads > 1 ? 'last-fault-read' : 'fault-read');
      return noFaultUntilFinal && faultReads === 1 ? {} : { ...(variant === 'consent_revoked_before_release' ? { pending } : {}), receipt: { id: 'fault', applied: true } };
    },
    post: async (_path, body) => { posts++; assert.deepEqual(body, { expectedRevision: 2 }); delay('revoke'); return { id: 'consent', revision: 3, revokedAt: new RealDate(time).toISOString() }; },
    continueRepoFault: async (_gateway, revocation) => { continuations++; assert.equal(revocation.id, 'fault'); delay('continue'); },
    observeRepoMission: async () => { observed++; delay('observe'); return state; },
    assertNoSyntheticLeak: () => {},
    freeze: async () => { delay('freeze'); }, observeRepoResources: async () => { delay('resources'); return []; },
    evidence: async () => { delay('evidence'); return { receipts: [], bytes: 0 }; },
    auditRepoFaultCompletion: () => { checked++; delay('oracle'); return { report, matched: [], limitations: [], reportScope: {}, semanticProse: { pending: true } }; },
    get: async () => { delay('report-read'); return { status: 200, json: async () => { delay('report-body'); return { document: report.document, stale: false, itemId: report.item_id }; } }; },
    denial: async () => { delay('denial'); return [401, 404]; },
    readFile: async () => { delay('log-read'); return ['/api/internal/autonomy/drain', '/api/internal/mission-reports/drain'].map(path => JSON.stringify({ path, timestamp: new RealDate(1000).toISOString(), method: 'POST', status: 200 })).join('\n'); },
    setTimeout: done => { time += 1000; done(); },
  };
  return { deps, saved, counters: () => ({ observed, faultReads, posts, continuations, saves, checked }),
    time: value => { time = value; },
    run: body => { const entries = Object.entries(deps).filter(([key]) => key !== 'deadline' || !body.includes('const deadline ='));
      return new AsyncFunction(...entries.map(([key]) => key), body)(...entries.map(([, value]) => value)); },
    complete: () => {
      const entries = Object.entries(deps).filter(([key]) => key !== 'deadline' || !completion.includes('const deadline ='));
      return new AsyncFunction(...entries.map(([key]) => key), completion + '\nreturn { deadline, trial };')(...entries.map(([, value]) => value));
    } };
}

for (const variant of ['runner_ack_lost', 'app_stops_after_ready', 'missing_key_no_answer', 'consent_revoked_before_release']) {
  test(`timely ${variant} preserves the original deadline, oracle and fault sequence`, async () => {
    const f = ports({ variant }), result = await f.complete();
    assert.equal(result.deadline, Date.parse(result.trial.acceptedAt) + 10000);
    assert.equal(result.trial.result, 'passed'); assert.equal(f.counters().checked, 1);
    assert.equal(result.trial.sessionId, 'original-session');
    assert.equal(f.counters().posts, variant === 'consent_revoked_before_release' ? 1 : 0);
    assert.equal(f.counters().continuations, variant === 'consent_revoked_before_release' ? 1 : 0);
  });
}

for (const delayed of ['accepted-persist', 'fault-read', 'fault-receipt-persist', 'observe', 'snapshot-persist']) {
  test(`late ${delayed} cannot certify closure or extend the acceptedAt window`, async () => {
    const f = ports({ delayed }); await assert.rejects(f.complete(), expired);
    assert.equal(f.deps.trial.closedAt, undefined); assert.notEqual(f.deps.trial.result, 'passed');
    if (delayed === 'accepted-persist') { assert.equal(f.counters().observed, 0); assert.equal(f.counters().faultReads, 0); }
  });
}

for (const delayed of ['fault-read', 'revoke-intent-persist', 'revoke', 'revoke-receipt-persist', 'continue']) {
  test(`revocation ${delayed} expiry prevents subsequent fault release or observations`, async () => {
    const f = ports({ delayed, variant: 'consent_revoked_before_release' });
    await assert.rejects(f.complete(), expired); assert.equal(f.counters().observed, 0);
    if (['fault-read', 'revoke-intent-persist'].includes(delayed)) assert.equal(f.counters().posts, 0);
    assert.equal(f.counters().continuations, delayed === 'continue' ? 1 : 0);
    assert.notEqual(f.deps.trial.result, 'passed');
  });
}

for (const delayed of ['last-fault-read', 'freeze', 'resources', 'evidence', 'oracle', 'report-read', 'report-body', 'denial', 'log-read']) {
  test(`closed mission cannot pass after late ${delayed}`, async () => {
    const f = ports({ delayed, noFaultUntilFinal: delayed === 'last-fault-read' });
    await assert.rejects(f.complete(), expired); assert.ok(f.deps.trial.closedAt); assert.notEqual(f.deps.trial.result, 'passed');
  });
}

test('unclosed mission keeps the existing finite polling window', async () => {
  const f = ports({ terminal: false }); await assert.rejects(f.complete());
  assert.equal(f.counters().observed, 10); assert.equal(f.deps.trial.closedAt, undefined); assert.notEqual(f.deps.trial.result, 'passed');
});

test('timely last millisecond is allowed while exact boundary is expired', async () => {
  const timely = ports({ delayed: 'log-read', lateAt: 10999 }); assert.equal((await timely.complete()).trial.result, 'passed');
  const late = ports({ delayed: 'log-read', lateAt: 11000 }); await assert.rejects(late.complete(), expired);
});

test('late final success persistence is durably corrected to failure without resubmission', async () => {
  const f = ports({ delayed: 'accepted-persist' }); f.deps.deadline = 11000;
  Object.assign(f.deps.trial, { acceptedAt: new Date(1000).toISOString(), result: 'passed' });
  await f.run(finalPersistence);
  assert.equal(f.deps.trial.result, 'failed'); assert.equal(f.saved.length, 2); assert.equal(f.saved.at(-1).result, 'failed');
  assert.equal(f.deps.trial.acceptedAt, new Date(1000).toISOString()); assert.equal(f.counters().posts, 0); assert.equal(f.counters().observed, 0);
});

test('existing failure persistence remains allowed after expiry and before acceptance', async () => {
  for (const deadline of [11000, null]) {
    const f = ports(); f.time(20000); f.deps.deadline = deadline;
    Object.assign(f.deps.trial, { result: 'failed', error: 'original fault failure' });
    await f.run(finalPersistence); assert.equal(f.saved.length, 1); assert.equal(f.deps.trial.error, 'original fault failure');
  }
});

test('original caps, exact fault oracle, fail-fast and cleanup remain intact', () => {
  assert.match(entry, /observationSeconds: \['missing_key_no_answer', 'consent_revoked_before_release'\]\.includes\(variant\) \? 4500 : 1800/);
  assert.match(entry, /auditRepoFaultCompletion\(state, \{ protocol: protocol\.protocol/);
  assert.match(entry, /assert\.equal\(reopened\.stale, false\)/);
  assert.match(entry, /'An owned executor\/preview container still exists after claimed cleanup'/);
  assert.match(entry, /trial\.result === 'failed' && !continueOnFailure/);
  assert.match(entry, /finally \{ await sql\.end\(\); \}/);
});
