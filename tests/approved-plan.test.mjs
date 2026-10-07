import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, finished, plan, executionProfile, prepare, execution, missionEnvironmentExecution, environmentPlanHash, environmentRequestFingerprint } from './approved-plan-fixture.mjs';

function approved() {
  const value = plan();
  return { ...prepare(), approvedPlan: { plan: value, planHash: environmentPlanHash(value) } };
}

test('approved preparation wire is exact, scoped and fingerprinted; ordinary prepare stays unchanged', () => {
  const input = approved();
  assert.deepEqual(missionEnvironmentExecution(input), input);
  const plain = prepare();
  assert.deepEqual(missionEnvironmentExecution(plain), plain);
  const binding = execution();
  assert.notEqual(environmentRequestFingerprint(binding, 'Verify', input), environmentRequestFingerprint(binding, 'Verify', plain));
  for (const change of [
    { approvedPlan: null },
    { approvedPlan: { ...input.approvedPlan, consentId: 'not-wire-authority' } },
    { commit: 'b'.repeat(40) },
    { repoUrl: 'https://github.com/example/other' },
    { approvedPlan: { ...input.approvedPlan, planHash: 'b'.repeat(64) } },
    { approvedPlan: { ...input.approvedPlan, plan: { ...input.approvedPlan.plan, values: { PRIVATE_KEY: 'synthetic' } } } },
    { approvedPlan: { plan: { ...input.approvedPlan.plan, executionProfile: undefined }, planHash: environmentPlanHash({ ...input.approvedPlan.plan, executionProfile: undefined }) } },
  ]) assert.throws(() => missionEnvironmentExecution({ ...input, ...change }));
});

test('real worker verifies a fresh checkout and current profile without model, install, start or release', async t => {
  const f = await fixture(t, { prepare: true, approved: true });
  await f.worker.rpc(f.input);
  const job = await finished(f.worker, f.input.jobId);
  assert.equal(job.status, 'needs_configuration');
  assert.equal(job.environment.probeKind, 'identity');
  assert.equal(job.environment.httpStatus, null);
  assert.equal(job.environment.processId, undefined);
  assert.equal(environmentPlanHash(job.environment), f.input.environmentExecution.approvedPlan.planHash);
  assert.deepEqual(job.usage, { providerCalls: 0, tokens: 0, accounting: 'deterministic-prepare' });
  assert.equal(job.cleanup, 'confirmed');
  assert.equal(job.executorStopped, true);
  assert.equal(f.state.status, 'deleted');
  assert.equal(f.constructors(), 0);
  assert.equal(f.requests.length, 0);
  assert.ok(f.calls.some(c => c.args.includes('fetch')));
  assert.ok(f.calls.some(c => c.args.includes('checkout')));
  assert.ok(f.admissions.some(a => a.operationId === 'environment:approved-plan:publish'));
  assert.ok(f.admissions.every(a => a.kind === 'sandbox.command'));
  assert.ok(!f.calls.some(c => c.args.includes('ci') || c.args.includes('install') || c.args[0] === 'start'));
  assert.ok(!JSON.stringify(job).includes(f.secretValue));
  const count = f.calls.length;
  await f.worker.rpc(f.input);
  assert.equal(f.calls.length, count, 'same request returns its original receipt');
  const changed = structuredClone(f.input);
  changed.environmentExecution.approvedPlan.plan.command = 'npm run changed';
  changed.environmentExecution.approvedPlan.planHash = environmentPlanHash(changed.environmentExecution.approvedPlan.plan);
  await assert.rejects(f.worker.rpc(changed), /Submission ID already used for another payload/);
  assert.equal(f.calls.length, count);
});

test('changed full profile or checkout fails without model fallback or secret release', async t => {
  for (const change of [
    { imageDigest: `sha256:${'3'.repeat(64)}` },
    { packageManagerVersion: '11.6.0' },
    { lockfileSha256: '4'.repeat(64) },
    { checkout: true },
  ]) {
    const f = await fixture(t, { prepare: true, approved: true, execute(args) {
      if (change.checkout && args.some(v => String(v).includes('function verifyMissionCheckout'))) throw Error('Checkout changed');
      if (change.imageDigest && args[0] === 'inspect') return change.imageDigest;
      if (args.some(v => String(v).includes('function inspectMissionProfile'))) {
        const profile = { ...executionProfile(), ...change };
        delete profile.imageDigest;
        return JSON.stringify(profile);
      }
    } });
    await f.worker.rpc(f.input);
    const job = await finished(f.worker, f.input.jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.environment, undefined);
    assert.equal(job.cleanup, 'confirmed');
    assert.equal(f.constructors(), 0);
    assert.equal(f.requests.length, 0);
    assert.ok(!f.admissions.some(a => a.operationId === 'environment:approved-plan:publish'));
  }
});

test('revocation during awaited profile is rechecked before identity publication', async t => {
  let revoked = false;
  const f = await fixture(t, { prepare: true, approved: true,
    execute(args) {
      if (args.some(v => String(v).includes('function inspectMissionProfile'))) revoked = true;
    },
    deny: () => revoked,
  });
  await f.worker.rpc(f.input);
  const job = await finished(f.worker, f.input.jobId);
  assert.equal(job.status, 'failed');
  assert.equal(job.environment, undefined);
  assert.equal(job.cleanup, 'confirmed');
  assert.ok(f.admissions.some(a => a.operationId === 'environment:approved-plan:publish'));
  assert.equal(f.constructors(), 0);
  assert.equal(f.requests.length, 0);
});

test('expired original deadline never spawns a model or starts app', async t => {
  const f = await fixture(t, { prepare: true, approved: true });
  f.input.execution.deadlineAt = new Date(Date.now() - 1).toISOString();
  await f.worker.rpc(f.input);
  const job = await finished(f.worker, f.input.jobId);
  assert.ok(['failed', 'timeout'].includes(job.status));
  assert.equal(job.cleanup, 'confirmed');
  assert.equal(f.constructors(), 0);
  assert.equal(f.requests.length, 0);
  assert.ok(f.calls.every(call => call.args[0] === 'close'));
});
