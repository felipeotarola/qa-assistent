import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as vue from 'vue';

function fixture() {
  const exports = {}, reads = [], mounted = [], unmounted = [], timers = [], states = new Map(), activeId = vue.ref('workspace-a');
  const document = { visibilityState: 'visible' };
  const transport = { read: async () => ({ missions: [{ id: 'mission-a' }], hasMore: false }) };
  const js = ts.transpileModule(readFileSync(new URL('../app/composables/useAutonomousMissions.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { exports, ...vue, document, Reflect, structuredClone,
    useWorkspaces: () => ({ activeId }),
    useRequestFetch: () => async url => { reads.push(url); return transport.read(url); },
    useState: (key, init) => { if (!states.has(key)) states.set(key, vue.ref(init())); return states.get(key); },
    useAsyncData: (_key, handler) => { const data = vue.ref(), error = vue.ref(), pending = vue.ref(false); return { data, error, pending, refresh: async () => { data.value = await handler(); } }; },
    onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => unmounted.push(fn),
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    $fetch: () => { throw new Error('A read path must not perform a write'); },
    require: name => { throw new Error(`Unexpected dependency ${name}`); },
  });
  const client = exports.useAutonomousMissions(true);
  return { client, reads, mounted, unmounted, timers, activeId, document, transport };
}
test('mount and visible polling only read the autonomy projection, never a drain or control endpoint', async () => {
  const f = fixture(); f.mounted.forEach(fn => fn());
  assert.equal(f.reads.length, 0); await f.timers.shift()();
  assert.deepEqual(f.reads, ['/api/workspaces/workspace-a/autonomy']);
  assert.equal(f.client.data.value.missions[0].id, 'mission-a');
  assert.equal(f.timers.length, 1);
});
test('a late response from the previous workspace is not displayed after navigation', async () => {
  const f = fixture(); let release;
  f.transport.read = () => new Promise(resolve => { release = resolve; });
  const pending = f.client.refresh(); f.activeId.value = 'workspace-b';
  release({ missions: [{ id: 'private-to-a' }], hasMore: false }); await pending;
  assert.equal(f.client.data.value, undefined);
  f.transport.read = async () => ({ missions: [{ id: 'mission-b' }], hasMore: false });
  await f.client.refresh(); assert.equal(f.client.data.value.missions[0].id, 'mission-b');
});
test('hidden tabs do not poll and unmount does not schedule another timer', async () => {
  const f = fixture(); f.mounted.forEach(fn => fn()); f.document.visibilityState = 'hidden';
  await f.timers.shift()(); assert.equal(f.reads.length, 0);
  f.unmounted.forEach(fn => fn()); await f.timers.shift()(); assert.equal(f.timers.length, 0);
});
test('explicit telemetry reads use the bound workspace and mission without sending a command', async () => {
  const f = fixture(); f.transport.read = async () => ({ mission: { id: 'mission-a', observedAt: '2026-10-05T13:00:00Z' }, telemetry: { tokens: { total: null } } });
  await f.client.loadDetails('workspace-a', 'mission-a');
  assert.deepEqual(f.reads, ['/api/workspaces/workspace-a/autonomy/mission-a']);
  assert.equal(f.client.detail('workspace-b', 'mission-a'), undefined);
  assert.equal(f.client.detail('workspace-a', 'mission-a').telemetry.tokens.total, null);
});

test('polling refreshes requested telemetry without reading unopened missions', async () => {
  const f = fixture(); let revision = 0;
  f.transport.read = async url => url.endsWith('/autonomy')
    ? { missions: [{ id: 'mission-a' }, { id: 'unopened' }], hasMore: false }
    : { revision: ++revision };
  await f.client.loadDetails('workspace-a', 'mission-a');
  f.mounted.forEach(fn => fn()); await f.timers.shift()();
  assert.equal(f.client.detail('workspace-a', 'mission-a').revision, 2);
  assert.deepEqual(f.reads, ['/api/workspaces/workspace-a/autonomy/mission-a', '/api/workspaces/workspace-a/autonomy', '/api/workspaces/workspace-a/autonomy/mission-a']);
  f.document.visibilityState = 'hidden'; await f.timers.shift()();
  assert.equal(revision, 2);
});

test('failed telemetry automatically recovers and overlapping card reads are deduplicated', async () => {
  const f = fixture(); f.transport.read = async () => { throw new Error('offline'); };
  await f.client.loadDetails('workspace-a', 'mission-a');
  assert.ok(f.client.detailError('workspace-a', 'mission-a'));
  let release;
  f.transport.read = async url => url.endsWith('/autonomy')
    ? { missions: [{ id: 'mission-a' }], hasMore: false }
    : new Promise(resolve => { release = resolve; });
  f.mounted.forEach(fn => fn()); const pending = f.timers.shift()();
  while (!release) await Promise.resolve();
  await f.client.loadDetails('workspace-a', 'mission-a');
  assert.equal(f.reads.length, 3);
  release({ recovered: true }); await pending;
  assert.equal(f.client.detail('workspace-a', 'mission-a').recovered, true);
  assert.equal(f.client.detailError('workspace-a', 'mission-a'), '');
});

test('navigation during a list refresh prevents subsequent old-workspace telemetry reads', async () => {
  const f = fixture(); await f.client.loadDetails('workspace-a', 'mission-a');
  let release; f.transport.read = () => new Promise(resolve => { release = resolve; });
  f.mounted.forEach(fn => fn()); const pending = f.timers.shift()();
  f.activeId.value = 'workspace-b'; release({ missions: [{ id: 'mission-a' }] }); await pending;
  assert.equal(f.reads.length, 2); assert.equal(f.client.data.value, undefined);
});
