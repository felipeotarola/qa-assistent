import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { assertRuntimeStoppedObservation, isolatedServiceCommand, verifyRuntimeIdentity, windowsCommandArguments } from './helpers/isolated-runtime-identity.mjs';

const root = resolve('runtime-fixture'), nodeExecutable = resolve('managed-node.exe'), eveCli = resolve(root, 'dependencies/eve/bin/eve.js');
const createdAt = '2026-10-05T18:00:00Z';
const command = args => [nodeExecutable, ...args].map(value => `"${value}"`).join(' ');
test('a dead CLI does not permit store mutation while an orphan child or listener remains', () => {
  assert.doesNotThrow(() => assertRuntimeStoppedObservation({ processes: [], listeners: [] }));
  assert.throws(() => assertRuntimeStoppedObservation({ processes: [223], listeners: [] }), /Stop all/);
  assert.throws(() => assertRuntimeStoppedObservation({ processes: [], listeners: [223] }), /Stop all/);
  assert.throws(() => assertRuntimeStoppedObservation({ processes: [] }), /Missing/);
});
function fixture() {
  return {
    root, nodeExecutable, eveCli,
    runtime: {
      web: { pid: 111, cwd: resolve(root, 'web'), origin: 'http://127.0.0.1:58000', startedAt: createdAt },
      eve: { pid: 222, cwd: resolve(root, 'eve'), origin: 'http://127.0.0.1:58001', startedAt: createdAt },
    },
    observed: {
      processes: [
        { pid: 111, parentPid: 100, createdAt, executable: nodeExecutable, commandLine: command(isolatedServiceCommand(root, 'web', eveCli)) },
        { pid: 222, parentPid: 100, createdAt, executable: nodeExecutable, commandLine: command(isolatedServiceCommand(root, 'eve', eveCli)) },
        { pid: 223, parentPid: 222, createdAt, executable: nodeExecutable, commandLine: command([resolve(root, 'eve/.output/server/index.mjs')]) },
      ],
      listeners: [{ port: 58000, address: '127.0.0.1', pid: 111 }, { port: 58001, address: '127.0.0.1', pid: 223 }],
    },
  };
}

test('runtime identity accepts actual-shaped web listener and Eve CLI child receipts', () => {
  const f = fixture(), result = verifyRuntimeIdentity(f);
  assert.equal(result.web.listener.pid, 111);
  assert.equal(result.eve.main.pid, 222);
  assert.equal(result.eve.listener.pid, 223);
  assert.equal('commandLine' in result.eve.listener, false);
  assert.throws(() => verifyRuntimeIdentity({ ...f, requireRecordedIdentity: true }), /changed since verified/);
  for (const service of ['web', 'eve']) f.runtime[service].identity = result[service];
  assert.deepEqual(verifyRuntimeIdentity({ ...f, requireRecordedIdentity: true }), result);
  f.observed.processes[2].createdAt = '2026-10-05T18:00:01Z';
  assert.throws(() => verifyRuntimeIdentity({ ...f, requireRecordedIdentity: true }), /changed since verified/);
});

test('wrong executable, command, reused PID, listener owner and child ancestry all fail before API calls', () => {
  const mutations = [
    f => { f.runtime.web.pid = -1; },
    f => { f.runtime.eve.cwd = resolve(root, 'other'); },
    f => { f.runtime.web.origin = 'http://127.0.0.1:3000'; },
    f => { f.observed.processes[0].createdAt = '2026-10-05T17:00:00Z'; },
    f => { f.observed.processes[0].executable = resolve('other-node.exe'); },
    f => { f.observed.processes[0].commandLine = command(['-e', 'console.log("' + resolve(root, 'web/.output/server/index.mjs') + '")']); },
    f => { f.observed.listeners[0].pid = 999; },
    f => { f.observed.listeners[0].address = '0.0.0.0'; },
    f => { f.observed.listeners.push({ ...f.observed.listeners[0], pid: 999 }); },
    f => { f.observed.processes[2].parentPid = 333; },
    f => { f.observed.processes[2].createdAt = '2026-10-05T17:00:00Z'; },
    f => { f.observed.processes[2].commandLine = command([resolve(root, 'other/.output/server/index.mjs')]); },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.throws(() => verifyRuntimeIdentity(f)); }
});

test('Windows argv parser distinguishes quoted paths and injected command arguments', () => {
  assert.deepEqual(windowsCommandArguments('"C:\\Program Files\\node.exe" "C:\\own dir\\entry.mjs" --port 58001'), ['C:\\Program Files\\node.exe', 'C:\\own dir\\entry.mjs', '--port', '58001']);
  assert.deepEqual(windowsCommandArguments('node "" "a\\"b"'), ['node', '', 'a"b']);
  assert.throws(() => windowsCommandArguments('node "unterminated'), /Unbalanced/);
});
