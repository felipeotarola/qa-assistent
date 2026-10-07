import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// Actual isolated PostgreSQL and the ordinary controller/reservation/planning
// services. Only provider output/page acquisition/browser transport are
// synthetic. Run through run-isolated after applying the reviewed candidate;
// never run against a live acceptance mission or adopt this as model evidence.
const h = await controllerFixture(), { db, schema } = h;
const planner = await import('../server/utils/mission-planning.ts');
const { MISSION_PLANNER_VERSION } = await import('../shared/mission-planning.ts');
const { missionHash } = await import('../server/utils/mission-sources.ts');
const basePlan = h.scripts.planMission, checks = [], held = new Set();
const known = { tokens: 50, toolCalls: 0, durationMs: 1, provider: { providerCalls: 1, unknownCalls: 0,
  inputTokens: 30, outputTokens: 20, totalTokens: 50, cacheReadTokens: null, cacheWriteTokens: null, durationMs: 1 } };
const originalPlan = async (...args) => { await args[3]?.(); const value = await basePlan(...args); return { ...value, usage: structuredClone(known) }; };
h.scripts.planMission = originalPlan;
const failure = (code = 'output_schema_invalid', usage = known) => new h.scripts.MissionPlanningError(structuredClone(usage), { version: 1, code });
const plans = async f => (await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, f.workspace))).filter(item => item.content.kind === 'test_plan');
const events = f => h.rows(schema.missionEvents, f.id);
const planningAttempts = state => state.attempts.filter(attempt => attempt.kind === 'planning').sort((a, b) => a.attemptNo - b.attemptNo);
const providerCalls = f => h.calls.filter(call => call.kind === 'plan' && call.goal === f.goalMarker).length;
async function check(name, fn) {
  try { await fn(); checks.push(name); }
  finally { h.scripts.planMission = originalPlan; process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; }
}
async function firstFailure({ code = 'output_schema_invalid', usage = known, beforeThrow } = {}) {
  const goalMarker = `Original bounded navigation ${randomUUID()}`, f = await h.fixture({ goal: goalMarker }); f.goalMarker = goalMarker;
  await h.pass(f); // Discovery is genuine service persistence, synthetic acquisition.
  h.scripts.planMission = async (input, signal, budget, beforeModel, repair) => {
    h.calls.push({ kind: 'plan', goal: input.goal });
    assert.equal(repair, undefined);
    await beforeModel?.();
    await beforeThrow?.(f, input, signal, budget);
    throw failure(code, usage);
  };
  await h.pass(f);
  h.scripts.planMission = originalPlan;
  const state = await h.state(f), attempts = planningAttempts(state);
  assert.equal(attempts.length, 1); assert.equal(providerCalls(f), 1);
  const attempt = attempts[0], task = state.tasks.find(value => value.id === attempt.taskId);
  const event = (await events(f)).find(value => value.eventKey === `planning-failure:${attempt.id}`);
  return { f, state, attempt, task, event };
}
async function claim(f) {
  await db.update(schema.missions).set({ nextWakeAt: new Date(0) }).where(eq(schema.missions.id, f.id));
  const mission = await h.attempts.claimMission(f.id); assert.ok(mission);
  return h.attempts.leaseIdentity(mission);
}
async function reserveRepair(data) {
  const lease = await claim(data.f), reserved = await h.attempts.reserveMissionAttempt(lease, data.task.id, { usesModel: true });
  assert.equal(reserved.status, 'reserved');
  return { lease, attempt: reserved.attempt };
}
async function holdContent(f) {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  held.add(release);
  const pending = h.sql.begin(async connection => {
    const [row] = await connection`select pg_backend_pid() as pid`;
    await connection`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${f.workspace}`},0))`;
    enter(row.pid); await gate;
  });
  return { pid: await entered, async release() { release(); held.delete(release); await pending; } };
}
async function blockedBy(pid) {
  for (let i = 0; i < 100; i++) {
    if ((await h.sql`select pid from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`).length) return;
    await delay(10);
  }
  assert.fail('Expected actual PostgreSQL content-lock waiter');
}
const denied = promise => assert.rejects(promise, error => [403, 409, 503].includes(error.statusCode));

try {
  assert.equal(MISSION_PLANNER_VERSION, '21');
  assert.equal(process.env.GRUNDEN_API_TOKEN, '');
  await check('first structural failure atomically retains actual usage and a same-operation retry intent', async () => {
    const data = await firstFailure(), { f, attempt, task, event } = data;
    assert.equal(attempt.status, 'failed'); assert.deepEqual(attempt.usage, known);
    assert.equal(task.state, 'pending'); assert.equal(task.blockedReason, null);
    assert.equal(event.payload.retryScheduled, true); assert.deepEqual(event.payload.diagnostic, { version: 1, code: 'output_schema_invalid' });
    assert.equal(event.payload.operationId, attempt.operationId); assert.equal(event.payload.plannerVersion, '21');
    const inputEvent = (await events(f)).find(value => value.eventKey === `planning-input:${attempt.id}`);
    assert.equal(event.payload.fingerprint, inputEvent.payload.fingerprint);
    assert.equal(await plans(f).then(value => value.length), 0);
    h.scripts.planMission = async (...args) => {
      assert.deepEqual(args[4], event.payload.diagnostic);
      return originalPlan(...args);
    };
    await h.pass(f);
    const second = planningAttempts(await h.state(f));
    assert.equal(second.length, 2); assert.equal(second[1].status, 'completed');
    assert.equal(second[1].operationId, attempt.operationId); assert.equal(second[1].attemptNo, 2);
    assert.notEqual(second[1].dispatchId, attempt.dispatchId);
    assert.ok(second[1].deadlineAt <= attempt.deadlineAt);
    assert.deepEqual(await h.row(schema.missionAttempts, attempt.id), attempt, 'Old result/usage/history must remain immutable');
    assert.equal((await plans(f)).length, 1);
    assert.equal((await h.state(f)).tasks.filter(value => value.spec.kind === 'browser_tests').length, 1);
    await h.pass(f); await h.pass(f);
    assert.equal(h.calls.filter(call => call.kind === 'browser:start' && call.missionId === f.id).length, 1);
    assert.equal(h.calls.filter(call => call.kind === 'research' && call.missionId === f.id).length, 1);
    assert.equal((await events(f)).filter(value => value.eventKey === `planning-failure:${attempt.id}`).length, 1);
  });
  await check('second structural failure is terminal and never grants a third physical planning call', async () => {
    const data = await firstFailure();
    h.scripts.planMission = async (input, _signal, _budget, beforeModel) => { await beforeModel?.(); h.calls.push({ kind: 'plan', goal: input.goal }); throw failure('entry_url_unobserved'); };
    await h.pass(data.f);
    const state = await h.state(data.f), attempts = planningAttempts(state);
    assert.equal(attempts.length, 2); assert.equal(attempts[1].status, 'failed');
    assert.equal(state.tasks.find(value => value.id === data.task.id).state, 'failed');
    assert.equal((await events(data.f)).find(value => value.eventKey === `planning-failure:${attempts[1].id}`).payload.retryScheduled, false);
    h.scripts.planMission = () => assert.fail('No third provider invocation');
    await h.pass(data.f); await h.pass(data.f);
    assert.equal(planningAttempts(await h.state(data.f)).length, 2); assert.equal(providerCalls(data.f), 2);
    assert.equal((await plans(data.f)).length, 0);
  });
  await check('restart after committed failure uses saved pending state once without an in-memory callback', async () => {
    const data = await firstFailure(), prior = structuredClone(data.attempt);
    // Discard all callback state; another normal controller lease starts from SQL.
    await db.update(schema.missions).set({ leaseToken: null, leaseUntil: null }).where(eq(schema.missions.id, data.f.id));
    await h.pass(data.f); await h.pass(data.f);
    assert.deepEqual(await h.row(schema.missionAttempts, prior.id), prior);
    assert.equal(planningAttempts(await h.state(data.f)).length, 2);
    assert.equal((await plans(data.f)).length, 1);
    assert.equal((await events(data.f)).filter(value => value.eventKey === `planning-failure:${prior.id}`).length, 1);
  });
  for (const [name, code, usage] of [
    ['unknown usage', 'output_schema_invalid', { ...known, tokens: null, provider: { ...known.provider, unknownCalls: 1, outputTokens: null, totalTokens: null } }],
    ['rate limit', 'provider_rate_limited', known], ['admission denial', 'admission_denied', known], ['unexpected failure', 'unexpected', known],
  ]) await check(`${name} preserves a terminal limitation without authorizing automatic draft repair`, async () => {
    const data = await firstFailure({ code, usage });
    assert.equal(data.task.state, 'failed'); assert.equal(data.event.payload.retryScheduled, false);
    assert.deepEqual(data.attempt.usage, usage);
    h.scripts.planMission = () => assert.fail('A non-repairable failure cannot invoke another planner');
    await h.pass(data.f);
    assert.equal(planningAttempts(await h.state(data.f)).length, 1); assert.equal((await plans(data.f)).length, 0);
  });
  await check('flag off before failure commit prevents retry intent while preserving measured usage', async () => {
    const data = await firstFailure({ beforeThrow: () => { process.env.AUTONOMOUS_MISSIONS_ENABLED = 'false'; } });
    assert.equal(data.event.payload.retryScheduled, false); assert.equal(data.task.state, 'failed'); assert.deepEqual(data.attempt.usage, known);
  });
  await check('flag off after retry intent prevents admission; re-enable uses the same pending operation', async () => {
    const data = await firstFailure(); process.env.AUTONOMOUS_MISSIONS_ENABLED = 'false';
    await h.pass(data.f); assert.equal(planningAttempts(await h.state(data.f)).length, 1);
    assert.equal(providerCalls(data.f), 1); assert.equal((await plans(data.f)).length, 0);
    process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; await h.pass(data.f);
    assert.equal(planningAttempts(await h.state(data.f)).length, 2); assert.equal((await plans(data.f)).length, 1);
  });
  await check('pause and new epoch do not dispatch or publish the prior pending repair', async () => {
    const data = await firstFailure(), before = structuredClone(data.attempt);
    await h.operate(data.f, 'pause'); await h.pass(data.f);
    assert.equal(planningAttempts(await h.state(data.f)).length, 1); assert.equal(providerCalls(data.f), 1);
    await h.operate(data.f, 'resume');
    const current = await h.state(data.f);
    assert.ok(current.mission.mandateRevision > before.mandateRevision);
    assert.ok(current.mission.planRevision > before.planRevision);
    await h.pass(data.f);
    assert.equal(planningAttempts(await h.state(data.f)).filter(value => value.operationId === before.operationId).length, 1);
    assert.deepEqual(await h.row(schema.missionAttempts, before.id), before);
  });
  await check('known first-call cost remains charged at the ordinary global reservation boundary', async () => {
    const data = await firstFailure(), mission = await h.row(schema.missions, data.f.id);
    // Explicit budget fault injection on this synthetic mission, never a live account.
    await db.update(schema.missions).set({ mandate: { ...mission.mandate, limits: { ...mission.mandate.limits, maxTokens: 100000, browserTokensPerAttempt: 100000 } } }).where(eq(schema.missions.id, data.f.id));
    h.scripts.planMission = () => assert.fail('Budget cannot be bypassed by repair');
    await h.pass(data.f);
    assert.equal(planningAttempts(await h.state(data.f)).length, 1);
    assert.deepEqual((await h.row(schema.missionAttempts, data.attempt.id)).usage, known);
  });
  await check('changed saved source fingerprint is terminal before a second physical call', async () => {
    const data = await firstFailure(), ref = data.task.spec.sourceRefs[0], source = await h.row(schema.workspaceItems, ref.id);
    await h.saveItem(h.owner, data.f.workspace, { id: source.id, expectedVersion: source.version, title: source.title, threadId: data.f.thread,
      content: { ...source.content, text: JSON.stringify({ title: 'Changed version', text: 'Different observed body', links: [] }) } }, db,
    { provenance: source.provenance });
    h.scripts.planMission = () => assert.fail('Changed input cannot be silently repaired');
    await h.pass(data.f);
    const state = await h.state(data.f), attempts = planningAttempts(state);
    assert.equal(attempts.length, 2); assert.equal(attempts[1].status, 'failed');
    assert.notEqual(state.tasks.find(value => value.id === data.task.id).state, 'pending');
    assert.equal((await plans(data.f)).length, 0); assert.equal(providerCalls(data.f), 1);
    assert.deepEqual(await h.row(schema.missionAttempts, data.attempt.id), data.attempt);
  });
  await check('past operation deadline cannot be renewed by reserving attempt two', async () => {
    const data = await firstFailure();
    await db.update(schema.missionAttempts).set({ deadlineAt: new Date(0) }).where(eq(schema.missionAttempts.id, data.attempt.id));
    h.scripts.planMission = () => assert.fail('Expired original deadline must reject before provider');
    await h.pass(data.f);
    const attempts = planningAttempts(await h.state(data.f));
    assert.equal(attempts.length, 2); assert.equal(attempts[1].status, 'failed'); assert.equal((await plans(data.f)).length, 0);
    assert.equal(providerCalls(data.f), 1);
  });
  await check('failure returned after attempt deadline is measured but cannot set retry pending', async () => {
    const data = await firstFailure({ beforeThrow: async f => {
      const attempt = planningAttempts(await h.state(f))[0];
      await db.update(schema.missionAttempts).set({ deadlineAt: new Date(0) }).where(eq(schema.missionAttempts.id, attempt.id));
    } });
    assert.equal(data.event.payload.retryScheduled, false); assert.equal(data.task.state, 'failed');
    assert.deepEqual(data.attempt.usage, known); assert.equal((await plans(data.f)).length, 0);
  });
  await check('cancelled original attempt cannot publish a repaired draft or change old history', async () => {
    const data = await firstFailure(), second = await reserveRepair(data);
    const prepared = await planner.prepareMissionPlanning(second.lease, second.attempt.id), result = await originalPlan(prepared.input);
    await h.operate(data.f, 'cancel');
    await denied(planner.persistMissionPlanning(second.lease, second.attempt.id, prepared.fingerprint, result.draft, result.usage));
    assert.equal((await plans(data.f)).length, 0); assert.deepEqual(await h.row(schema.missionAttempts, data.attempt.id), data.attempt);
    await h.pass(data.f);
    assert.equal((await h.row(schema.missionAttempts, second.attempt.id)).status, 'cancelled');
    assert.equal((await h.state(data.f)).tasks.filter(value => value.spec.kind === 'browser_tests').length, 0);
  });
  await check('older prepared planner contract cannot be adopted as a current repair', async () => {
    const data = await firstFailure();
    const prior = (await events(data.f)).find(value => value.eventKey === `planning-input:${data.attempt.id}`);
    // Explicit historic-contract fault row, not a migration or history repair.
    await db.update(schema.missionEvents).set({ payload: { ...prior.payload, plannerVersion: '5' } }).where(eq(schema.missionEvents.id, prior.id));
    h.scripts.planMission = () => assert.fail('Old contract cannot execute as version 6');
    await h.pass(data.f);
    assert.equal(providerCalls(data.f), 1); assert.equal((await plans(data.f)).length, 0);
    assert.equal(planningAttempts(await h.state(data.f))[1].status, 'failed');
  });
  await check('retry prepare clamps persisted deadline and keeps exact original input fingerprint', async () => {
    const data = await firstFailure(), deadlineAt = new Date(Date.now() + 30000);
    await db.update(schema.missionAttempts).set({ deadlineAt }).where(eq(schema.missionAttempts.id, data.attempt.id));
    const second = await reserveRepair(data), prepared = await planner.prepareMissionPlanning(second.lease, second.attempt.id);
    assert.equal(prepared.status, 'prepared'); assert.equal(prepared.deadlineAt.toISOString(), deadlineAt.toISOString());
    assert.equal(prepared.fingerprint, data.event.payload.fingerprint);
    assert.equal(prepared.fingerprint, missionHash({ plannerVersion: '21', input: prepared.input }));
    assert.equal((await h.row(schema.missionAttempts, second.attempt.id)).deadlineAt.toISOString(), deadlineAt.toISOString());
    await h.attempts.releaseMissionLease(second.lease, 0);
  });
  await check('deadline crossing during a real content-lock wait prevents retry preparation', async () => {
    const data = await firstFailure(), second = await reserveRepair(data), deadlineAt = new Date(Date.now() + 250);
    await db.update(schema.missionAttempts).set({ deadlineAt }).where(eq(schema.missionAttempts.id, data.attempt.id));
    const lock = await holdContent(data.f), preparation = planner.prepareMissionPlanning(second.lease, second.attempt.id);
    // Attach rejection assertion before releasing the waiter to avoid unhandled rejection.
    const rejected = denied(preparation);
    await blockedBy(lock.pid); await delay(300); await lock.release(); await rejected;
    assert.equal(providerCalls(data.f), 1); assert.equal((await plans(data.f)).length, 0);
    await h.attempts.releaseMissionLease(second.lease, 0);
  });
  await check('retry publication crossing original deadline rolls back plan, next task and receipt atomically', async () => {
    const data = await firstFailure(), deadlineAt = new Date(Date.now() + 1500);
    await db.update(schema.missionAttempts).set({ deadlineAt }).where(eq(schema.missionAttempts.id, data.attempt.id));
    const second = await reserveRepair(data), prepared = await planner.prepareMissionPlanning(second.lease, second.attempt.id);
    const result = await originalPlan(prepared.input), lock = await holdContent(data.f);
    const rejected = denied(planner.persistMissionPlanning(second.lease, second.attempt.id, prepared.fingerprint, result.draft, result.usage));
    await blockedBy(lock.pid); await delay(Math.max(0, deadlineAt.getTime() - Date.now()) + 50); await lock.release(); await rejected;
    assert.equal((await plans(data.f)).length, 0);
    assert.equal((await h.state(data.f)).tasks.filter(value => value.spec.kind === 'browser_tests').length, 0);
    assert.equal((await events(data.f)).filter(value => value.eventKey === `planning-completed:${data.task.id}`).length, 0);
    await h.attempts.releaseMissionLease(second.lease, 0);
  });
  await check('content changed after retry prepare cannot publish or gain a third model attempt', async () => {
    const data = await firstFailure(), second = await reserveRepair(data);
    const prepared = await planner.prepareMissionPlanning(second.lease, second.attempt.id), result = await originalPlan(prepared.input);
    const source = await h.row(schema.workspaceItems, data.task.spec.sourceRefs[0].id);
    await h.saveItem(h.owner, data.f.workspace, { id: source.id, expectedVersion: source.version, title: source.title,
      content: { ...source.content, text: JSON.stringify({ title: 'Changed after preparation', text: 'Another page', links: [] }) } }, db, { provenance: source.provenance });
    await denied(planner.persistMissionPlanning(second.lease, second.attempt.id, prepared.fingerprint, result.draft, result.usage));
    assert.equal((await plans(data.f)).length, 0);
    assert.equal((await events(data.f)).some(value => value.eventKey === `planning-completed:${data.task.id}`), false);
    await h.attempts.releaseMissionLease(second.lease, 0);
  });
  await check('saved diagnostics never persist provider error messages or cause text', async () => {
    const canary = `private-provider-body-${randomUUID()}`;
    const data = await firstFailure({ beforeThrow: () => {
      const Constructor = h.scripts.MissionPlanningError;
      h.scripts.MissionPlanningError = class extends Constructor { constructor(...args) { super(...args); this.message = canary; this.cause = { text: canary }; } };
    } });
    assert.equal(JSON.stringify({ attempt: data.attempt, events: await events(data.f) }).includes(canary), false);
    assert.equal(data.event.payload.diagnostic.code, 'output_schema_invalid');
  });
  for (const effect of ['source_changed', 'deadline', 'pause', 'cancel']) await check(`known physical usage survives post-model ${effect} without plan publication or current-task revival`, async () => {
    const goalMarker = `Late planner receipt ${randomUUID()}`, f = await h.fixture({ goal: goalMarker }); f.goalMarker = goalMarker;
    await h.pass(f);
    let originalAttempt, afterEffect;
    h.scripts.planMission = async (...args) => {
      const result = await originalPlan(...args);
      originalAttempt = planningAttempts(await h.state(f))[0];
      if (effect === 'source_changed') {
        const source = await h.row(schema.workspaceItems, args[0].sources[0].itemId);
        await h.saveItem(h.owner, f.workspace, { id: source.id, expectedVersion: source.version, title: source.title,
          content: { ...source.content, text: JSON.stringify({ title: 'Changed while provider ran', text: 'Changed actual source', links: [] }) } }, db, { provenance: source.provenance });
      } else if (effect === 'deadline') {
        await db.update(schema.missionAttempts).set({ deadlineAt: new Date(0) }).where(eq(schema.missionAttempts.id, originalAttempt.id));
      } else await h.operate(f, effect);
      afterEffect = await h.state(f);
      return result;
    };
    await h.pass(f);
    const state = await h.state(f), saved = await h.row(schema.missionAttempts, originalAttempt.id);
    assert.deepEqual(saved.usage, known); assert.equal((await plans(f)).length, 0);
    assert.equal(state.tasks.some(task => task.spec.kind === 'browser_tests'), false);
    assert.equal((await events(f)).filter(event => event.eventKey === `planning-usage:${originalAttempt.id}`).length, 1);
    assert.equal((await events(f)).some(event => event.kind === 'planning_failed' && event.payload.retryScheduled === true), false);
    if (['pause', 'cancel'].includes(effect)) {
      assert.equal(state.mission.lifecycle, afterEffect.mission.lifecycle);
      assert.equal(state.mission.mandateRevision, afterEffect.mission.mandateRevision);
      assert.equal(state.mission.planRevision, afterEffect.mission.planRevision);
      assert.deepEqual(state.tasks, afterEffect.tasks, 'Usage receipt cannot publish current-task progress');
      await h.pass(f);
      assert.equal((await h.row(schema.missionAttempts, originalAttempt.id)).status, 'cancelled');
      assert.deepEqual((await h.row(schema.missionAttempts, originalAttempt.id)).usage, known);
    }
  });
  await check('late receipt replay is immutable and exact original invocation binding rejects conflicts', async () => {
    const data = await firstFailure(), before = await h.state(data.f), fingerprint = data.event.payload.fingerprint;
    const count = (await events(data.f)).length;
    await planner.recordMissionPlanningUsage(data.attempt, fingerprint, known);
    assert.equal((await events(data.f)).length, count); assert.deepEqual(await h.state(data.f), before);
    await denied(planner.recordMissionPlanningUsage({ ...data.attempt, dispatchId: randomUUID() }, fingerprint, known));
    await denied(planner.recordMissionPlanningUsage({ ...data.attempt, operationId: 'wrong' }, fingerprint, known));
    await denied(planner.recordMissionPlanningUsage(data.attempt, 'wrong-fingerprint', known));
    await denied(planner.recordMissionPlanningUsage(data.attempt, fingerprint, { ...known, tokens: 51, provider: { ...known.provider, outputTokens: 21, totalTokens: 51 } }));
    await denied(planner.recordMissionPlanningUsage(data.attempt, fingerprint, { ...known, provider: { ...known.provider, providerCalls: 2 } }));
    await denied(planner.recordMissionPlanningUsage(data.attempt, fingerprint, { tokens: 0, toolCalls: 0, durationMs: 0, provider: {
      providerCalls: 0, unknownCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, durationMs: 0 } }));
    assert.deepEqual(await h.state(data.f), before);
  });
  await check('unknown usage refines once for the same physical invocation without reopening terminal work', async () => {
    const unknown = { ...known, tokens: null, provider: { ...known.provider, unknownCalls: 1, outputTokens: null, totalTokens: null } };
    const data = await firstFailure({ usage: unknown }), before = await h.state(data.f);
    await h.operate(data.f, 'cancel'); await h.pass(data.f);
    const stopped = await h.state(data.f);
    await planner.recordMissionPlanningUsage(data.attempt, data.event.payload.fingerprint, known);
    const after = await h.state(data.f);
    assert.deepEqual(after.tasks, stopped.tasks); assert.equal(after.mission.lifecycle, stopped.mission.lifecycle);
    assert.equal(after.mission.mandateRevision, stopped.mission.mandateRevision);
    assert.equal(after.mission.nextWakeAt?.toISOString(), stopped.mission.nextWakeAt?.toISOString());
    assert.equal(after.mission.dirtySince?.toISOString(), stopped.mission.dirtySince?.toISOString());
    assert.equal(after.mission.updatedAt?.toISOString(), stopped.mission.updatedAt?.toISOString());
    assert.deepEqual((await h.row(schema.missionAttempts, data.attempt.id)).usage, known);
    assert.equal((await h.row(schema.missionAttempts, data.attempt.id)).status, before.attempts.find(a => a.id === data.attempt.id).status);
    assert.equal((await events(data.f)).filter(event => event.eventKey === `planning-usage-refined:${data.attempt.id}`).length, 1);
    await planner.recordMissionPlanningUsage(data.attempt, data.event.payload.fingerprint, unknown);
    await planner.recordMissionPlanningUsage(data.attempt, data.event.payload.fingerprint, known);
    assert.deepEqual((await h.row(schema.missionAttempts, data.attempt.id)).usage, known);
    assert.equal((await events(data.f)).filter(event => event.eventKey === `planning-usage-refined:${data.attempt.id}`).length, 1);
  });
  await check('publication cannot overwrite a concurrently refined physical measurement with an older unknown receipt', async () => {
    const data = await firstFailure(), second = await reserveRepair(data);
    const prepared = await planner.prepareMissionPlanning(second.lease, second.attempt.id), result = await basePlan(prepared.input);
    await planner.admitMissionPlanningModel(second.lease, second.attempt.id, prepared.fingerprint);
    const unknown = { ...known, tokens: null, provider: { ...known.provider, unknownCalls: 1, outputTokens: null, totalTokens: null } };
    await planner.recordMissionPlanningUsage(second.attempt, prepared.fingerprint, unknown);
    await planner.recordMissionPlanningUsage(second.attempt, prepared.fingerprint, known);
    await planner.recordMissionPlanningUsage(second.attempt, prepared.fingerprint, unknown);
    await planner.persistMissionPlanning(second.lease, second.attempt.id, prepared.fingerprint, result.draft, unknown);
    assert.deepEqual((await h.row(schema.missionAttempts, second.attempt.id)).usage, known);
    assert.equal((await plans(data.f)).length, 1);
    await h.attempts.releaseMissionLease(second.lease, 0);
  });
  await check('failed terminal settlement also preserves the latest refined measurement', async () => {
    const unknown = { ...known, tokens: null, provider: { ...known.provider, unknownCalls: 1, outputTokens: null, totalTokens: null } };
    const data = await firstFailure({ usage: unknown, beforeThrow: async f => {
      const attempt = planningAttempts(await h.state(f))[0];
      const prepared = (await events(f)).find(event => event.eventKey === `planning-input:${attempt.id}`);
      await planner.recordMissionPlanningUsage(attempt, prepared.payload.fingerprint, unknown);
      await planner.recordMissionPlanningUsage(attempt, prepared.payload.fingerprint, known);
    } });
    assert.deepEqual(data.attempt.usage, known);
    assert.equal(data.event.payload.retryScheduled, true, 'A current bounded repair may use actual refined knowledge, never a guessed zero');
  });
  for (const started of [false, true]) await check(`crash ${started ? 'after' : 'before'} physical admission preserves the bounded uncertainty boundary`, async () => {
    const goalMarker = `Crash admission ${randomUUID()}`, f = await h.fixture({ goal: goalMarker }); f.goalMarker = goalMarker;
    await h.pass(f);
    let attempt;
    h.scripts.planMission = async (_input, _signal, _budget, beforeModel) => {
      if (started) await beforeModel();
      attempt = planningAttempts(await h.state(f))[0];
      // Synthetic worker death after committed preparation/admission, without
      // response or usage. Invalidate the actual controller and attempt leases.
      await db.update(schema.missionAttempts).set({ leaseUntil: new Date(0) }).where(eq(schema.missionAttempts.id, attempt.id));
      await db.update(schema.missions).set({ leaseUntil: new Date(0) }).where(eq(schema.missions.id, f.id));
      throw Object.assign(new Error('Synthetic worker loss'), { statusCode: 409 });
    };
    await h.pass(f); assert.ok(attempt);
    h.scripts.planMission = started ? () => assert.fail('Unknown physical start cannot invoke a second provider') : originalPlan;
    await h.pass(f);
    const after = await h.state(f), attempts = planningAttempts(after);
    assert.equal(attempts.length, 2); assert.equal(attempts[0].status, 'failed');
    assert.equal(attempts[1].status, started ? 'failed' : 'completed');
    assert.equal(providerCalls(f), started ? 0 : 1); assert.equal((await plans(f)).length, started ? 0 : 1);
    assert.equal(attempts[0].usage?.provider, undefined, 'No physical receipt is invented from admission or absence');
    if (!started) assert.ok(attempts[1].deadlineAt <= attempt.deadlineAt, 'Only admitted retry persists the original deadline; a rejected transaction rolls back its provisional clamp');
  });
} finally {
  for (const release of held) release();
  process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; await h.close();
}
console.log(JSON.stringify({ passed: checks.length, checks, execution: 'actual isolated PostgreSQL; synthetic page/model/browser' }, null, 2));
