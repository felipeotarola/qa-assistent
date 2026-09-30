import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Runner, terminal, validate } from '../infra/repo-runner/runner.mjs';
const url = 'https://github.com/felipeotarola/surdeg';
const input = () => ({ id: randomUUID(), url, mode: 'test', script: 'test' });
async function harness(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'qa-runner-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const execute = async (args, signal) => {
    calls.push(args);
    if (args[0] === 'run' && overrides.launchFailure) return { code: 125, output: 'runtime unavailable' };
    if (args.includes('rev-parse')) return { code: 0, output: 'a'.repeat(40) };
    if (args.includes('-e') && args.includes('node')) return { code: 0, output: JSON.stringify({ scripts: overrides.scripts || { test: 'node --test' }, nextVersion: overrides.nextVersion, lock: !overrides.pnpm, pnpmLock: !!overrides.pnpm, packageManager: overrides.pnpm ? 'pnpm@10.33.4' : null }) };
    if (args.includes('ci') && overrides.installFailure) return { code: 1, output: 'Install failed' };
    if (args.includes('run') && args.includes('test')) {
      if (overrides.hang) await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }); });
      return { code: overrides.testFailure ? 1 : 0, output: 'test output' };
    }
    return { code: 0, output: '' };
  };
  const runner = new Runner({ directory, execute, timeoutMs: overrides.timeoutMs || 1000 });
  await runner.init(); return { runner, calls };
}
async function finished(runner, id) {
  const deadline = Date.now() + 3000;
  while (!terminal(runner.jobs.get(id).status)) {
    assert.ok(Date.now() < deadline, 'Run should finish');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return runner.jobs.get(id);
}
test('rejects credentials, private URLs and command injection', () => {
  for (const bad of ['http://github.com/a/b', 'https://token@github.com/a/b', 'https://127.0.0.1/a/b', 'https://github.com/a/b?token=x']) assert.throws(() => validate({ ...input(), url: bad }));
  assert.throws(() => validate({ ...input(), script: 'test; whoami' }));
  assert.throws(() => validate({ ...input(), ref: '--upload-pack=bad' }));
  assert.throws(() => validate({ ...input(), args: ['bad\0argument'] }));
});

test('test selection is forwarded as argv under a virtual display', async t => {
  const { runner, calls } = await harness(t);
  const request = { ...input(), args: ['--runInBand', 'literal;not-a-shell-command'] };
  await runner.submit(request);
  assert.equal((await finished(runner, request.id)).status, 'passed');
  const command = calls.find(args => args.includes('xvfb-run'));
  assert.deepEqual(command.slice(command.indexOf('xvfb-run')), ['xvfb-run', '-a', 'npm', '--ignore-scripts', 'run', 'test', '--', ...request.args]);
  await assert.rejects(runner.submit({ ...request, args: ['different'] }));
});
test('idempotent start, exact commit and no privileged container access', async t => {
  const { runner, calls } = await harness(t); const request = input();
  await runner.submit(request); await runner.submit(request);
  const result = await finished(runner, request.id);
  assert.equal(result.status, 'passed'); assert.equal(result.commit, 'a'.repeat(40));
  assert.equal(calls.filter(args => args[0] === 'run').length, 1);
  const launch = calls.find(args => args[0] === 'run');
  assert.ok(launch.includes('--read-only')); assert.ok(launch.includes('--cap-drop'));
  assert.ok(launch.includes('--runtime=runsc'));
  assert.ok(launch.includes('1000:1000'));
  assert.deepEqual(launch.filter(arg => arg.startsWith('type=bind,')), ['type=bind,src=/opt/qa-repo-runner/resolv.conf,dst=/etc/resolv.conf,readonly']);
  assert.ok(!launch.some(arg => /SECRET|TOKEN|KEY=/.test(arg)));
  assert.ok(!launch.includes('--privileged')); assert.ok(!launch.some(arg => arg.includes('docker.sock')));
  assert.ok(calls.some(args => args[0] === 'rm'));
  await assert.rejects(runner.submit({ ...request, script: 'other' }));
});
test('installation failures are blocked, test command failures are failed', async t => {
  for (const [options, status] of [[{ installFailure: true }, 'blocked'], [{ testFailure: true }, 'failed']]) {
    const { runner } = await harness(t, options); const request = input();
    await runner.submit(request); assert.equal((await finished(runner, request.id)).status, status);
  }
});
test('timeout cleans container and releases queue', async t => {
  const { runner, calls } = await harness(t, { hang: true, timeoutMs: 50 }); const request = input();
  await runner.submit(request); assert.equal((await finished(runner, request.id)).status, 'blocked');
  assert.ok(calls.some(args => args[0] === 'rm'));
});
test('queued job can be cancelled while another runs', async t => {
  const { runner } = await harness(t, { hang: true }); const first = input(), second = input();
  await runner.submit(first); await runner.submit(second); await runner.cancel(second.id); await runner.cancel(first.id);
  assert.equal((await finished(runner, second.id)).status, 'cancelled');
  assert.equal((await finished(runner, first.id)).status, 'cancelled');
});
test('unknown public repo launches only in gVisor', async t => {
  const { runner, calls } = await harness(t);
  const request = { ...input(), url: 'https://github.com/other/repo' };
  await runner.submit(request);
  assert.equal((await finished(runner, request.id)).status, 'passed');
  assert.ok(calls.find(args => args[0] === 'run').includes('--runtime=runsc'));
});

test('pnpm executes an explicit script without unsupported npm run flags', async t => {
  const { runner, calls } = await harness(t, { pnpm: true }); const request = input();
  await runner.submit(request); assert.equal((await finished(runner, request.id)).status, 'passed');
  const run = calls.find(args => args.includes('pnpm') && args.includes('run'));
  assert.ok(run.includes('--config.enable-pre-post-scripts=false'));
  assert.ok(!run.includes('--ignore-scripts'));
  const launch = calls.find(args => args[0] === 'run');
  assert.ok(launch.some(arg => arg.startsWith('/workspace:rw,exec,nosuid,nodev,')));
});

test('missing isolated runtime blocks without cloning or executing repository code', async t => {
  const { runner, calls } = await harness(t, { launchFailure: true }); const request = input();
  await runner.submit(request);
  assert.equal((await finished(runner, request.id)).status, 'blocked');
  assert.ok(!calls.some(args => args.includes('clone')));
  assert.ok(!calls.some(args => args.includes('ci')));
});

test('auto selects actual scripts and describes static checks honestly', async t => {
  for (const [scripts, selected] of [
    [{ test: 'jest', typecheck: 'tsc' }, 'test'],
    [{ 'test:unit': 'vitest run', lint: 'eslint .' }, 'test:unit'],
    [{ typecheck: 'tsc', lint: 'eslint .' }, 'typecheck'],
    [{ lint: 'eslint .' }, 'lint'],
  ]) {
    const { runner, calls } = await harness(t, { scripts });
    const request = { ...input(), script: 'auto' };
    await runner.submit(request);
    const job = await finished(runner, request.id);
    assert.equal(job.selectedScript, selected);
    assert.equal(job.script, 'auto');
    assert.equal(job.status, 'passed');
    assert.ok(calls.some(args => args.includes('xvfb-run') && args.includes(selected)));
    if (['lint', 'typecheck'].includes(selected)) assert.match(job.message, /funktionella tester har inte verifierats/);
  }
});

test('explicit missing scripts and unsupported auto choices never silently execute another command', async t => {
  for (const script of ['test', 'auto']) {
    const { runner, calls } = await harness(t, { scripts: { dev: 'serve', format: 'prettier --write .' } });
    const request = { ...input(), script };
    await runner.submit(request);
    const job = await finished(runner, request.id);
    assert.equal(job.status, 'blocked');
    assert.match(job.message, /dev, format/);
    assert.ok(!calls.some(args => args.includes('xvfb-run')));
  }
});

test('removed Next lint is a configuration blockage with cleanup and no install', async t => {
  const { runner, calls } = await harness(t, { scripts: { lint: 'next lint', dev: 'next dev', build: 'next build' }, nextVersion: '^16.0.3' });
  const request = { ...input(), script: 'auto' };
  await runner.submit(request);
  const job = await finished(runner, request.id);
  assert.equal(job.status, 'blocked');
  assert.equal(job.telemetry.failureKind, 'configuration');
  assert.equal(job.testExitCode, null);
  assert.match(job.message, /next lint som togs bort/);
  assert.ok(!calls.some(args => args.includes('ci') || args.includes('xvfb-run')));
  assert.ok(calls.some(args => args[0] === 'rm'));
});

test('restart interrupts an active attempt without replaying commands; queued work survives', async t => {
  const { runner, calls } = await harness(t);
  runner.stopping = true;
  const active = await runner.submit(input()), queued = await runner.submit(input());
  active.status = 'running'; await runner.save(active);
  const recovered = new Runner({ directory: runner.directory, execute: runner.execute });
  await recovered.init();
  assert.equal(recovered.jobs.get(active.id).telemetry.failureKind, 'interrupted');
  assert.equal(recovered.jobs.get(queued.id).status, 'queued');
  assert.ok(calls.some(args => args[0] === 'rm' && args.includes(`qa-repo-${active.id}`)));
  assert.ok(!calls.some(args => args[0] === 'run'));
});

test('cleanup failures disable restart admission until the container is removed', async t => {
  const { runner } = await harness(t); runner.stopping = true;
  const job = await runner.submit(input());
  job.status = 'blocked'; job.telemetry = { failureKind: 'cleanup' }; await runner.save(job);
  const recovered = new Runner({ directory: runner.directory, execute: async () => ({ code: 1, output: 'Docker unavailable' }) });
  await assert.rejects(recovered.init(), /admission remains disabled/);
});

test('repository queue rotates between workspaces without losing FIFO within one workspace', async t => {
  const { runner } = await harness(t); runner.stopping = true;
  const firstWorkspace = randomUUID(), secondWorkspace = randomUUID();
  const requests = [firstWorkspace, firstWorkspace, secondWorkspace].map(workspaceId => ({ ...input(), workspaceId }));
  for (const request of requests) await runner.submit(request);
  const order = [];
  runner.run = async job => { order.push(job.id); job.status = 'review'; };
  runner.stopping = false; await runner.drain();
  assert.deepEqual(order, [requests[0].id, requests[2].id, requests[1].id]);
});
