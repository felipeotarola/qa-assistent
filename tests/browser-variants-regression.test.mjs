import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { auditRegression, prepareSyntheticRegressionHistory, regressionEditCandidate, regressionFingerprint, regressionHistoryLabel, regressionPlan, syntheticRegressionResult, validateRegressionHistory } from './helpers/browser-variants-regression.mjs';
import { extraProvisioningScript } from './helpers/browser-variants-extra-provision.mjs';

function prepared() {
  const planId = randomUUID(), beforeContent = regressionPlan(undefined, 'a'), afterContent = regressionPlan(beforeContent.cases.map(row => row.id), 'b');
  const runs = beforeContent.cases.map((testCase, index) => ({ id: randomUUID(), item_id: planId, case_id: testCase.id, plan_version: 1, snapshot: testCase,
    target: { url: 'http://qa-regression.test/regression/a' }, runtime: 'autonomy-test:unit', result: syntheticRegressionResult(testCase, index),
    started_at: '2026-10-05T12:00:00Z', finished_at: '2026-10-05T12:00:00Z', mission_attempt_id: null })).sort((a, b) => a.case_id.localeCompare(b.case_id));
  const preparation = { protocol: 'browser-variants-synthetic-regression-v1', preparation: 'synthetic-unreviewed-history', label: regressionHistoryLabel,
    userId: randomUUID(), workspaceId: randomUUID(), planId, beforeContent, afterContent, runs, caseKeys: afterContent.cases.map(row => `${planId}:${row.id}`),
    historySha256: regressionFingerprint(runs), realBrowserActions: 0, realModelCalls: 0, fabricatedReviews: 0 };
  const state = { runs: structuredClone(runs), captures: [], versions: [{ item_id: planId, version: 2, content: afterContent }],
    missions: [{ id: randomUUID(), lifecycle: 'closed', lease_until: null, closure_reason: 'investigated', mandate_revision: 1, plan_revision: 1, admission: { intent: 'regression', caseKeys: preparation.caseKeys } }],
    reports: [{ id: 'report', item_id: 'report-item', status: 'completed', lease_until: null, document: { partial: false, summary: 'Syntetisk historik', sources: runs.map(row => ({ id: row.id })) } }],
    reportItems: [{ id: 'report-item', version: 1, deleted_at: null }], claims: [], jobs: [], attempts: [], tasks: [] };
  return { preparation, state };
}

test('A/B keep the original requirements; synthetic history never invents reviewed physical proof', () => {
  const { preparation } = prepared();
  const withoutEntry = row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'entryUrl'));
  assert.deepEqual(preparation.beforeContent.cases.map(withoutEntry), preparation.afterContent.cases.map(withoutEntry));
  for (const run of preparation.runs) { assert.match(run.result.actual, /SYNTHETIC WEB04/); assert.deepEqual(run.result.evidenceItemIds, []); assert.equal(run.mission_attempt_id, null); }
  assert.deepEqual(preparation.runs.map(row => row.result.outcome).sort(), ['failed', 'passed']);
});
test('read projection additions do not invalidate original history, but result/version/target/identity mutation does', () => {
  const value = prepared(); value.state.runs.forEach(row => row.browser_entry_receipt = null); assert.equal(validateRegressionHistory(value.state, value.preparation).length, 2);
  for (const mutate of [run => run.result.actual = 'passed', run => run.plan_version = 2, run => run.target.url += '/new', run => run.id = randomUUID(), run => run.mission_attempt_id = randomUUID()]) {
    const changed = prepared(); mutate(changed.state.runs[0]); assert.throws(() => validateRegressionHistory(changed.state, changed.preparation));
  }
  const changed = prepared(); changed.state.captures.push({ run_id: changed.preparation.runs[0].id }); assert.throws(() => validateRegressionHistory(changed.state, changed.preparation), /physical evidence/);
});
test('owner plan edit trigger is only between frozen planning and the first browser attempt', () => {
  const { state, preparation } = prepared(); state.missions[0].lifecycle = 'running';
  state.tasks.push({ id: 'task', state: 'pending', spec: { kind: 'browser_tests', caseKeys: preparation.caseKeys, planVersions: [{ itemId: preparation.planId, version: 2 }] } });
  assert.equal(regressionEditCandidate(state, preparation).taskId, 'task');
  state.attempts.push({ kind: 'browser_tests' }); assert.equal(regressionEditCandidate(state, preparation), null);
  state.attempts = []; state.tasks[0].spec.planVersions[0].version = 3; assert.equal(regressionEditCandidate(state, preparation), null);
});
test('normal B requires new exact selected requirements and disclosure of synthetic history', () => {
  const value = prepared(); const { state, preparation } = value;
  state.runs.push(...preparation.afterContent.cases.map(testCase => ({ id: randomUUID(), case_id: testCase.id, snapshot: testCase, plan_version: 2,
    mission_attempt_id: randomUUID(), target: { url: 'http://qa-regression.test/regression/b' } })));
  assert.equal(auditRegression(state, preparation, { variant: 'normal' }).fullRealHistoricalRegression, false);
  for (const mutate of [copy => copy.state.runs.at(-1).plan_version = 1, copy => copy.state.runs.at(-1).snapshot.expected = 'changed', copy => copy.state.reports[0].document.summary = 'Real previous test',
    copy => copy.state.reports[0].document.sources.pop(), copy => copy.state.missions[0].admission.caseKeys.pop()]) {
    const copy = structuredClone(value); mutate(copy); assert.throws(() => auditRegression(copy.state, preparation, { variant: 'normal' }));
  }
});
test('plan-changed requires actual saved edit, zero new runs, partial delivery and physical cleanup', () => {
  const { state, preparation } = prepared(), changed = structuredClone(preparation.afterContent); changed.cases[0].expected += ' Nytt krav.';
  const fault = { planEditedAt: '2026-10-05T12:00:02Z', expectedVersion: 2, savedVersion: 3, savedContentSha256: regressionFingerprint(changed) };
  state.versions.push({ item_id: preparation.planId, version: 3, content: changed }); state.reports[0].document.partial = true; state.missions[0].closure_reason = 'blocked';
  assert.ok(auditRegression(state, preparation, { variant: 'plan-changed', fault }));
  state.runs.push({ id: 'unexpected-run' }); assert.throws(() => auditRegression(state, preparation, { variant: 'plan-changed', fault }), /Changed selected plan/);
});
test('S1 needs a distinct owner completing after cancellation, no newer physical attempts and no claims', () => {
  const { state, preparation } = prepared(); state.missions[0].closure_reason = 'cancelled';
  const fault = { cancelledAt: '2026-10-05T12:00:10Z', command: { action: 'cancel' } }, independent = { verified: true, userId: randomUUID(), workspaceId: randomUUID(), closedAt: '2026-10-05T12:00:11Z' };
  assert.ok(auditRegression(state, preparation, { variant: 'stop-independent', fault, independent }));
  for (const patch of [{ userId: preparation.userId }, { workspaceId: preparation.workspaceId }, { closedAt: '2026-10-05T12:00:09Z' }, { verified: false }]) assert.throws(() => auditRegression(state, preparation, { variant: 'stop-independent', fault, independent: { ...independent, ...patch } }));
  state.claims.push({}); assert.throws(() => auditRegression(state, preparation, { variant: 'stop-independent', fault, independent }), /physical resources/);
});
test('history writer rejects foreign DB before any connection', async () => {
  await assert.rejects(prepareSyntheticRegressionHistory({ fixture: { databaseUrl: 'postgres://not-used:not-used@remote.invalid/production' } }), /loopback|isolated/i);
});
test('separate extra provisioner is inert, narrowly allowlisted and never mounts the private oracle', () => {
  const result = extraProvisioningScript('SynaAutonomy-123456789abc', Buffer.from('server'), 'a'.repeat(64));
  assert.match(result.script, /192\.0\.2\.12\/32/); assert.match(result.script, /qa-regression.test qa-auth.test/); assert.match(result.script, /--runtime=runsc/);
  assert.match(result.script, /test ! -L/); assert.match(result.script, /readlink -m/); assert.doesNotMatch(result.script, /oracle|docker rm|docker stop|--publish|--privileged/);
  assert.throws(() => extraProvisioningScript('other', Buffer.from('server'), 'a'.repeat(64)));
});
test('extra DNS mapping affects only two exact fixture names behind local runtime fences', () => {
  const resolver = new URL('./helpers/browser-variants-extra-resolver.mjs', import.meta.url).href;
  const script = `import dns from 'node:dns'; import promises from 'node:dns/promises'; dns.lookup=(_h,_o,cb)=>cb(null,'original',4); promises.lookup=async()=>({address:'original',family:4});
    await import(${JSON.stringify(resolver)}); console.log(JSON.stringify(await Promise.all(['qa-regression.test','qa-auth.test','qa-benchmark.test','other.invalid'].map(h=>promises.lookup(h)))));`;
  const env = { SYSTEMROOT: process.env.SYSTEMROOT, PATH: process.env.PATH, SYNA_BROWSER_EXTRA_VARIANTS: 'fixture-v1', PAT_RUNTIME_SCOPE: 'autonomy-test:pure', BROWSER_SERVICE_URL: 'http://127.0.0.1:58092', DATABASE_URL: 'postgres://fake:fake@127.0.0.1:50000/syna_test_autonomy_pure' };
  const run = patch => spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, ...patch }, encoding: 'utf8', windowsHide: true });
  const result = run({}); assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout).map(row => row.address), ['192.0.2.12', '192.0.2.12', 'original', 'original']);
  for (const patch of [{ VERCEL: '1' }, { PAT_RUNTIME_SCOPE: 'prod' }, { SYNA_BROWSER_EXTRA_VARIANTS: '' }]) assert.notEqual(run(patch).status, 0);
});
