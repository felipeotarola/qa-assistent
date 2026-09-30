import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Sandboxes } from './sandbox.mjs';
import { ExecutionStore } from '../execution/store.mjs';
import { ResourceBudget } from '../execution/budget.mjs';

// Run on Linux with Docker/runsc. Creates only disposable fixture environments.
const directory = await mkdtemp('/var/tmp/qa-sandbox-smoke-');
const events = new ExecutionStore(`${directory}/events`), budget = new ResourceBudget();
const service = new Sandboxes({ directory, events, budget }); await service.init();
const first = { id: randomUUID(), workspaceId: randomUUID(), owner: 'a'.repeat(64) };
const second = { id: randomUUID(), workspaceId: randomUUID(), owner: 'b'.repeat(64) };
async function command(identity, command) {
  const processId = randomUUID();
  await service.rpc({ ...identity, action: 'spawn', processId, command });
  const deadline = Date.now() + 60000;
  for (;;) {
    const process = await service.rpc({ ...identity, action: 'process', processId });
    if (process.status === 'completed') return process;
    assert.ok(Date.now() < deadline, 'Process timeout'); await new Promise(resolve => setTimeout(resolve, 300));
  }
}
try {
  await service.rpc({ ...first, action: 'ensure' }); await service.rpc({ ...second, action: 'ensure' });
  assert.equal(budget.usedMiB, 3072);
  const tools = await command(first, 'node --version && /opt/node22/bin/node --version && java -version && python3 --version && git --version');
  assert.equal(tools.exitCode, 0, tools.stderr); console.log('Runtime profiles:', tools.stdout.trim());
  await service.rpc({ ...first, action: 'write', path: 'fixture.txt', data: Buffer.from('owned by A').toString('base64') });
  assert.equal((await service.rpc({ ...second, action: 'read', path: 'fixture.txt' })).data, null);
  await assert.rejects(service.rpc({ ...first, owner: second.owner, action: 'read', path: 'fixture.txt' }));
  const network = await command(first, "node -e \"fetch('http://100.122.229.15:8090/health',{signal:AbortSignal.timeout(1500)}).then(()=>process.exit(1)).catch(()=>console.log('private access blocked'))\"");
  assert.equal(network.exitCode, 0, network.stderr);
  await service.rpc({ ...first, action: 'stop' }); assert.equal(budget.usedMiB, 1536);
  await service.rpc({ ...first, action: 'ensure' });
  assert.equal(Buffer.from((await service.rpc({ ...first, action: 'read', path: 'fixture.txt' })).data, 'base64').toString(), 'owned by A');
  const processId = randomUUID(); await service.rpc({ ...first, action: 'spawn', processId, command: 'sleep 30' });
  await new Promise(resolve => setTimeout(resolve, 500)); await service.rpc({ ...first, action: 'kill', processId });
  await new Promise(resolve => setTimeout(resolve, 500)); assert.equal((await service.rpc({ ...first, action: 'process', processId })).status, 'completed');
  console.log('PASS: ownership, private-network block, process cancellation, stop/resume and files');
} finally {
  for (const identity of [first, second]) if (service.sessions.has(identity.id)) await service.rpc({ ...identity, action: 'delete' });
  await events.flush(); await rm(directory, { recursive: true });
  assert.equal(budget.usedMiB, 0); console.log('PASS: all resources released');
}
