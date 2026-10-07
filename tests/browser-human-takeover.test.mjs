import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import ts from 'typescript';
import { browserReturnCases, browserTakeoverReceiptSchema, browserTakeoverRunId } from '../shared/mission-browser-return.ts';
import { DEFAULT_MISSION_LIMITS, MISSION_CONTROLLER_VERSION, missionMandateSchema } from '../shared/mission-control.ts';

const candidate = resolve('.data/autonomy-isolation/next-fixes/auth-return-blocked-case/candidate');
const moduleText = readFileSync(resolve(candidate, 'server/utils/mission-browser-takeover.ts'), 'utf8');
const browserText = readFileSync(resolve(candidate, 'server/utils/browser.ts'), 'utf8');
function compile(text, ports, expression) {
  const tree = ts.createSourceFile('candidate.ts', text, ts.ScriptTarget.Latest, true);
  const body = tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getFullText(tree)).join('\n').replaceAll('export ', '');
  const javascript = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(...Object.keys(ports), `${javascript}; return ${expression};`)(...Object.values(ports));
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const table = name => new Proxy({ name }, { get: (target, key) => key === 'name' ? target.name : { table: name, key } });
const schema = Object.fromEntries(['missions', 'missionTasks', 'missionAttempts', 'missionResourceClaims', 'missionEvents', 'browserAssignments', 'browserJobs', 'testRuns'].map(name => [name, table(name)]));
const eq = (field, value) => row => row[field.key] === value;
const and = (...predicates) => row => predicates.every(predicate => predicate(row));
const desc = field => field;
const sql = (strings, ...values) => strings.join('').includes("->'takeover'")
  ? row => row.payload.takeover.sourceAttemptId === values.at(-1) : { strings, values };

function fixture() {
  const ids = Object.fromEntries(['mission', 'workspace', 'owner', 'thread', 'attempt', 'task', 'dispatch', 'assignment', 'session', 'claim', 'item', 'caseA', 'caseB', 'caseC'].map(key => [key, randomUUID()]));
  const at = ms => new Date(Date.UTC(2026, 9, 6, 18) + ms);
  const spec = { kind: 'browser_tests', caseKeys: ['caseA', 'caseB', 'caseC'].map(key => `${ids.item}:${ids[key]}`), planVersions: [{ itemId: ids.item, version: 1 }] };
  const mission = { id: ids.mission, workspaceId: ids.workspace, userId: ids.owner, threadId: ids.thread, runtime: 'isolated', controllerVersion: MISSION_CONTROLLER_VERSION,
    planRevision: 1, mandateRevision: 1, lifecycle: 'running', phase: 'execute', deadlineAt: at(60000),
    mandate: { version: 1, intent: 'verify', target: { kind: 'public_url', url: 'https://example.test/account' }, allowedTaskKinds: ['browser_tests'], allowedOrigins: ['https://example.test'], repositoryUrls: [], consentIds: [], issuedAt: at(0).toISOString(), deadlineAt: at(60000).toISOString(), limits: { ...DEFAULT_MISSION_LIMITS } } };
  const task = { id: ids.task, missionId: ids.mission, planRevision: 1, state: 'running', spec };
  const attempt = { id: ids.attempt, missionId: ids.mission, taskId: ids.task, runtime: 'isolated', kind: 'browser_tests', planRevision: 1, mandateRevision: 1, requestHash: hash({ spec, planRevision: 1, mandateRevision: 1 }), dispatchId: ids.dispatch, deadlineAt: at(50000), status: 'dispatching', leaseToken: 'original-lease', leaseUntil: at(40000), fence: 1 };
  const assignment = { id: ids.assignment, userId: ids.owner, workspaceId: ids.workspace, threadId: ids.thread, agentId: 'original-eve-session', sessionId: ids.session, control: 'agent', expiresAt: at(50000), projectId: `self-hosted-policy-v1:${'a'.repeat(64)}` };
  const claim = { id: ids.claim, missionId: ids.mission, workspaceId: ids.workspace, attemptId: ids.attempt, runtime: 'isolated', resourceKey: `browser:${ids.workspace}`, executorResourceId: ids.session, state: 'claimed', owner: 'agent', leaseToken: attempt.leaseToken, expiresAt: at(50000), fence: 1 };
  const run = (which, outcome = null) => ({ id: randomUUID(), itemId: ids.item, caseId: ids[which], planVersion: 1, missionAttemptId: ids.attempt, workspaceId: ids.workspace, threadId: ids.thread, runtime: 'isolated', startedAt: at(1000), finishedAt: outcome ? at(3000) : null, result: outcome ? { outcome } : null });
  const rows = { missions: [mission], missionTasks: [task], missionAttempts: [attempt], missionResourceClaims: [claim], browserAssignments: [assignment],
    browserJobs: [{ id: ids.dispatch, runtime: 'isolated', threadId: ids.thread, sessionId: assignment.agentId, status: 'running' }], testRuns: [run('caseA')], missionEvents: [] };
  const state = { now: at(2000), depth: 0, browserLock: true, enabled: true, http: 0, locks: [], queryCount: 0 };
  const connection = {
    select() { return { from(table) {
      let values = rows[table.name] ?? [];
      const query = { where(predicate) { values = values.filter(predicate); return query; }, orderBy(field) { values = [...values].sort((a, b) => b[field.key] - a[field.key]); return query; },
        limit(n) { values = values.slice(0, n); return query; }, then(yes, no) { state.queryCount++; return Promise.resolve(values).then(yes, no); } };
      return query;
    } }; },
    async execute() { return [{ now: state.now.toISOString() }]; },
    async transaction(operation) { state.depth++; try { return await operation(connection); } finally { state.depth--; } },
  };
  const ports = { schema, eq, and, desc, sql, randomUUID, runtimeScope: () => 'isolated', autonomyEnabled: () => state.enabled,
    createError: error => Object.assign(new Error(error.statusMessage), error),
    missionMandateSchema, MISSION_CONTROLLER_VERSION, missionHash: hash, browserTakeoverReceiptSchema, browserTakeoverRunId,
    browserLockSignal: () => state.browserLock ? {} : undefined, assertBrowserLock: async () => assert.equal(state.browserLock, true),
    lockMission: async (_db, id) => { assert.ok(state.depth); state.locks.push(id); },
    browserAttemptAssignment: async () => assignment,
    recordMissionEvent: async (_db, current, kind, payload, eventKey) => {
      assert.ok(state.depth); assert.equal(current.id, mission.id);
      rows.missionEvents.push({ id: randomUUID(), missionId: current.id, kind, payload, eventKey, revision: rows.missionEvents.length + 1 });
    } };
  const module = compile(moduleText, ports, '{captureBrowserTakeover,recordBrowserTakeover,browserTakeoverContinuation}');
  let duringHttp = async () => {};
  const control = compile(browserText.slice(browserText.indexOf('export async function controlBrowser('), browserText.indexOf('export async function assignPreviewBrowser(')), {
    ...module, locked: async (_user, _thread, operation) => operation(connection, assignment), view: row => row.sessionId ? { sessionId: row.sessionId, control: row.control } : null,
    selfHosted: () => true, previewId: () => undefined, release: async () => {}, createError: error => Object.assign(new Error(error.statusMessage), error),
    patch: async (_db, row, changes) => Object.assign(row, changes),
    vpsBrowserRequest: async () => { assert.equal(state.depth, 0, 'No mission/row transaction spans physical HTTP'); state.http++; await duringHttp(); return {}; },
  }, 'controlBrowser');
  const take = () => control(ids.owner, ids.thread, 'human', ids.session);
  const continuation = (before = state.now, settled = true, revision) => module.browserTakeoverContinuation(connection, mission, task, attempt, assignment, claim, before, settled, revision);
  return { ids, at, rows, state, mission, task, attempt, assignment, claim, run, spec, connection, module, take, control, continuation, duringHttp: fn => { duringHttp = fn; } };
}

test('actual failure pattern retains the active account case when later login is interrupted', async () => {
  const f = fixture(), original = f.rows.testRuns[0];
  f.duringHttp(async () => {
    original.finishedAt = f.at(3000); original.result = { outcome: 'blocked' };
    f.rows.testRuns.push({ ...f.run('caseB', 'interrupted'), startedAt: f.at(3500), finishedAt: f.at(4000) });
    f.state.now = f.at(4500);
  });
  await f.take(); const extra = await f.continuation();
  assert.equal(extra.runId, original.id);
  const before = structuredClone(f.rows), selector = process.env.AUTH_RETURN_BASELINE === '1'
    ? compile(readFileSync('shared/mission-browser-return.ts', 'utf8').split('/** A human-return')[1].replace(/^[\s\S]*?(export function browserReturnCases)/, '$1'), {}, 'browserReturnCases') : browserReturnCases;
  assert.deepEqual(selector(f.spec.caseKeys, f.rows.testRuns, f.rows.testRuns[1].id, extra.runId), f.spec.caseKeys);
  assert.deepEqual(f.rows, before, 'Selection never rewrites original results');
});

test('only exact takeover A plus interrupted B; unrelated blocked C and completed outcomes stay original', async () => {
  for (const outcome of ['blocked', 'interrupted', 'passed', 'failed', 'inconclusive']) {
    const f = fixture(), original = f.rows.testRuns[0]; await f.take();
    Object.assign(original, { result: { outcome }, finishedAt: f.at(3000) }); f.state.now = f.at(5000);
    const other = f.run('caseB', 'interrupted'); f.rows.testRuns.push(other, f.run('caseC', 'blocked'));
    const extra = await f.continuation();
    assert.deepEqual(browserReturnCases(f.spec.caseKeys, f.rows.testRuns, other.id, extra?.runId),
      ['blocked', 'interrupted', 'inconclusive'].includes(outcome) ? f.spec.caseKeys.slice(0, 2) : [f.spec.caseKeys[1]]);
  }
});

test('inconclusive resumes only for the acknowledged takeover run, preserving all saved results', async () => {
  const f = fixture(), account = f.rows.testRuns[0];
  f.duringHttp(async () => {
    Object.assign(account, { finishedAt: f.at(3000), result: { outcome: 'inconclusive' } });
    f.rows.testRuns.push({ ...f.run('caseB', 'interrupted'), startedAt: f.at(3500), finishedAt: f.at(4000) }, f.run('caseC', 'inconclusive'));
    f.state.now = f.at(4500);
  });
  await f.take(); const takeover = await f.continuation(), before = structuredClone(f.rows);
  const last = f.rows.testRuns[1];
  assert.equal(takeover.runId, account.id);
  assert.deepEqual(browserReturnCases(f.spec.caseKeys, f.rows.testRuns, last.id, takeover.runId), f.spec.caseKeys.slice(0, 2));
  assert.deepEqual(browserReturnCases(f.spec.caseKeys, f.rows.testRuns, last.id), [f.spec.caseKeys[1]]);
  assert.deepEqual(browserReturnCases(f.spec.caseKeys, f.rows.testRuns, account.id), [], 'An ordinary blockedRunId cannot authorize inconclusive retry');
  assert.deepEqual(f.rows, before);
  for (const outcome of ['passed', 'failed']) {
    const completed = { ...account, id: randomUUID(), result: { outcome } };
    assert.deepEqual(browserReturnCases(f.spec.caseKeys, [...f.rows.testRuns, completed], last.id, takeover.runId), [f.spec.caseKeys[1]]);
  }
  for (const missing of [{ finishedAt: null }, { result: null }]) {
    const unknown = f.rows.testRuns.map(run => run.id === account.id ? { ...run, ...missing } : run);
    assert.throws(() => browserReturnCases(f.spec.caseKeys, unknown, last.id, takeover.runId), /outcome is unknown/);
  }
});

test('no active or multiple active runs confer no guessed latest-run authority', async () => {
  for (const kind of ['none', 'multiple']) {
    const f = fixture(); f.rows.testRuns = kind === 'none' ? [] : [f.run('caseA'), f.run('caseB')];
    await f.take(); assert.equal(f.rows.missionEvents.length, 1); assert.equal(f.rows.missionEvents[0].payload.takeover.run, null);
    assert.equal(await f.continuation(), null);
  }
});

test('duplicate human and heartbeat do not overwrite the acknowledged active-run binding', async () => {
  const f = fixture(); await f.take(); const saved = structuredClone(f.rows.missionEvents);
  f.rows.testRuns = [f.run('caseB')];
  await f.control(f.ids.owner, f.ids.thread, 'heartbeat', f.ids.session); await f.take();
  assert.deepEqual(f.rows.missionEvents, saved);
});

test('a subsequent real boundary without an active run supersedes earlier nomination without rewriting it', async () => {
  const f = fixture(); await f.take(); const saved = structuredClone(f.rows.missionEvents[0]);
  Object.assign(f.rows.testRuns[0], { result: { outcome: 'blocked' }, finishedAt: f.at(3000) }); f.state.now = f.at(4000);
  f.assignment.control = 'agent'; await f.take();
  assert.equal(f.rows.missionEvents.length, 2); assert.deepEqual(f.rows.missionEvents[0], saved);
  assert.equal(await f.continuation(), null);
});

test('expired admission, foreign job or disabled autonomy cannot mint a takeover continuation', async () => {
  for (const change of [f => { f.attempt.leaseUntil = f.at(1000); }, f => { f.claim.expiresAt = f.at(1000); },
    f => { f.mission.deadlineAt = f.at(1000); }, f => { f.rows.browserJobs[0].threadId = randomUUID(); },
    f => { f.rows.browserJobs[0].runtime = 'foreign'; }, f => { f.mission.mandate = null; }, f => { f.state.enabled = false; }]) {
    const f = fixture(); change(f); await f.take(); assert.equal(f.rows.missionEvents.length, 0);
  }
});

test('failed or unknown physical ACK leaves no confirmed takeover retry right', async () => {
  const f = fixture(); f.duringHttp(async () => { throw new Error('Synthetic lost acknowledgement'); });
  await assert.rejects(f.take(), /lost acknowledgement/);
  assert.equal(f.rows.missionEvents.length, 0); assert.equal(f.assignment.control, 'agent');
});

test('changed owner, runtime, session, claim fence and epochs after ACK do not publish authority', async () => {
  for (const change of [f => { f.assignment.userId = randomUUID(); }, f => { f.mission.runtime = 'foreign'; }, f => { f.assignment.sessionId = randomUUID(); },
    f => { f.claim.fence++; }, f => { f.mission.planRevision++; }, f => { f.mission.mandateRevision++; }, f => { f.attempt.cancelRequestedAt = f.at(2500); },
    f => { f.state.now = f.at(50000); }, f => { f.state.enabled = false; }]) {
    const f = fixture(); f.duringHttp(async () => change(f)); await f.take(); assert.equal(f.rows.missionEvents.length, 0);
  }
});

test('foreign task/run identity, substituted policy, deadline or latest boundary cannot nominate an old run', async () => {
  for (const change of [f => { f.rows.testRuns[0].runtime = 'foreign'; }, f => { f.rows.testRuns[0].missionAttemptId = randomUUID(); },
    f => { f.rows.testRuns[0].planVersion++; }, f => { f.assignment.projectId = `self-hosted-policy-v1:${'b'.repeat(64)}`; },
    f => { f.attempt.deadlineAt = f.at(60000); }, f => { f.task.spec.caseKeys = []; }, f => { f.mission.userId = randomUUID(); },
    f => { f.rows.missionEvents[0].payload.takeover.claimId = randomUUID(); }]) {
    const f = fixture(); await f.take(); Object.assign(f.rows.testRuns[0], { finishedAt: f.at(3000), result: { outcome: 'blocked' } }); f.state.now = f.at(4000);
    change(f); await assert.rejects(f.continuation());
  }
});

test('timely return may nominate before settlement, but reservation cannot reuse an unknown outcome', async () => {
  const f = fixture(); await f.take();
  assert.equal((await f.continuation(f.at(2500), false)).runId, f.rows.testRuns[0].id);
  await assert.rejects(f.continuation(f.at(2500)), error => error.statusCode === 409);
  Object.assign(f.rows.testRuns[0], { finishedAt: f.at(3000), result: { outcome: 'blocked' } });
  assert.equal((await f.continuation(f.at(2500))).runId, f.rows.testRuns[0].id, 'Original may finish after wait creation');
});

test('malformed receipt, late acknowledgement and substituted original timing fail closed', async () => {
  const f = fixture(); await f.take(); const value = f.rows.missionEvents[0].payload.takeover;
  assert.equal(browserTakeoverReceiptSchema.safeParse({ ...value, cookies: 'never' }).success, false);
  Object.assign(f.rows.testRuns[0], { finishedAt: f.at(3000), result: { outcome: 'blocked' } }); f.state.now = f.at(5000);
  value.confirmedAt = f.at(50000).toISOString(); await assert.rejects(f.continuation());
  value.confirmedAt = f.at(2000).toISOString(); f.rows.testRuns[0].finishedAt = f.at(1500); await assert.rejects(f.continuation());
});

test('return binds strictly earlier published takeover revision, never a later owner transition', async () => {
  const f = fixture(); await f.take(); Object.assign(f.rows.testRuns[0], { finishedAt: f.at(3000), result: { outcome: 'blocked' } });
  f.state.now = f.at(4000);
  assert.ok(await f.continuation(f.state.now, true, 2));
  await assert.rejects(f.continuation(f.state.now, true, 1), error => error.statusCode === 409);
  await assert.rejects(f.continuation(f.state.now, true, 0), error => error.statusCode === 409);
});
