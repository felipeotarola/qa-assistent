import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExecutionStore } from '../infra/execution/store.mjs';
import { ResultOutbox } from '../infra/execution/outbox.mjs';
import { issueSubscription, verifySubscription } from '../infra/execution/stream.mjs';
import { FrameHub } from '../infra/browser/frame-hub.mjs';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'qa-execution-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
test('concurrent progress commits preserve sequence and recover last snapshot after restart', async t => {
  const path = await directory(t), id = randomUUID();
  const store = new ExecutionStore(path, { history: 3 });
  await Promise.all(Array.from({ length: 10 }, (_, index) => store.publish(id, 'repository', 'progress', { logs: `line ${index}` })));
  const recovered = await new ExecutionStore(path).read(id);
  assert.equal(recovered.seq, 10); assert.equal(recovered.snapshot.logs, 'line 9');
  assert.deepEqual(recovered.events.map(e => e.seq), [8, 9, 10]);
  assert.ok(recovered.events.every(e => !e.snapshot));
});
test('permanent delivery errors cannot starve older results and ACK survives restart', async t => {
  const path = await directory(t), delivered = [];
  const jobs = Array.from({ length: 12 }, (_, i) => ({ id: randomUUID(), createdAt: new Date(i * 1000).toISOString() }));
  const deliver = async job => { delivered.push(job.id); return job.id === jobs[0].id ? 404 : 200; };
  const first = new ResultOutbox({ directory: path, deliver });
  await first.drain(jobs); await first.drain(jobs);
  assert.equal(new Set(delivered).size, 12);
  await new ResultOutbox({ directory: path, deliver }).drain(jobs);
  assert.equal(delivered.length, 12);
});
test('transient callback failures wait and retry without blocking healthy jobs', async t => {
  const path = await directory(t); let now = 1000, count = 0;
  const jobs = [{ id: randomUUID(), createdAt: '2026-01-01' }];
  const outbox = new ResultOutbox({ directory: path, now: () => now, deliver: async () => ++count === 1 ? 503 : 200 });
  await outbox.drain(jobs); await outbox.drain(jobs); assert.equal(count, 1);
  now += 3000; await outbox.drain(jobs); assert.equal(count, 2);
});
test('stream grants restrict IDs, origin, signature and lifetime', () => {
  const key = 'private-key', ids = [randomUUID()], origin = 'https://app.example';
  const { token } = issueSubscription(key, ids, origin, 1000);
  assert.deepEqual(verifySubscription(key, token, origin, 2000).ids, ids);
  assert.equal(verifySubscription(key, token, 'https://other.example', 2000), null);
  assert.equal(verifySubscription(key, token, origin, 122000), null);
  assert.equal(verifySubscription('other-key', token, origin, 2000), null);
  assert.throws(() => issueSubscription(key, ['../other'], origin));
});

test('browser viewers share captures and hidden viewers do not cause work', async () => {
  let captures = 0;
  const frames = [];
  const hub = new FrameHub(async () => ++captures, (viewer, frame) => frames.push([viewer, frame]), 10);
  hub.add('one'); hub.add('two');
  await new Promise(resolve => setTimeout(resolve, 35));
  hub.visibility('one', false); hub.visibility('two', false);
  await new Promise(resolve => setTimeout(resolve, 25));
  const stopped = captures;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(captures, stopped);
  assert.deepEqual(frames.filter(([v]) => v === 'one').map(([, n]) => n), frames.filter(([v]) => v === 'two').map(([, n]) => n));
  hub.visibility('one', true);
  await new Promise(resolve => setTimeout(resolve, 15)); hub.close();
  assert.ok(captures > stopped);
});
