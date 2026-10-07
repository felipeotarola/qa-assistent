import assert from 'node:assert/strict';
import test from 'node:test';
import { ref } from 'vue';
import { createMissionControlClient } from '../app/composables/useAutonomousMissions.ts';

const mission = () => ({ id: 'mission', threadId: 'original-thread', mandateRevision: 4, allowedActions: ['pause', 'cancel'],
  waits: [{ id: 'question', status: 'waiting', allowedAnswers: ['text', 'decline'] }] });
function fixture() {
  const calls = [], reads = [], operations = ref({}), notices = ref({}); let nextId = 0;
  const behavior = { request: async () => ({}), refresh: async () => ({}) };
  const client = createMissionControlClient({ operations, notices, makeId: () => `stable-${++nextId}`,
    request: async (url, options) => { calls.push(JSON.parse(JSON.stringify({ url, ...options }))); return behavior.request(); },
    refresh: async workspace => { reads.push(workspace); return behavior.refresh(); },
  });
  return { ...client, calls, reads, operations, notices, behavior };
}
test('successful commands use the original mission thread and mandate, then only refresh status', async () => {
  const f = fixture(); assert.equal(await f.command('workspace-a', mission(), { action: 'pause' }), true);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].retry, 0); assert.equal(f.calls[0].body.threadId, 'original-thread');
  assert.deepEqual(f.calls[0].body.input, { action: 'pause', missionId: 'mission', expectedMandateRevision: 4, requestId: 'stable-1', reason: '' });
  assert.deepEqual(f.reads, ['workspace-a']); assert.deepEqual(f.operations.value, {});
});
test('an uncertain response retains exactly the same request even when source data or workspace changes', async () => {
  const f = fixture(), m = mission(), answer = { kind: 'text', text: 'Original answer' };
  f.behavior.request = async () => { throw new Error('Connection lost after possible commit'); };
  assert.equal(await f.command('workspace-a', m, { action: 'answer', waitId: 'question', answer }), false);
  m.mandateRevision = 99; m.threadId = 'different-thread'; answer.text = 'Edited after send';
  assert.equal(f.calls.length, 1, 'Status refresh must never drive a retry');
  assert.equal(await f.command('workspace-a', m, { action: 'cancel' }), false);
  assert.equal(await f.retry('workspace-b', m.id), false);
  f.behavior.request = async () => ({}); assert.equal(await f.retry('workspace-a', m.id), true);
  assert.deepEqual(f.calls[1], f.calls[0]); assert.equal(f.calls[1].body.input.answer.text, 'Original answer');
  assert.deepEqual(f.operations.value, {});
});
test('parallel clicks cannot submit another action while the first is in flight', async () => {
  const f = fixture(); let release; f.behavior.request = () => new Promise(resolve => { release = resolve; });
  const first = f.command('workspace-a', mission(), { action: 'pause' });
  assert.equal(await f.command('workspace-a', mission(), { action: 'cancel' }), false);
  assert.equal(await f.retry('workspace-a', 'mission'), false); assert.equal(f.calls.length, 1);
  release({}); await first;
});
test('a stale mandate refreshes the read model without blindly resubmitting a new revision', async () => {
  const f = fixture(); f.behavior.request = async () => { throw { response: { status: 409 } }; };
  assert.equal(await f.command('workspace-a', mission(), { action: 'cancel' }), false);
  assert.deepEqual(f.operations.value, {}); assert.deepEqual(f.reads, ['workspace-a']);
  assert.equal(await f.retry('workspace-a', 'mission'), false); assert.equal(f.calls.length, 1);
  assert.match(f.notices.value['workspace-a:mission'], /status har ändrats/);
});
test('UI cannot offer a denied lifecycle action, unknown wait, wrong answer type, or expired question', async () => {
  const f = fixture(), m = mission();
  assert.equal(await f.command('workspace-a', m, { action: 'resume' }), false);
  assert.equal(await f.command('workspace-a', m, { action: 'answer', waitId: 'other', answer: { kind: 'text', text: 'answer' } }), false);
  assert.equal(await f.command('workspace-a', m, { action: 'answer', waitId: 'question', answer: { kind: 'browser_returned', sessionId: 'arbitrary' } }), false);
  m.waits[0].status = 'deadline_passed';
  assert.equal(await f.command('workspace-a', m, { action: 'answer', waitId: 'question', answer: { kind: 'decline', reason: '' } }), false);
  assert.equal(f.calls.length, 0);
});
test('read failure after a confirmed command never turns it into an uncertain write', async () => {
  const f = fixture(); f.behavior.refresh = async () => { throw new Error('Status read unavailable'); };
  assert.equal(await f.command('workspace-a', mission(), { action: 'pause' }), true);
  assert.deepEqual(f.operations.value, {}); assert.equal(await f.retry('workspace-a', 'mission'), false); assert.equal(f.calls.length, 1);
});
test('unknown server errors keep the request available only for explicit retry', async () => {
  const f = fixture(); f.behavior.request = async () => { throw { statusCode: 503 }; };
  await f.command('workspace-a', mission(), { action: 'pause' });
  assert.equal(f.operations.value['workspace-a:mission'].state, 'uncertain'); assert.equal(f.calls.length, 1);
  assert.match(f.notices.value['workspace-a:mission'], /kan ha genomförts/);
});
