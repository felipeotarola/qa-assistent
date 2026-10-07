import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { eq, sql } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Actual isolated PostgreSQL, Chromium, authored execution guards and persisted
// evidence. Redirect/network/late response routes are deliberate test faults in
// this owned browser context only. No live model or shared fixture-site edits.
assert.equal(process.env.BROWSER_SERVICE_URL, 'http://127.0.0.1:58092');
process.env.PAT_RUNTIME_SCOPE += `-entry-${randomUUID()}`;
process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; process.env.MISSIONS_ENABLED = 'true';
const app = await isolatedApp(), { db, schema } = app;
const { saveItem } = await import('../server/utils/workspaces.ts');
const control = await import('../server/utils/mission-control.ts');
const attempts = await import('../server/utils/mission-attempts.ts');
const { testRunAction, listTestRuns } = await import('../server/utils/test-runs.ts');
const { browserAction, controlBrowser, disconnectBrowsers } = await import('../server/utils/browser.ts');
const { vpsBrowserRequest } = await import('../server/utils/vps-browser.ts');
const { get, del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const userId = randomUUID(), workspaceId = randomUUID(), threadId = randomUUID(), executorSessionId = randomUUID();
const base = 'http://qa-fixture.test/', passed = [], pending = [];
let mission, task, attempt, plan, run, assignment, manualAssignment, browser, release;
const cases = [base, `${base}entry-redirect`, `${base}entry-error`, `${base}entry-late`, undefined].map((entryUrl, i) => ({ id: randomUUID(), title: `Entry case ${i}`, type: 'browser', preconditions: '', steps: 'Inspect the contact page', expected: 'The observed page is reported', ...(entryUrl ? { entryUrl } : {}) }));
const execution = () => ({ execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } });
const startInput = (test = cases[0], requestId = randomUUID()) => ({ action: 'start', requestId, itemId: plan.id, caseId: test.id, expectedVersion: plan.version, environment: mission.config.target.environment, target: mission.config.target, mission: { missionId: mission.id, taskId: task.id } });
const start = async test => { run = await testRunAction(userId, workspaceId, threadId, startInput(test), execution()); return run; };
const actor = () => ({ browserJobId: attempt.dispatchId, executorSessionId, callId: randomUUID() });
const action = input => browserAction(userId, threadId, { runId: run.id, ...input }, executorSessionId, actor());
const finish = () => testRunAction(userId, workspaceId, threadId, { action: 'finish', runId: run.id, result: { outcome: 'inconclusive', actual: 'Harness observations saved; this is not a QA verdict.', unverified: 'Synthetic execution fixture only.', observations: [], evidenceItemIds: [] } }, execution());
const savedRun = async () => (await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, run.id)))[0];
const rejectStart = promise => assert.rejects(promise, error => error.statusCode === 409);
async function readTrace(result) {
  assert.ok(result.actionTrace, JSON.stringify(result));
  const [item] = await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.id, result.actionTrace.itemId));
  return JSON.parse(await new Response((await get(item.blobPath, { access: 'private', token: workspaceStorageToken() })).stream).text());
}
try {
  await db.insert(schema.user).values({ id: userId, name: 'Entry proof', email: `${userId}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspaceId, userId, name: 'Entry proof' });
  await db.insert(schema.threads).values({ id: threadId, workspaceId, userId, title: 'Entry proof' });
  plan = await saveItem(userId, workspaceId, { title: 'Entry proof', content: { kind: 'test_plan', sources: [], cases } });
  const caseKeys = cases.map(test => `${plan.id}:${test.id}`);
  mission = await control.acceptMission(userId, workspaceId, threadId, { requestId: randomUUID(), intent: 'verify', goal: 'Test the per-case browser starting context.', target: { kind: 'public_url', url: base }, caseKeys });
  task = await db.transaction(async tx => { await control.lockMission(tx, mission.id); return control.addMissionTask(tx, mission, { operationId: randomUUID(), title: 'Entry proof', spec: { kind: 'browser_tests', target: mission.config.target, caseKeys } }); });
  const lease = attempts.leaseIdentity(await attempts.claimMission(mission.id));
  const reserved = await attempts.reserveMissionAttempt(lease, task.id, { resource: { kind: 'browser', poolKey: `entry-proof-${workspaceId}` } });
  assert.equal(reserved.status, 'reserved'); attempt = reserved.attempt;
  await attempts.markMissionDispatch(lease, attempt.id);
  await db.insert(schema.browserJobs).values({ id: attempt.dispatchId, threadId, runtime: process.env.PAT_RUNTIME_SCOPE, parentSessionId: randomUUID(), sessionId: executorSessionId, task: 'Entry proof', status: 'running', model: 'fixture', reasoning: 'low' });

  const inputs = Array.from({ length: 4 }, () => ({ ...startInput(), browserEntryReceipt: { version: 1, sessionId: 'forged', requestedUrl: base, observedUrl: base, observedAt: new Date().toISOString(), callId: 'forged' } }));
  const concurrent = await Promise.allSettled(inputs.map(input => testRunAction(userId, workspaceId, threadId, input, execution())));
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of concurrent.filter(value => value.status === 'rejected')) assert.equal(result.reason.statusCode, 409);
  const index = concurrent.findIndex(result => result.status === 'fulfilled'); run = concurrent[index].value;
  assert.equal((await testRunAction(userId, workspaceId, threadId, inputs[index], execution())).id, run.id);
  assert.equal((await db.select().from(schema.testRuns).where(eq(schema.testRuns.missionAttemptId, attempt.id))).length, 1);
  assert.deepEqual(run.nextAction, { action: 'open', url: base, runId: run.id }); assert.equal(run.snapshot.entryUrl, base);
  passed.push('Four concurrent START requests admit one unfinished autonomous case; identical replay returns that run');

  await rejectStart(action({ action: 'click', ref: 'invented' }));
  await rejectStart(action({ action: 'open', url: `${base}contact` }));
  await rejectStart(action({ action: 'open', url: base, runId: undefined }));
  const closed = await action({ action: 'inspect' }); assert.equal(closed.status, 'closed');
  assert.equal((await savedRun()).browserEntryReceipt, null);
  passed.push('Missing entry navigation, wrong entry address and omitted run ID cannot perform browser interactions');

  let current = await action({ action: 'open', url: base }); assert.equal(current.status, 'ready'); assignment = current.sessionId;
  const receipt = (await savedRun()).browserEntryReceipt; assert.equal(receipt.requestedUrl, base); assert.equal(receipt.observedUrl, base); assert.equal(receipt.sessionId, assignment);
  const [binding] = await db.select().from(schema.browserAssignments).where(eq(schema.browserAssignments.sessionId, assignment));
  browser = await chromium.connectOverCDP(binding.connectUrl); const context = browser.contexts()[0];
  await context.addCookies([{ name: 'entry-auth-fixture', value: 'retained', url: base }]);
  await context.pages()[0].evaluate(() => sessionStorage.setItem('entry-state', 'retained'));
  current = await action({ action: 'open', url: `${base}products?q=previous-case` }); assert.equal(current.status, 'ready');
  const finished = await finish();
  for (const value of [run, finished, await listTestRuns(userId, workspaceId, plan.id)]) {
    const text = JSON.stringify(value); assert.equal(text.includes('browserEntryReceipt'), false); assert.equal(text.includes(receipt.callId), false); assert.equal(text.includes(assignment), false);
  }
  passed.push('Actual start observation creates a private physical-session receipt; public run responses expose none of it');

  await start();
  const beforeEntry = await action({ action: 'inspect' }); assert.match(beforeEntry.url, /products/);
  const contact = beforeEntry.controls.find(control => control.label === 'Kontakt'); assert.ok(contact);
  await rejectStart(action({ action: 'click', ref: contact.ref }));
  current = await action({ action: 'open', url: base }); assert.equal(current.status, 'ready');
  current = await action({ action: 'click', ref: current.controls.find(control => control.label === 'Kontakt').ref });
  assert.equal((await readTrace(current)).fromUrl, base); assert.equal(current.url, `${base}contact`);
  assert.equal((await context.cookies(base)).find(cookie => cookie.name === 'entry-auth-fixture')?.value, 'retained');
  assert.equal(await context.pages()[0].evaluate(() => sessionStorage.getItem('entry-state')), 'retained');
  const saved = (await savedRun()).browserEntryReceipt;
  await disconnectBrowsers(); current = await action({ action: 'inspect' }); assert.equal(current.status, 'ready');
  assert.deepEqual((await savedRun()).browserEntryReceipt, saved); await finish();
  passed.push('A new contact case starts from home after search, preserves auth/session state and survives an app CDP reconnect');

  await context.route(`${base}entry-redirect`, route => route.fulfill({ status: 302, headers: { location: `${base}contact` } }));
  await start(cases[1]); current = await action({ action: 'open', url: cases[1].entryUrl }); assert.equal(current.status, 'ready');
  const redirected = (await savedRun()).browserEntryReceipt;
  assert.equal(redirected.requestedUrl, cases[1].entryUrl); assert.equal(redirected.observedUrl, `${base}contact`); assert.equal((await savedRun()).result, null);
  await finish(); await context.unroute(`${base}entry-redirect`);
  passed.push('A real Chromium redirect records requested and final URL separately and never supplies a test verdict');

  let popup;
  await context.route(base, async route => {
    popup = await context.newPage(); await popup.goto(`${base}contact`); await popup.bringToFront();
    await route.fulfill({ contentType: 'text/html', body: '<title>Actual entry page</title><h1>Actual entry page</h1>' });
  });
  await start(); current = await action({ action: 'open', url: base });
  assert.equal(current.status, 'ready'); assert.equal(current.title, 'Actual entry page'); assert.equal(current.url, base);
  assert.equal((await savedRun()).browserEntryReceipt.observedUrl, base); assert.equal((await readTrace(current)).toUrl, base);
  await finish(); await popup.close(); await context.unroute(base);
  passed.push('A concurrent foreground tab cannot replace the actual entry page observation or its saved trace');

  await context.route(`${base}entry-error`, route => route.abort('failed'));
  await start(cases[2]); current = await action({ action: 'open', url: cases[2].entryUrl }); assert.equal(current.status, 'action_failed');
  assert.equal((await savedRun()).browserEntryReceipt, null);
  await rejectStart(action({ action: 'click', ref: 'invented' }));
  assert.ok(['ready', 'action_failed'].includes((await action({ action: 'inspect' })).status));
  await assert.rejects(testRunAction(userId, workspaceId, threadId, { action: 'finish', runId: run.id, result: { outcome: 'passed', actual: 'Unsupported pass', unverified: '', observations: [], evidenceItemIds: [], checks: run.checks.map(check => ({ id: check.id, status: 'verified', actual: 'Unsupported claim' })) } }, execution()), error => error.statusCode === 400);
  await finish(); await context.unroute(`${base}entry-error`);
  passed.push('A failed navigation does not open the entry guard; inspection and honest incomplete FINISH remain available');

  let entered; const reached = new Promise(done => { entered = done; }), proceed = new Promise(done => { release = done; });
  await context.route(`${base}entry-late`, async route => { entered(); await proceed; await route.fulfill({ contentType: 'text/html', body: '<h1>Late response</h1>' }); });
  await start(cases[3]); const late = action({ action: 'open', url: cases[3].entryUrl }); pending.push(late);
  await reached; await finish(); release(); release = undefined; await late;
  assert.equal((await savedRun()).browserEntryReceipt, null); await context.unroute(`${base}entry-late`);
  passed.push('Finishing while navigation waits prevents the late callback from establishing start context');

  await start(cases[4]); assert.equal(run.nextAction, undefined);
  current = await action({ action: 'open', url: `${base}contact` }); assert.equal(current.status, 'ready');
  assert.equal((await savedRun()).browserEntryReceipt, null); await finish();
  passed.push('An explicit autonomous case without entryUrl preserves its existing flow within the original physical session');

  await start(); current = await action({ action: 'open', url: base }); assert.equal(current.status, 'ready');
  const originalAssignment = assignment;
  await browser.close(); browser = undefined;
  await controlBrowser(userId, threadId, 'close', assignment); assignment = undefined;
  const policy = { version: 1, allowedOrigins: [new URL(base).origin], readOnly: true, deadlineAt: new Date(Math.min(attempt.deadlineAt.getTime(), mission.deadlineAt.getTime())).toISOString() };
  const replacement = await vpsBrowserRequest('/sessions', 'POST', undefined, { policy }); assignment = replacement.sessionId;
  await db.update(schema.browserAssignments).set({ sessionId: replacement.sessionId, projectId: `self-hosted-policy-v1:${replacement.policyDigest}`, connectUrl: replacement.connectUrl, liveUrl: replacement.liveUrl, expiresAt: new Date(replacement.expiresAt), control: 'agent' }).where(eq(schema.browserAssignments.id, binding.id));
  await rejectStart(action({ action: 'open', url: base })); await rejectStart(action({ action: 'click', ref: 'invented' })); await finish();
  passed.push('Replacing the actual physical session cannot silently restart an already begun test case');

  await start(cases[4]); assert.equal(run.nextAction, undefined);
  await rejectStart(action({ action: 'open', url: `${base}contact` }));
  assert.equal((await savedRun()).browserEntryReceipt, null);
  assert.equal((await db.select().from(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, attempt.id)))[0].executorResourceId, originalAssignment);
  assert.equal((await db.select().from(schema.browserAssignments).where(eq(schema.browserAssignments.id, binding.id)))[0].sessionId, replacement.sessionId);
  await finish();
  passed.push('A fresh case without entryUrl cannot bypass the old attempt physical-session binding');
  await controlBrowser(userId, threadId, 'close', assignment); assignment = undefined;

  // Manual compatibility has its own executor/session and no mission binding;
  // it must not adopt the stale autonomous attempt's replacement assignment.
  const manualInput = { ...startInput(cases[4]), mission: undefined, target: undefined };
  const manual = await testRunAction(userId, workspaceId, threadId, manualInput);
  assert.equal(manual.nextAction, undefined); assert.equal(manual.snapshot.entryUrl, undefined);
  const manualAgentId = randomUUID();
  current = await browserAction(userId, threadId, { action: 'open', url: `${base}contact`, runId: manual.id }, manualAgentId);
  assert.equal(current.status, 'ready'); manualAssignment = current.sessionId;
  assert.notEqual(manualAssignment, originalAssignment); assert.notEqual(manualAssignment, replacement.sessionId);
  const [manualRun] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, manual.id));
  assert.equal(manualRun.missionAttemptId, null); assert.equal(manualRun.browserEntryReceipt, null);
  await testRunAction(userId, workspaceId, threadId, { action: 'finish', runId: manual.id, result: { outcome: 'inconclusive', actual: 'Manual compatibility fixture only.', unverified: 'No QA verdict.', observations: [], evidenceItemIds: [] } });
  passed.push('A separate manual executor without entryUrl retains its original flow without adopting an autonomous session');
  console.log(JSON.stringify({ passed: passed.length, checks: passed, database: 'actual isolated PostgreSQL', browser: 'actual Chromium', model: false }, null, 2));
} finally {
  release?.(); await Promise.allSettled(pending); await browser?.close().catch(() => {});
  if (assignment) await controlBrowser(userId, threadId, 'close', assignment).catch(() => {});
  if (manualAssignment) await controlBrowser(userId, threadId, 'close', manualAssignment).catch(() => {});
  await disconnectBrowsers();
  for (const item of await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, workspaceId))) if (item.blobPath) await del(item.blobPath, { token: workspaceStorageToken() });
  await db.delete(schema.testCaptures).where(sql`${schema.testCaptures.runId} in (select id from pat_test_runs where workspace_id = ${workspaceId})`);
  await db.delete(schema.user).where(eq(schema.user.id, userId)); await app.close();
}
