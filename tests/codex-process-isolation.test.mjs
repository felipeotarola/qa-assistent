import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CodexClient } from '../infra/codex-worker/client.mjs';

// These synthetic guards exercise denied admission and unknown stop receipts;
// the separate Linux suite proves actual cgroup membership and descendant kill.
function child() {
  const value = new EventEmitter(); value.pid = 123;
  value.stdin = new PassThrough(); value.stdout = new PassThrough(); value.stderr = new PassThrough();
  value.stdio = [value.stdin, value.stdout, value.stderr, new PassThrough()];
  value.kill = signal => { queueMicrotask(() => value.emit('exit', null, signal)); return true; };
  return value;
}
const callbacks = { onRequest() {}, onEvent() {}, closeGraceMs: 1, closeForceMs: 1 };

test('unavailable physical isolation denies before spawning a launcher or model', () => {
  let spawned = 0;
  assert.throws(() => new CodexClient({ ...callbacks,
    createProcessScope() { throw new Error('Isolation unavailable'); },
    spawnProcess() { spawned++; return child(); },
  }), /Isolation unavailable/);
  assert.equal(spawned, 0);
});

test('failed physical membership never opens the launch gate or starts the protocol', async () => {
  const process = child(); let gate = '', protocol = '', disposed = 0;
  process.stdio[3].on('data', data => { gate += data; });
  process.stdin.on('data', data => { protocol += data; });
  const client = new CodexClient({ ...callbacks, spawnProcess: () => process,
    createProcessScope: () => ({ id: 'synthetic', mechanism: 'synthetic',
      attach() { throw new Error('Membership not confirmed'); }, empty: () => true,
      kill() {}, dispose() { disposed++; },
    }),
  });
  await assert.rejects(client.initialize(), /Membership not confirmed/);
  await client.close();
  assert.equal(gate, ''); assert.equal(protocol, ''); assert.equal(disposed, 1);
});

test('launcher exit cannot acknowledge a populated or unreadable process scope', async () => {
  for (const empty of [() => false, () => { throw new Error('Scope unreadable'); }]) {
    let disposed = 0;
    const client = new CodexClient({ ...callbacks, spawnProcess: child,
      createProcessScope: () => ({ id: 'synthetic', mechanism: 'synthetic',
        attach() {}, empty, kill() {}, dispose() { disposed++; },
      }),
    });
    await assert.rejects(client.close(), /unconfirmed|Scope unreadable/);
    assert.equal(client.exited, true);
    assert.equal(client.stopReceipt, undefined); assert.equal(disposed, 0);
  }
});
