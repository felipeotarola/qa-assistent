import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Real isolated PostgreSQL and the actual lease selector. No scheduler, HTTP,
// executor or model is started. Invalid rows are intentional fault fixtures.
assert.equal(process.env.GRUNDEN_API_TOKEN, '');
const originalRuntime = process.env.PAT_RUNTIME_SCOPE;
process.env.PAT_RUNTIME_SCOPE += `-invalid-mandate-${randomUUID()}`;
process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; process.env.MISSIONS_ENABLED = 'true';
const app = await isolatedApp(), { db, schema } = app;
const { acceptMission } = await import('../server/utils/mission-control.ts');
const { claimMission, leaseIdentity, releaseMissionLease } = await import('../server/utils/mission-attempts.ts');
const owner = randomUUID(), other = randomUUID(), workspace = randomUUID(), thread = randomUUID();
const originalRows = await db.select().from(schema.missions).where(eq(schema.missions.runtime, originalRuntime)).orderBy(schema.missions.id);
const passed = [];
let stage = 'fixture setup', base;
const row = async id => (await db.select().from(schema.missions).where(eq(schema.missions.id, id)))[0];
async function add(change = {}) {
  const id = randomUUID();
  const [saved] = await db.insert(schema.missions).values({ ...base, id, requestId: randomUUID(), leaseToken: null, leaseUntil: null, heartbeatAt: null,
    nextWakeAt: new Date(Date.now() - 30_000), createdAt: new Date(Date.now() - 60_000), ...change }).returning();
  return saved;
}
async function retire(mission) { await releaseMissionLease(leaseIdentity(mission), 3_600_000); }
function withoutWake(value) { return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'nextWakeAt')); }
try {
  await db.insert(schema.user).values([{ id: owner, name: 'Lease fixture', email: `${owner}@example.test` }, { id: other, name: 'Foreign owner', email: `${other}@example.test` }]);
  await db.insert(schema.workspaces).values({ id: workspace, userId: owner, name: 'Invalid mandate isolation' });
  await db.insert(schema.threads).values({ id: thread, workspaceId: workspace, userId: owner, title: 'Lease fixture' });
  base = await acceptMission(owner, workspace, thread, { requestId: randomUUID(), intent: 'verify', goal: 'Bounded scheduler contract fixture', target: { kind: 'public_url', url: 'https://example.test/' } });
  await db.update(schema.missions).set({ nextWakeAt: new Date(Date.now() + 3_600_000) }).where(eq(schema.missions.id, base.id));

  stage = 'null mandate cannot poison a later valid due mission';
  const inert = [await add({ mandate: null, admission: null, nextWakeAt: new Date(0) }), await add({ mandate: null, admission: null, nextWakeAt: new Date(1) })];
  const valid = await add();
  const claimed = await claimMission(); assert.equal(claimed?.id, valid.id); await retire(claimed);
  for (const original of inert) assert.deepEqual(await row(original.id), original, 'Historical null rows remain byte-equivalent');
  passed.push(stage);

  stage = 'more than ten malformed rows make bounded forward progress';
  const malformed = [];
  for (let index = 0; index < 13; index++) malformed.push(await add({ mandate: { version: 1 }, nextWakeAt: new Date(index + 100) }));
  const following = await add();
  assert.equal(await claimMission(), null, 'One call inspects at most ten malformed candidates');
  const next = await claimMission(); assert.equal(next?.id, following.id); await retire(next);
  for (const original of malformed) {
    const saved = await row(original.id);
    assert.deepEqual(withoutWake(saved), withoutWake(original), 'Only invalid wake-up metadata changes');
    assert.ok(saved.nextWakeAt > new Date()); assert.ok(saved.nextWakeAt.getTime() <= Date.now() + 60_000);
    assert.equal(saved.leaseToken, null); assert.equal(saved.leaseUntil, null);
  }
  passed.push(stage);

  stage = 'effective due time preserves overdue work ahead of new null wakes';
  const overdue = await add({ lifecycle: 'running', phase: 'report', nextWakeAt: new Date(Date.now() - 10_000) });
  const newlyAccepted = await add({ nextWakeAt: null, createdAt: new Date() });
  const first = await claimMission(); assert.equal(first?.id, overdue.id); await retire(first);
  const second = await claimMission(); assert.equal(second?.id, newlyAccepted.id); await retire(second);
  passed.push(stage);

  stage = 'targeted malformed and invalid epoch get no lease or authority';
  for (const change of [{ mandate: { version: 99 } }, { planRevision: 0 }, { mandateRevision: null }, { deadlineAt: null }]) {
    const invalid = await add(change); assert.equal(await claimMission(invalid.id), null);
    assert.deepEqual(withoutWake(await row(invalid.id)), withoutWake(invalid));
  }
  passed.push(stage);

  stage = 'foreign runtime/version/owner rows stay untouched and cannot poison current work';
  const foreign = [await add({ runtime: 'foreign-fixture' }), await add({ controllerVersion: 0 }), await add({ userId: other })];
  for (const original of foreign) {
    assert.equal(await claimMission(original.id), null); assert.deepEqual(await row(original.id), original);
  }
  passed.push(stage);

  stage = 'advisory lease and fence remain authoritative across concurrent claims';
  const concurrent = await add();
  const outcomes = await Promise.all([claimMission(concurrent.id), claimMission(concurrent.id)]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  const won = outcomes.find(Boolean); assert.equal(won.fence, (concurrent.fence ?? 0) + 1); await retire(won);
  passed.push(stage);

  stage = 'invalid-row examination produces no executor/model/resource rows';
  assert.deepEqual(await db.select().from(schema.missions).where(eq(schema.missions.runtime, originalRuntime)).orderBy(schema.missions.id), originalRows, 'Existing runtime missions remain immutable');
  assert.equal((await db.select().from(schema.missionAttempts)).filter(value => value.runtime === process.env.PAT_RUNTIME_SCOPE).length, 0);
  assert.equal((await db.select().from(schema.missionResourceClaims)).filter(value => value.runtime === process.env.PAT_RUNTIME_SCOPE).length, 0);
  assert.equal((await db.select().from(schema.browserJobs)).filter(value => value.runtime === process.env.PAT_RUNTIME_SCOPE).length, 0);
  assert.equal((await db.select().from(schema.missionReports).innerJoin(schema.missions, eq(schema.missions.id, schema.missionReports.missionId)).where(eq(schema.missions.workspaceId, workspace))).length, 0);
  passed.push(stage);
} catch (error) {
  console.error(JSON.stringify({ failed: stage, class: error?.name ?? 'UnknownError', statusCode: error?.statusCode ?? null })); process.exitCode = 1;
} finally {
  try {
    await db.transaction(async tx => {
      await tx.delete(schema.threads).where(eq(schema.threads.id, thread));
      await tx.delete(schema.workspaces).where(eq(schema.workspaces.id, workspace));
      await tx.delete(schema.user).where(eq(schema.user.id, owner));
      await tx.delete(schema.user).where(eq(schema.user.id, other));
    });
  } catch (error) {
    console.error(JSON.stringify({ failed: 'owned fixture cleanup', class: error?.name ?? 'UnknownError', statusCode: error?.statusCode ?? null }));
    process.exitCode = 1;
  } finally { await app.close(); }
}
console.log(JSON.stringify({ suite: 'controller-invalid-mandate', scope: 'actual isolated PG lease selector only; no HTTP/model/executor', passed }, null, 2));
