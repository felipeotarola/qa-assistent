import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryRequestId } from '../shared/repository-request.mjs';
import { repositoryActionSchema } from '../shared/repository.ts';

test('tool replay is idempotent and distinct calls and threads stay independent', () => {
  const id = repositoryRequestId('thread-a', 'call-a');
  assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(id, repositoryRequestId('thread-a', 'call-a'));
  assert.notEqual(id, repositoryRequestId('thread-a', 'call-b'));
  assert.notEqual(id, repositoryRequestId('thread-b', 'call-a'));
  assert.throws(() => repositoryRequestId('thread-a', ''));
});

test('start preserves an explicit script and leaves an omitted override absent', () => {
  const start = { action: 'start', repositoryId: repositoryRequestId('repo', 'id'), requestId: repositoryRequestId('thread', 'call'), mode: 'test' };
  assert.equal(repositoryActionSchema.parse({ ...start, script: 'build' }).script, 'build');
  assert.equal(repositoryActionSchema.parse(start).script, undefined);
  assert.equal(repositoryActionSchema.safeParse({ ...start, script: 'build; curl bad' }).success, false);
});
