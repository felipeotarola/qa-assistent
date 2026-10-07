import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertWebRestartBinding, assertWebRestartConfiguration, observeWebBeforeDeadline, requireWebDeadline, restartWebAtBoundary } from './helpers/autonomy-web-restart.mjs';

const runtime = () => ({ sourceSha256: 'source', mode: 'application', workflowStore: { id: 'store' }, modelRequestIntervalMs: 6000,
  web: { pid: 101, cwd: 'owned-web', identity: { main: { pid: 101, createdAt: 'original' } } }, eve: { pid: 202, identity: { main: { pid: 202 } } } });
function fixture(changes = {}) {
  let time = 10;
  const calls = [], before = runtime(), record = {};
  const ports = {
    verify: async () => { calls.push('verify'); return before; },
    persist: async () => { calls.push('persist'); },
    stop: async () => { calls.push('stop'); return { stoppedPids: [101] }; },
    observeStopped: async () => { calls.push('observe'); return { report: 'same-claimed-job' }; },
    restore: async () => { calls.push('restore'); return { status: 'restarted', runtime: { ...before, web: { ...before.web, pid: 303 } } }; },
    audit: async state => { calls.push('audit'); assert.equal(state.before.report, state.stoppedState.report); },
    ...changes,
  };
  return { record, calls, before, ports, setTime: value => { time = value; },
    run: () => restartWebAtBoundary({ deadlineAt: 100, observed: { report: 'same-claimed-job' }, record, ports, now: () => time }) };
}

test('same claimed boundary is audited only after the original web has been restored', async () => {
  const f = fixture(); await f.run();
  assert.ok(f.calls.indexOf('restore') < f.calls.indexOf('audit'));
  assert.equal(f.record.afterRuntime.eve.pid, 202);
  assert.equal(f.record.restoration.status, 'restarted');
});

test('preparation failure never stops a process', async () => {
  const error = new Error('missing prepared credential');
  const f = fixture({ verify: async () => { throw error; } });
  await assert.rejects(f.run, value => value === error);
  assert.equal(f.calls.includes('stop'), false);
  assert.equal(f.calls.includes('restore'), false);
});

test('stopped observation failure still restores and preserves the first failure', async () => {
  const error = new Error('observation unavailable');
  const f = fixture({ observeStopped: async () => { throw error; } });
  await assert.rejects(f.run, value => value === error);
  assert.equal(f.calls.filter(c => c === 'restore').length, 1);
  assert.equal(f.calls.includes('audit'), false);
});

test('failed stopped receipt persistence cannot skip restoration', async () => {
  let saves = 0;
  const error = new Error('receipt disk unavailable');
  const f = fixture({ persist: async () => { if (++saves === 2) throw error; } });
  await assert.rejects(f.run, value => value === error);
  assert.equal(f.calls.filter(c => c === 'restore').length, 1);
});

test('ambiguous stop error still invokes exact-identity restoration once', async () => {
  const error = new Error('stop response lost');
  const f = fixture({ stop: async () => { throw error; } });
  await assert.rejects(f.run, value => value === error);
  assert.equal(f.calls.filter(c => c === 'restore').length, 1);
});

test('original still running is a failed injection, never a restart pass', async () => {
  const f = fixture({ restore: async () => ({ status: 'original_running', runtime: runtime() }) });
  await assert.rejects(f.run, /Required process restart/);
  assert.equal(f.record.restartedAt, undefined);
});

test('integrity refusal is preserved together with the original failure; no blind retry', async () => {
  const original = new Error('read failed'), integrity = new Error('changed source');
  let tries = 0;
  const f = fixture({ observeStopped: async () => { throw original; }, restore: async () => { tries++; throw integrity; } });
  await assert.rejects(f.run, error => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === integrity);
  assert.equal(tries, 1); assert.equal(f.record.restoration.status, 'failed');
});

test('host sleep during verification cannot authorize a late stop', async () => {
  const f = fixture(); f.ports.verify = async () => { f.setTime(200); return f.before; };
  await assert.rejects(f.run, { code: 'WEB_OBSERVATION_EXPIRED' });
  assert.equal(f.calls.includes('stop'), false);
});

test('host sleep after stop forces restoration but cannot certify a late result', async () => {
  const f = fixture(); f.ports.observeStopped = async () => { f.setTime(200); return {}; };
  await assert.rejects(f.run, { code: 'WEB_OBSERVATION_EXPIRED' });
  assert.equal(f.calls.filter(c => c === 'restore').length, 1); assert.equal(f.calls.includes('audit'), false);
});

test('restoration after the deadline does not extend the original observation', async () => {
  const f = fixture(); const restore = f.ports.restore;
  f.ports.restore = async () => { const result = await restore(); f.setTime(200); return result; };
  await assert.rejects(f.run, { code: 'WEB_OBSERVATION_EXPIRED' });
  assert.equal(f.record.restoration.status, 'restarted'); assert.equal(f.calls.includes('audit'), false);
});

test('closed state returned after the deadline cannot be accepted', async () => {
  let time = 10;
  await assert.rejects(() => observeWebBeforeDeadline(100, async () => { time = 200; return { lifecycle: 'closed' }; }, () => time), { code: 'WEB_OBSERVATION_EXPIRED' });
  assert.throws(() => requireWebDeadline(100, 100), { code: 'WEB_OBSERVATION_EXPIRED' });
});

test('restoration binding permits only the stopped original web and exact scheduler/configuration', () => {
  const before = runtime(), stopped = structuredClone(before); stopped.web.pid = null;
  assert.doesNotThrow(() => assertWebRestartBinding(before, stopped));
  for (const mutate of [r => { r.web.pid = 999; }, r => { r.web.identity.main.createdAt = 'new'; }, r => { r.eve.pid = 999; }, r => { r.sourceSha256 = 'other'; }, r => { r.workflowStore.id = 'new'; }, r => { r.modelRequestIntervalMs = 0; }, r => { r.securityContext = { enabled: true }; }]) {
    const changed = structuredClone(stopped); mutate(changed);
    assert.throws(() => assertWebRestartBinding(before, changed));
  }
});

test('later repetitions may use the new web PID but cannot change prepared options or scheduler', () => {
  const before = runtime(), next = structuredClone(before); next.web.pid = 303; next.web.identity.main.pid = 303;
  assert.doesNotThrow(() => assertWebRestartConfiguration(before, next));
  next.evidenceGapFixture = { manifestSha256: 'different' };
  assert.throws(() => assertWebRestartConfiguration(before, next), /evidenceGapFixture/);
});

const entry = await readFile(new URL('./autonomy-web.acceptance.mjs', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function acceptanceAdapter(persistedAt) {
  const body = entry.slice(entry.indexOf('attempt.sessionId = submitted.session.state.sessionId;'), entry.indexOf("if (scenario !== 'normal') assert.ok(attempt.fault?.restartedAt"));
  let now = 0, observations = 0;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const attempt = { snapshots: [] };
  const ports = { assert, Date: Clock, protocol: { observationSeconds: 1500 }, workspace: { id: 'owned' },
    submitted: { session: { state: { sessionId: 'original-session' } } }, attempt, scenario: 'normal',
    observe: async () => { observations++; return { missions: [{ lifecycle: 'closed' }] }; },
    persist: async () => { now = persistedAt; }, webFaultReady: () => false, restart: async () => {}, setTimeout,
    requireWebDeadline: deadline => requireWebDeadline(deadline, now),
    observeWebBeforeDeadline: (deadline, observe) => observeWebBeforeDeadline(deadline, observe, () => now) };
  return { attempt, observations: () => observations,
    run: new AsyncFunction(...Object.keys(ports), body).bind(null, ...Object.values(ports)) };
}

test('actual acceptance block rejects host sleep during accepted receipt persistence', async () => {
  for (const time of [1500000, 1600000]) {
    const f = acceptanceAdapter(time);
    await assert.rejects(f.run, { code: 'WEB_OBSERVATION_EXPIRED' });
    assert.equal(f.attempt.acceptedAt, '1970-01-01T00:00:00.000Z');
    assert.equal(f.attempt.closedAt, undefined);
    assert.equal(f.observations(), 0);
  }
});

test('actual acceptance block permits timely closure within its unchanged initial window', async () => {
  const f = acceptanceAdapter(1499999);
  await f.run();
  assert.equal(f.observations(), 1);
  assert.equal(Date.parse(f.attempt.closedAt) - Date.parse(f.attempt.acceptedAt), 1499999);
});

function entryFunction(name, end, ports) {
  const source = entry.slice(entry.indexOf(`async function ${name}(`), entry.indexOf(end, entry.indexOf(`async function ${name}(`)));
  assert.ok(source.startsWith(`async function ${name}(`));
  return new AsyncFunction(...Object.keys(ports), 'argument', `${source}\nreturn ${name}(argument);`).bind(null, ...Object.values(ports));
}
function restoreAdapter({ running = false, mutate, integrityFailure = false, stoppedFailure = false } = {}) {
  const before = runtime(), current = structuredClone(before), calls = [];
  current.web.pid = running ? 101 : null; mutate?.(current);
  const buildIntegrity = { sourceSha256: 'source', dependencySha256: 'deps', services: { web: 'web-hash', eve: 'eve-hash' } };
  const options = { services: ['web'], workflowStoreId: 'store', modelRequestIntervalMs: 6000, modelToken: 'synthetic-token' };
  const run = entryFunction('restoreOriginalWeb', 'async function restart(', {
    assert, resolve, fixture: {}, protocol: { buildIntegrity }, root: 'owned-root',
    restartPreparation: { nodeExecutable: 'managed-node', eveCli: 'owned-eve', options },
    assertWebRestartBinding,
    verifyIsolatedAppArtifacts: async () => { calls.push('integrity'); if (integrityFailure) throw new Error('integrity changed'); return buildIntegrity; },
    readFile: async () => `\uFEFF${JSON.stringify(current)}`,
    observeWindowsRuntime: async () => ({ processes: running ? [{ pid: 101 }] : [], listeners: running ? [{ port: 58000 }] : [] }),
    verifyRuntimeIdentity: value => { calls.push(`identity:${value.services.join(',')}`); assert.equal(value.requireRecordedIdentity, true); },
    requireWindowsRuntimeStopped: async () => { calls.push('stopped'); if (stoppedFailure) throw new Error('remaining owned child'); },
    startIsolatedApp: async (_fixture, received) => { calls.push('start'); assert.strictEqual(received, options); },
    freezeRuntime: async () => { calls.push('post-integrity'); return { ...before, web: { ...before.web, pid: 303 } }; },
  });
  return { calls, run: () => run(before) };
}

test('actual entry adapter starts only after build/Eve/empty-web guards and then reverifies', async () => {
  const f = restoreAdapter(); const result = await f.run();
  assert.equal(result.status, 'restarted');
  assert.deepEqual(f.calls, ['integrity', 'identity:eve', 'stopped', 'start', 'post-integrity']);
});

test('actual entry adapter leaves an exact surviving original running without starting another', async () => {
  const f = restoreAdapter({ running: true }); const result = await f.run();
  assert.equal(result.status, 'original_running');
  assert.equal(f.calls.includes('start'), false);
});

test('actual entry adapter never starts on changed integrity, replacement PID or remaining child', async () => {
  for (const options of [{ integrityFailure: true }, { mutate: r => { r.web.pid = 999; } }, { stoppedFailure: true }, { mutate: r => { r.eve.pid = 999; } }]) {
    const f = restoreAdapter(options); await assert.rejects(f.run); assert.equal(f.calls.includes('start'), false);
  }
});

test('entry prepares credentials before submission and uses post-await bounded observation', () => {
  assert.ok(entry.indexOf('restartPreparation = await prepareRestart(protocol.processes)') < entry.indexOf('await loginAccount(ordinaryAccount)'));
  assert.ok(entry.includes('await observeWebBeforeDeadline(deadline, () => observe(workspace.id))'));
  assert.ok(entry.includes('await restart(attempt, state, deadline)'));
  assert.ok(entry.includes("Date.parse(attempt.closedAt) < deadline"));
  const restartBody = entry.slice(entry.indexOf('async function restart('), entry.indexOf('\ntry {\n  if (auditOnly)'));
  assert.equal(restartBody.includes("readFile('.env'"), false);
});
