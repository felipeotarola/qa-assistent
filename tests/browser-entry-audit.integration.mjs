import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { eq, sql } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Independent actual PG + Chromium audit. Only this fresh physical session gets
// synthetic routes; no model calls, shared-site changes, or other users touched.
assert.equal(process.env.BROWSER_SERVICE_URL, 'http://127.0.0.1:58092');
process.env.PAT_RUNTIME_SCOPE += `-entry-audit-${randomUUID()}`;
process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; process.env.MISSIONS_ENABLED = 'true';
const app = await isolatedApp(), { db, schema } = app;
const { saveItem } = await import('../server/utils/workspaces.ts');
const control = await import('../server/utils/mission-control.ts');
const attempts = await import('../server/utils/mission-attempts.ts');
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { browserAction, controlBrowser, disconnectBrowsers } = await import('../server/utils/browser.ts');
const { del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const userId = randomUUID(), workspaceId = randomUUID(), threadId = randomUUID(), executorSessionId = randomUUID();
const base = 'http://qa-fixture.test/', passed = [], failures = [], pending = [];
let mission, task, attempt, plan, run, sessionId, browser, release;
const cases = [base, `${base}audit-redirect`, `${base}audit-pause`].map((entryUrl, index) => ({ id: randomUUID(), title: `Entry audit ${index}`, type: 'browser', entryUrl, preconditions: '', steps: 'Use the returned page control', expected: 'The observed control performs its action' }));
const execution = () => ({ execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } });
const action = input => browserAction(userId, threadId, { runId: run.id, ...input }, executorSessionId, { browserJobId: attempt.dispatchId, executorSessionId, callId: randomUUID() });
function actionInFreshProcess(input) {
  const source = `
    import { readFileSync } from 'node:fs';
    import { isolatedApp } from './tests/helpers/isolated-app.mjs';
    const app = await isolatedApp();
    const { browserAction, disconnectBrowsers } = await import('./server/utils/browser.ts');
    try {
      const args = JSON.parse(readFileSync(0, 'utf8'));
      const result = await browserAction(...args);
      console.log(JSON.stringify({ status: result.status, text: result.text, url: result.url }));
    } finally { await disconnectBrowsers(); await app.close(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    input: JSON.stringify([userId, threadId, { runId: run.id, ...input }, executorSessionId, { browserJobId: attempt.dispatchId, executorSessionId, callId: randomUUID() }]),
    env: process.env, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(child.status, 0, 'Fresh worker must complete its isolated action');
  return JSON.parse(child.stdout.trim());
}
const savedRun = async () => (await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, run.id)))[0];
const start = async test => { run = await testRunAction(userId, workspaceId, threadId, { action: 'start', requestId: randomUUID(), itemId: plan.id, caseId: test.id, expectedVersion: plan.version, environment: mission.config.target.environment, target: mission.config.target, mission: { missionId: mission.id, taskId: task.id } }, execution()); };
const finish = () => testRunAction(userId, workspaceId, threadId, { action: 'finish', runId: run.id, result: { outcome: 'inconclusive', actual: 'Independent synthetic context audit.', unverified: 'Not a website QA verdict.', observations: [], evidenceItemIds: [] } }, execution());
async function check(name, fn) { try { await fn(); passed.push(name); } catch (error) { failures.push({ name, message: error.message }); } }
try {
  await db.insert(schema.user).values({ id: userId, name: 'Entry audit', email: `${userId}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspaceId, userId, name: 'Entry audit' });
  await db.insert(schema.threads).values({ id: threadId, workspaceId, userId, title: 'Entry audit' });
  plan = await saveItem(userId, workspaceId, { title: 'Entry audit', content: { kind: 'test_plan', sources: [], cases } });
  const caseKeys = cases.map(test => `${plan.id}:${test.id}`);
  mission = await control.acceptMission(userId, workspaceId, threadId, { requestId: randomUUID(), intent: 'verify', goal: 'Independently audit start-context isolation.', target: { kind: 'public_url', url: base }, caseKeys });
  task = await db.transaction(async tx => { await control.lockMission(tx, mission.id); return control.addMissionTask(tx, mission, { operationId: randomUUID(), title: 'Entry audit', spec: { kind: 'browser_tests', target: mission.config.target, caseKeys } }); });
  const lease = attempts.leaseIdentity(await attempts.claimMission(mission.id));
  const reserved = await attempts.reserveMissionAttempt(lease, task.id, { resource: { kind: 'browser', poolKey: `entry-audit-${workspaceId}` } });
  assert.equal(reserved.status, 'reserved'); attempt = reserved.attempt; await attempts.markMissionDispatch(lease, attempt.id);
  await db.insert(schema.browserJobs).values({ id: attempt.dispatchId, threadId, runtime: process.env.PAT_RUNTIME_SCOPE, parentSessionId: randomUUID(), sessionId: executorSessionId, task: 'Entry audit', status: 'running', model: 'fixture', reasoning: 'low' });
  await start(cases[0]); const initial = await action({ action: 'open', url: base }); assert.equal(initial.status, 'ready'); sessionId = initial.sessionId;
  const [binding] = await db.select().from(schema.browserAssignments).where(eq(schema.browserAssignments.sessionId, sessionId));
  browser = await chromium.connectOverCDP(binding.connectUrl); const context = browser.contexts()[0]; await finish();

  await check('OPEN controls retain their own tab in a fresh process with no cache, even when a foreground popup copies the ref', async () => {
    let popup;
    await context.route(base, async route => {
      popup = await context.newPage(); await popup.goto(`${base}contact`); await popup.bringToFront();
      await route.fulfill({ contentType: 'text/html', body: '<title>Entry audit</title><button onclick="this.textContent=\'Observed click\'">Primary action</button>' });
    });
    try {
      await start(cases[0]); const opened = await action({ action: 'open', url: base }); assert.equal(opened.status, 'ready');
      const button = opened.controls.find(control => control.label === 'Primary action'); assert.ok(button);
      await popup.evaluate(ref => { const copied = document.createElement('button'); copied.setAttribute('data-pat-ref', ref); copied.textContent = 'Copied control'; copied.onclick = () => { document.body.dataset.copiedClick = 'yes'; }; document.body.append(copied); }, button.ref);
      await disconnectBrowsers(); // Ref resolution cannot rely on process-local Page objects.
      const clicked = actionInFreshProcess({ action: 'click', ref: button.ref });
      assert.equal(clicked.status, 'ready', 'OPEN must not return controls that the next action sends to a different foreground tab');
      assert.match(clicked.text, /Observed click/);
      assert.equal(await popup.evaluate(() => document.body.dataset.copiedClick), undefined);
    } finally { await finish(); await popup?.close(); await context.unroute(base); }
  });
  await check('forged control signatures and DOM-only refs cannot authorize a ref action', async () => {
    await context.route(base, route => route.fulfill({ contentType: 'text/html', body: '<button onclick="this.textContent=\'Observed click\'">Primary action</button>' }));
    try {
      await start(cases[0]); const opened = await action({ action: 'open', url: base }); const ref = opened.controls[0].ref;
      const forged = ref.slice(0, -1) + (ref.endsWith('0') ? '1' : '0');
      assert.equal((await action({ action: 'click', ref: forged })).status, 'action_failed');
      assert.equal((await action({ action: 'click', ref: 'invented-control-0' })).status, 'action_failed');
      const fresh = await action({ action: 'inspect' }); assert.match(fresh.text, /Primary action/);
      assert.equal((await action({ action: 'click', ref: fresh.controls[0].ref })).status, 'ready');
    } finally { await finish(); await context.unroute(base); }
  });
  await check('fill, select and press remain bound to their observed controls across a foreground tab and reconnect', async () => {
    let popup;
    await context.route(base, async route => {
      popup = await context.newPage(); await popup.goto(`${base}contact`); await popup.bringToFront();
      await route.fulfill({ contentType: 'text/html', body: '<input aria-label="Search" onkeydown="if(event.key===\'Enter\') document.querySelector(\'p\').textContent=\'Enter observed\'"><select aria-label="Category"><option>One</option><option>Two</option></select><p>Ready</p>' });
    });
    try {
      await start(cases[0]); let result = await action({ action: 'open', url: base });
      await disconnectBrowsers();
      result = await action({ action: 'fill', ref: result.controls.find(control => control.label === 'Search').ref, text: 'fixture search' });
      assert.equal(result.status, 'ready'); assert.equal(await context.pages().find(page => page.url() === base).locator('input').inputValue(), 'fixture search');
      result = await action({ action: 'select', ref: result.controls.find(control => control.label === 'Category').ref, text: 'Two' });
      assert.equal(result.status, 'ready'); assert.equal(await context.pages().find(page => page.url() === base).locator('select').inputValue(), 'Two');
      result = await action({ action: 'press', ref: result.controls.find(control => control.label === 'Search').ref, text: 'Enter' });
      assert.equal(result.status, 'ready'); assert.match(result.text, /Enter observed/);
    } finally { await finish(); await popup?.close(); await context.unroute(base); }
  });
  await check('a valid signed control cannot authorize an action in another physical session', async () => {
    let otherSession;
    try {
      await start(cases[0]); const opened = await action({ action: 'open', url: base });
      const other = await browserAction(userId, threadId, { action: 'open', url: base }, 'independent-ref-audit');
      assert.equal(other.status, 'ready'); otherSession = other.sessionId; assert.notEqual(otherSession, opened.sessionId);
      const copied = await browserAction(userId, threadId, { action: 'click', ref: opened.controls[0].ref }, 'independent-ref-audit');
      assert.equal(copied.status, 'action_failed');
      assert.equal((await browserAction(userId, threadId, { action: 'click', ref: other.controls[0].ref }, 'independent-ref-audit')).status, 'ready');
    } finally { if (otherSession) await controlBrowser(userId, threadId, 'close', otherSession); await finish(); }
  });
  await check('a legitimate click that opens a new tab returns that tab observation and working controls', async () => {
    const before = new Set(context.pages());
    await context.route(base, route => route.fulfill({ contentType: 'text/html', body: `<a href="${base}contact" target="_blank">Open contact</a>` }));
    try {
      await start(cases[0]); const opened = await action({ action: 'open', url: base });
      const clicked = await action({ action: 'click', ref: opened.controls.find(control => control.label === 'Open contact').ref });
      assert.equal(clicked.status, 'ready'); assert.equal(clicked.url, `${base}contact`, 'click must observe the popup it opened'); assert.ok(clicked.controls.length);
      const contactControl = clicked.controls.find(control => control.label === 'Kontakt'); assert.ok(contactControl);
      const continued = await action({ action: 'click', ref: contactControl.ref }); assert.equal(continued.status, 'ready'); assert.equal(continued.url, `${base}contact`, 'popup refs retain their exact target');
    } finally { await finish(); await Promise.all(context.pages().filter(page => !before.has(page)).map(page => page.close())); await context.unroute(base); }
  });
  await check('closing the original CDP target cannot transfer its ref to another tab at the same URL', async () => {
    await context.route(base, route => route.fulfill({ contentType: 'text/html', body: '<button>Original control</button>' }));
    try {
      await start(cases[0]); const opened = await action({ action: 'open', url: base }), ref = opened.controls[0].ref;
      const source = context.pages().find(page => page.url() === base); assert.ok(source);
      const replacement = await context.newPage(); await replacement.goto(base); await replacement.locator('button').evaluate((button, ref) => button.setAttribute('data-pat-ref', ref), ref);
      await replacement.bringToFront(); await source.close(); await disconnectBrowsers();
      assert.equal((await action({ action: 'click', ref })).status, 'action_failed');
      assert.equal((await action({ action: 'inspect' })).status, 'ready');
    } finally { await finish(); await context.unroute(base); }
  });
  await check('an out-of-mandate redirect never establishes entry context', async () => {
    await context.route(cases[1].entryUrl, route => route.fulfill({ status: 302, headers: { location: 'https://example.com/' } }));
    try { await start(cases[1]); const result = await action({ action: 'open', url: cases[1].entryUrl }); assert.equal(result.status, 'action_failed'); assert.equal((await savedRun()).browserEntryReceipt, null); }
    finally { await finish(); await context.unroute(cases[1].entryUrl); }
  });
  await check('pause during an admitted navigation prevents the late entry receipt', async () => {
    let entered; const enteredPromise = new Promise(done => { entered = done; }), proceed = new Promise(done => { release = done; });
    await context.route(cases[2].entryUrl, async route => { entered(); await proceed; await route.fulfill({ contentType: 'text/html', body: '<h1>Late entry</h1>' }); });
    await start(cases[2]); const late = action({ action: 'open', url: cases[2].entryUrl }); pending.push(late); await enteredPromise;
    await control.controlMission(userId, workspaceId, threadId, { action: 'pause', missionId: mission.id, requestId: randomUUID(), expectedMandateRevision: mission.mandateRevision });
    release(); release = undefined; const result = await late;
    assert.equal(result.status, 'action_failed'); assert.equal((await savedRun()).browserEntryReceipt, null);
    await finish(); await context.unroute(cases[2].entryUrl);
  });
  console.log(JSON.stringify({ passed: passed.length, checks: passed, failures, database: 'actual isolated PostgreSQL', browser: 'actual owned Chromium context', model: false }));
  if (failures.length) process.exitCode = 1;
} finally {
  release?.(); await Promise.allSettled(pending); await browser?.close().catch(() => {});
  if (sessionId) await controlBrowser(userId, threadId, 'close', sessionId).catch(() => {});
  await disconnectBrowsers();
  for (const item of await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, workspaceId))) if (item.blobPath) await del(item.blobPath, { token: workspaceStorageToken() });
  await db.delete(schema.testCaptures).where(sql`${schema.testCaptures.runId} in (select id from pat_test_runs where workspace_id = ${workspaceId})`);
  await db.delete(schema.user).where(eq(schema.user.id, userId)); await app.close();
}
