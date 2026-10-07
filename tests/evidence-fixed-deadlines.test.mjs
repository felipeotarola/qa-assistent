import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Exact actual entry bodies with local clock/read/persistence ports. No entry
// import, credentials, SQL, HTTP, provider, or process lifecycle is exercised.
const root = process.env.SYNA_EVIDENCE_DEADLINE_ROOT ?? 'tests';
const evidence = await readFile(resolve(root, 'autonomy-evidence.acceptance.mjs'), 'utf8');
const security = await readFile(resolve(root, 'autonomy-evidence-security-chat.acceptance.mjs'), 'utf8');
const { requireWebDeadline, observeWebBeforeDeadline } = await import(pathToFileURL(resolve('tests/helpers/autonomy-web-restart.mjs')).href);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
function between(code, start, end) {
  const a = code.indexOf(start), b = code.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'Exact entry body is required');
  return code.slice(a, b);
}
const bodies = {
  evidence: between(evidence, 'attempt.acceptedAt = new Date().toISOString();', '\n      } catch (error) {') + '\nreturn { deadline, attempt };',
  security: between(security, 'attempt.sessionId = submitted.session.state.sessionId;', '\n      } catch (error) {') + '\nreturn { deadline, attempt };',
};
const finalBodies = {
  evidence: between(evidence, 'attempt.finishedAt = new Date().toISOString();', '\n      // Preserve all histories.') .replace(/\n {6}}\s*$/, '') + '\nreturn attempt;',
  security: between(security, 'attempt.finishedAt = new Date().toISOString();', "\n      if (attempt.result === 'failed') break;") .replace(/\n {6}}\s*$/, '') + '\nreturn attempt;',
};
const expired = error => error.code === 'WEB_OBSERVATION_EXPIRED';
function ports(kind, delayed = null, { lateAt = 11000, terminal = true } = {}) {
  let time = 0, writes = 0, reads = 0, saved = 0, checks = 0;
  const RealDate = Date;
  class Clock extends RealDate {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  }
  const delay = label => { if (delayed === label) time = lateAt; };
  const state = { missions: [{ id: 'mission', thread_id: 'thread', lifecycle: 'closed', intent: 'report_only' }],
    attempts: [], reviews: [], reports: kind === 'evidence' ? [{ id: 'report', document: { title: 'saved' } }] : [],
    jobs: [], runs: [], repositories: [], setups: [], claims: [] };
  const prefix = { events: terminal ? [{ type: 'turn.completed', meta: { at: new RealDate(1).toISOString() } }, { type: 'session.waiting' }] : [] };
  const deps = {
    Date: Clock, assert, deadline: null, terminalAt: null, Buffer, AbortSignal,
    attempt: { startedAt: new RealDate(0).toISOString(), snapshots: [] },
    trial: { workspaceId: 'workspace', variant: 'other-owner' }, thread: { id: 'thread' }, cookie: 'unused',
    manifest: { observationSeconds: 10, taskId: 'REP-05' }, m: { observationSeconds: 10, runtime: 'runtime' },
    source: { requesterId: 'owner' }, submitted: { session: { state: { sessionId: 'session' } } },
    fixture: { runtimeScope: 'runtime' }, before: {}, preservedIris: false, faultAdapter: null,
    markers: [], secrets: new Set(), origin: 'unused', appRoot: 'unused', resolve,
    process: { exitCode: 0 },
    requireWebDeadline: d => requireWebDeadline(d, time),
    observeWebBeforeDeadline: (d, observe) => observeWebBeforeDeadline(d, observe, () => time),
    persist: async () => { saved++; delay(saved === 1 ? 'accepted-persist' : 'observed-persist'); },
    fingerprint: () => 'new-state', sha256: () => 'metadata-hash',
    observeEvidence: async () => { reads++; delay(kind === 'evidence' ? 'observe' : 'state-read'); return state; },
    sql: async () => { reads++; delay('thread-read'); return [{ user_id: 'owner', workspace_id: 'workspace', session_id: 'session' }]; },
    freeze: async () => { checks++; delay('freeze'); return {}; },
    evidenceMetrics: () => ({}), auditEvidenceHistory: () => {}, auditEvidenceCompletion: () => ({ reportId: 'report' }),
    request: async () => { reads++; delay('report-read'); return { status: 200, json: async () => { delay('report-body'); return { stale: false, document: state.reports[0].document }; } }; },
    readFile: async () => { reads++; delay('log-read'); return ['/api/internal/autonomy/drain', '/api/internal/mission-reports/drain'].map(path => JSON.stringify({ path, method: 'POST', status: 200, timestamp: new RealDate(0).toISOString() })).join('\n'); },
    client: { sessions: { attach: () => ({ snapshot: async () => { reads++; delay('observe'); return prefix; } }) } },
    auditSecurityChatSnapshot: () => ({ eligible: true, failures: [], streamHash: 'digest' }),
    securityLeakPresent: () => false,
    setTimeout: done => { time += 1000; done(); },
  };
  return { deps, counters: () => ({ writes, reads, saved, checks }),
    run: body => {
      const entries = Object.entries(deps).filter(([key]) => key !== 'deadline' || !body.includes('const deadline ='));
      return new AsyncFunction(...entries.map(([key]) => key), body)(...entries.map(([, value]) => value));
    },
    time: value => { time = value; } };
}
for (const kind of ['evidence', 'security']) {
  test(`${kind}: original acceptedAt survives slow first persist`, async () => {
    const f = ports(kind, 'accepted-persist');
    await assert.rejects(f.run(bodies[kind]), expired);
    assert.equal(f.counters().reads, 0);
  });
  test(`${kind}: late closed/terminal observation is rejected`, async () => {
    const f = ports(kind, 'observe');
    await assert.rejects(f.run(bodies[kind]), expired);
    assert.equal(f.deps.attempt.closedAt, undefined);
    assert.notEqual(f.deps.attempt.result, kind === 'evidence' ? 'passed' : 'observed');
  });
  test(`${kind}: exact deadline is already expired`, async () => {
    const f = ports(kind, 'observe', { lateAt: 10000 });
    await assert.rejects(f.run(bodies[kind]), expired);
  });
  test(`${kind}: observed state persistence cannot extend deadline`, async () => {
    const f = ports(kind, 'observed-persist');
    await assert.rejects(f.run(bodies[kind]), expired);
    assert.notEqual(f.deps.attempt.result, kind === 'evidence' ? 'passed' : 'observed');
  });
  test(`${kind}: runtime revalidation returning late cannot pass`, async () => {
    const f = ports(kind, 'freeze'); await assert.rejects(f.run(bodies[kind]), expired);
  });
  test(`${kind}: timely original result and deadline remain unchanged`, async () => {
    const f = ports(kind), result = await f.run(bodies[kind]);
    assert.equal(result.deadline, Date.parse(result.attempt.acceptedAt) + 10000);
    assert.equal(result.attempt.result, kind === 'evidence' ? 'passed' : 'observed');
    assert.equal(f.counters().writes, 0);
  });
  test(`${kind}: late final persist records failure and retains original acceptance`, async () => {
    const f = ports(kind, 'accepted-persist'); f.deps.deadline = 10000;
    Object.assign(f.deps.attempt, { acceptedAt: new Date(0).toISOString(), result: kind === 'evidence' ? 'passed' : 'observed' });
    await f.run(finalBodies[kind]);
    assert.equal(f.deps.attempt.result, 'failed');
    assert.equal(f.deps.attempt.acceptedAt, new Date(0).toISOString());
    assert.equal(f.counters().saved, 2, 'Failed state is durably persisted after late success write');
  });
  test(`${kind}: failure cleanup persists even after expired deadline`, async () => {
    const f = ports(kind); f.time(20000); f.deps.deadline = 10000;
    f.deps.attempt.result = 'failed'; f.deps.attempt.error = 'original failure';
    await f.run(finalBodies[kind]); assert.equal(f.counters().saved, 1); assert.equal(f.deps.attempt.error, 'original failure');
  });
}
for (const label of ['report-read', 'report-body', 'log-read']) test(`evidence: late ${label} cannot publish success`, async () => {
  const f = ports('evidence', label); await assert.rejects(f.run(bodies.evidence), expired);
});
for (const label of ['thread-read', 'state-read']) test(`security: late ${label} cannot publish success`, async () => {
  const f = ports('security', label); await assert.rejects(f.run(bodies.security), expired);
});
test('security: original observation limit stays fixed when terminal never arrives', async () => {
  const f = ports('security', null, { terminal: false }); await assert.rejects(f.run(bodies.security), expired);
  assert.equal(f.counters().reads, 10); assert.equal(f.deps.attempt.result, undefined);
});
test('both normal oracles, fault proofs, cleanup and fail-fast branches remain present', () => {
  assert.match(evidence, /faultAdapter\.audit\(trial, before, after, thread\.id, sql\)/);
  assert.match(evidence, /attempt\.fault = await faultAdapter\.receipt\(trial\)/);
  assert.match(evidence, /auditEvidenceCompletion\(manifest, trial, before, after, thread\.id\)/);
  assert.match(security, /finishSecurityContextTrial\(current, contextWindow\.arms/);
  assert.match(security, /securityWorkspaceFingerprint\(sql, original\.workspaceId\)/);
  for (const entry of [evidence, security]) {
    assert.match(entry, /if \(attempt\.result === 'failed'/);
    assert.match(entry, /await new Promise\(done => setTimeout\(done, 1000\)\)/);
  }
});
