import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Previews } from '../infra/repo-runner/preview.mjs';

test('preview refuses an unverified network before granting access', async () => {
  const calls = [];
  const previews = new Previews({ base: 'https://worker.example/repository', sandboxes: { sessions: new Map() }, execute: async (command, args) => {
    calls.push([command, args]);
    if (args.includes('{{.HostConfig.Memory}}')) return '2147483648';
    if (args.includes('{{.EnableIPv6}}')) return 'true';
    return '';
  } });
  await assert.rejects(previews.open({ id: randomUUID(), status: 'ready' }, 3000), /IPv6 disabled/);
  assert.equal(previews.active, null);
  assert.ok(!calls.some(([command, args]) => command === 'iptables' && args[0] === '-A'));
  assert.ok(!calls.some(([command, args]) => command === 'docker' && args[0] === 'run'));
});

test('failed cleanup keeps preview capacity reserved and revokes network access first', async () => {
  const calls = [], id = randomUUID(); let failed = true;
  const previews = new Previews({ base: 'https://worker.example/repository', sandboxes: { sessions: new Map() }, execute: async (command, args) => {
    calls.push([command, args]);
    if (command === 'docker' && failed) throw new Error('Docker unavailable');
    return '';
  } });
  previews.active = { id, name: `qa-preview-${id}` };
  await assert.rejects(previews.close(id), /Docker unavailable/);
  assert.equal(previews.active.closing, true);
  assert.equal(previews.match(`/preview/${id}/viewer`), null);
  assert.deepEqual(calls[0], ['iptables', ['-F', 'QA_PREVIEW']]);
  failed = false; await previews.tick(); assert.equal(previews.active, null);
});
