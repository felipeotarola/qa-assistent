import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryRequestId } from '../shared/repository-request.mjs';

test('tool replay is idempotent and distinct calls and threads stay independent', () => {
  const id = repositoryRequestId('thread-a', 'call-a');
  assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(id, repositoryRequestId('thread-a', 'call-a'));
  assert.notEqual(id, repositoryRequestId('thread-a', 'call-b'));
  assert.notEqual(id, repositoryRequestId('thread-b', 'call-a'));
  assert.throws(() => repositoryRequestId('thread-a', ''));
});
