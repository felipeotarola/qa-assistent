import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { eq, sql } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Real PG/Chromium and authored services. Only the privacy HTTP responses and
// one registration wait are injected faults; no model or provider is invoked.
assert.equal(process.env.BROWSER_SERVICE_URL, 'http://127.0.0.1:58092');
process.env.PAT_RUNTIME_SCOPE += `-privacy-${randomUUID()}`;
process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; process.env.MISSIONS_ENABLED = 'true';
const app = await isolatedApp(), { db, schema } = app;
const privacy = await import('../server/utils/browser-trace-privacy.ts');
const { saveItem } = await import('../server/utils/workspaces.ts');
const control = await import('../server/utils/mission-control.ts');
const attempts = await import('../server/utils/mission-attempts.ts');
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { browserAction, controlBrowser, disconnectBrowsers } = await import('../server/utils/browser.ts');
const { get, del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const userId = randomUUID(), workspaceId = randomUUID(), threadId = randomUUID(), executorSessionId = randomUUID();
const originalFetch = globalThis.fetch;
const passed = [], pending = [];
let injection, release, assignment, browser;
globalThis.fetch = async (resource, init) => {
  const url = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
  if (injection && url.startsWith(`${process.env.BROWSER_SERVICE_URL}/sessions/`)) {
    const result = await injection(url, init);
    if (result) return result;
  }
  return originalFetch(resource, init);
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const validReceipt = { version: 1, policyDigest: 'expected-digest', exactValues: true, registeredCount: 1, limitation: 'Exact values only', targetId: 'expected-target' };
const validObservation = { title: 'Title', headings: ['Heading'], text: 'Text', truncated: false };
let detached = 0;
const fakePage = { context: () => ({ newCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId: 'expected-target' } }), detach: async () => { detached++; } }) }) };
try {
  for (const response of [
    { redaction: { ...validReceipt, policyDigest: 'wrong' }, observation: validObservation },
    { redaction: { ...validReceipt, targetId: 'wrong' }, observation: validObservation },
    { redaction: { ...validReceipt, targetId: undefined }, observation: validObservation },
    { redaction: { ...validReceipt, exactValues: false }, observation: validObservation },
    { redaction: { ...validReceipt, version: 2 }, observation: validObservation },
    { redaction: validReceipt, observation: { ...validObservation, text: 'x'.repeat(2401) } },
    { redaction: validReceipt, observation: { ...validObservation, fields: ['unexpected raw value'] } },
  ]) {
    injection = async url => url.endsWith('/observation') ? json(response) : null;
    await assert.rejects(privacy.readBrowserTraceObservation('fake-session', 'expected-digest', fakePage));
  }
  assert.equal(detached, 7);
  injection = async url => url.endsWith('/observation') ? json({ redaction: validReceipt, observation: validObservation }) : null;
  assert.deepEqual(await privacy.readBrowserTraceObservation('fake-session', 'expected-digest', fakePage), validObservation);
  passed.push('Adapter rejects wrong digest/target/policy/shape and always detaches the target lookup session');

  for (const response of [json({ error: 'unavailable' }, 503), json({ redaction: { ...validReceipt, targetId: undefined, policyDigest: 'wrong' } }),
    json({ redaction: { ...validReceipt, targetId: undefined, exactValues: false } })]) {
    injection = async url => url.endsWith('/redaction') ? response : null;
    await assert.rejects(privacy.registerBrowserTraceValues('fake-session', 'expected-digest', ['private-value']));
  }
  passed.push('Registration requires a successful matching privacy receipt');
  injection = null;

  await db.insert(schema.user).values({ id: userId, name: 'Privacy proof', email: `${userId}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspaceId, userId, name: 'Privacy proof' });
  await db.insert(schema.threads).values({ id: threadId, workspaceId, userId, title: 'Privacy proof' });
  const testCase = { id: randomUUID(), title: 'Fill boundary', type: 'browser', preconditions: '', steps: 'Fill the search field', expected: 'The DOM field receives the requested value' };
  const plan = await saveItem(userId, workspaceId, { title: 'Privacy proof', content: { kind: 'test_plan', sources: [], cases: [testCase] } });
  const caseKey = `${plan.id}:${testCase.id}`;
  const mission = await control.acceptMission(userId, workspaceId, threadId, { requestId: randomUUID(), intent: 'verify', goal: 'Test fill privacy guards', target: { kind: 'public_url', url: 'http://qa-fixture.test/products' }, caseKeys: [caseKey] });
  const task = await db.transaction(async tx => { await control.lockMission(tx, mission.id); return control.addMissionTask(tx, mission, { operationId: randomUUID(), title: 'Fill boundary', spec: { kind: 'browser_tests', target: mission.config.target, caseKeys: [caseKey] } }); });
  const lease = attempts.leaseIdentity(await attempts.claimMission(mission.id));
  const reservation = await attempts.reserveMissionAttempt(lease, task.id, { resource: { kind: 'browser', poolKey: `privacy-proof-${workspaceId}` } });
  assert.equal(reservation.status, 'reserved'); const attempt = reservation.attempt;
  await attempts.markMissionDispatch(lease, attempt.id);
  await db.insert(schema.browserJobs).values({ id: attempt.dispatchId, threadId, runtime: process.env.PAT_RUNTIME_SCOPE, parentSessionId: randomUUID(), sessionId: executorSessionId, task: 'Fill boundary', status: 'running', model: 'fixture', reasoning: 'low' });
  const run = await testRunAction(userId, workspaceId, threadId, { action: 'start', requestId: randomUUID(), itemId: plan.id, caseId: testCase.id, expectedVersion: plan.version, environment: mission.config.target.environment, target: mission.config.target, mission: { missionId: mission.id, taskId: task.id } }, { execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } });
  const action = input => browserAction(userId, threadId, { runId: run.id, ...input }, executorSessionId, { browserJobId: attempt.dispatchId, executorSessionId, callId: randomUUID() });
  const opened = await action({ action: 'open', url: 'http://qa-fixture.test/products' });
  assert.equal(opened.status, 'ready'); assignment = opened.sessionId;
  const [row] = await db.select().from(schema.browserAssignments).where(eq(schema.browserAssignments.sessionId, assignment));
  browser = await chromium.connectOverCDP(row.connectUrl);
  const page = browser.contexts()[0].pages().find(value => value.url().startsWith('http://qa-fixture.test/products'));
  assert.ok(page); const field = opened.controls.find(value => value.tag === 'input'); assert.ok(field);
  const before = await page.locator(`[data-pat-ref="${field.ref}"]`).inputValue();
  injection = async url => url.endsWith('/redaction') ? json({ error: 'synthetic registration failure' }, 503) : null;
  const failed = await action({ action: 'fill', ref: field.ref, text: 'must-not-be-filled' });
  assert.equal(failed.status, 'action_failed'); assert.equal(failed.phase, 'fill');
  assert.equal(await page.locator(`[data-pat-ref="${field.ref}"]`).inputValue(), before);
  passed.push('A failed registration response prevents actual Chromium fill');
  injection = null;

  const filled = await action({ action: 'fill', ref: field.ref, text: 'known-private-fixture' });
  assert.equal(filled.status, 'ready'); assert.ok(filled.actionTrace);
  const currentField = filled.controls.find(value => value.tag === 'input'); assert.ok(currentField);
  assert.equal(await page.locator(`[data-pat-ref="${currentField.ref}"]`).inputValue(), 'known-private-fixture');
  const [traceItem] = await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.id, filled.actionTrace.itemId));
  const savedTrace = await get(traceItem.blobPath, { token: workspaceStorageToken(), access: 'private' });
  const traceText = await new Response(savedTrace.stream).text();
  assert.equal(traceText.includes('known-private-fixture'), false);
  const trace = JSON.parse(traceText);
  assert.equal(trace.observation.linkObservation.method, 'dom-css-visible-anchors');
  assert.ok(trace.observation.linkObservation.links.some(link => link.label === 'Björk & Böna' && link.href === 'http://qa-fixture.test/'));
  assert.ok(trace.observation.linkObservation.links.some(link => link.label === 'Kontakt' && link.href === 'http://qa-fixture.test/contact'));
  assert.equal(Object.hasOwn(trace, 'clickedTarget'), false);
  assert.equal(trace.filledField.valueMatchesRequested, true);
  assert.equal(trace.filledField.cssVisible, true);
  assert.equal(trace.filledField.masking, 'not-detected');
  passed.push('A matching real service receipt allows fill and stores only bounded sanitized DOM predicates');

  let entered;
  const reached = new Promise(done => { entered = done; });
  const resume = new Promise(done => { release = done; });
  injection = async (url, init) => {
    if (!url.endsWith('/redaction')) return null;
    const result = await originalFetch(url, init);
    entered(); await resume; return result;
  };
  const delayed = action({ action: 'fill', ref: currentField.ref, text: 'must-not-fill-after-pause' }); pending.push(delayed);
  await reached;
  await control.controlMission(userId, workspaceId, threadId, { action: 'pause', missionId: mission.id, requestId: randomUUID(), expectedMandateRevision: mission.mandateRevision });
  release(); release = null;
  const stopped = await delayed;
  assert.equal(stopped.status, 'action_failed'); assert.equal(stopped.phase, 'fill');
  assert.equal(await page.locator(`[data-pat-ref="${currentField.ref}"]`).inputValue(), 'known-private-fixture');
  passed.push('A committed mission pause during the registration HTTP wait prevents the physical fill after its successful receipt');
  console.log(JSON.stringify({ passed: passed.length, checks: passed, database: 'actual isolated PostgreSQL', browser: 'actual Chromium', faults: 'synthetic privacy HTTP responses/barrier', model: false }, null, 2));
} finally {
  release?.(); await Promise.allSettled(pending); globalThis.fetch = originalFetch;
  await browser?.close().catch(() => {});
  if (assignment) await controlBrowser(userId, threadId, 'close', assignment).catch(() => {});
  await disconnectBrowsers();
  for (const item of await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, workspaceId))) if (item.blobPath) await del(item.blobPath, { token: workspaceStorageToken() });
  await db.delete(schema.testCaptures).where(sql`${schema.testCaptures.runId} in (select id from pat_test_runs where workspace_id = ${workspaceId})`);
  await db.delete(schema.user).where(eq(schema.user.id, userId));
  await app.close();
}
