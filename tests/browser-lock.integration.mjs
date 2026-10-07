import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Actual isolated PostgreSQL with the deployed app's max=2 pool. No browser,
// runtime or model starts; scoped transaction failures below are intentional.
const app = await isolatedApp(), { schema } = app, owner = randomUUID(), workspace = randomUUID(), thread = randomUUID();
const client = postgres(process.env.DATABASE_URL, { max: 2, prepare: false, connection: { TimeZone: 'UTC', application_name: `browser-pool-proof-${owner}` } });
const db = drizzle(client); globalThis.autonomyTestDb = db;
const checks = [], pending = [];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function check(name, fn) { await fn(); checks.push(name); }
async function timeout(promise, ms = 3000) { return Promise.race([promise, delay(ms).then(() => { throw new Error('Bounded fixture timeout'); })]); }
async function assignment(connection, agentId) { return connection.insert(schema.browserAssignments).values({ id: randomUUID(), userId: owner, workspaceId: workspace, threadId: thread, agentId }); }
async function childLock(key) {
  const child = fork(new URL('./helpers/browser-lock-child.mjs', import.meta.url), [key], { env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  const messages = []; let stderr = '';
  child.on('message', message => messages.push(message)); child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 10000);
  try { await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Lock child failed (${code}): ${stderr.slice(0, 1000)}`))); }); }
  finally { clearTimeout(timer); }
  return messages;
}
try {
  await db.insert(schema.user).values({ id: owner, name: 'Browser pool regression', email: `${owner}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspace, userId: owner, name: 'Browser pool regression' });
  await db.insert(schema.threads).values({ id: thread, userId: owner, workspaceId: workspace, title: 'Browser pool regression' });
  await check('red reproduction: old assignment transaction + auth upsert exhausts pool2 before nested admission can read', async () => {
    let blocked = false;
    await assert.rejects(db.transaction(async tx => {
      await assignment(tx, 'old-auth');
      const auth = client`insert into pat_user (id,name,email,email_verified) values (${owner},'Browser pool regression',${`${owner}@example.test`},false) on conflict(id) do update set email=excluded.email,email_verified=excluded.email_verified`;
      pending.push(auth.then(() => {}));
      for (let i = 0; i < 50; i++) {
        const [row] = await app.sql`select count(*)::int as n from pg_stat_activity where application_name=${`browser-pool-proof-${owner}`} and cardinality(pg_blocking_pids(pid)) > 0`;
        if (row.n) { blocked = true; break; } await delay(10);
      }
      assert.equal(blocked, true, 'Actual FK/auth lock must be observed');
      const nested = db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, owner)); pending.push(nested.then(() => {}));
      await timeout(nested, 150); // Rollback releases the FK lock so cleanup can finish.
    }), /Bounded fixture timeout/);
    await Promise.all(pending.splice(0));
  });
  await check('red reproduction: two old browser transactions starve their own global DB reads with pool2', async () => {
    const entered = deferred(); let count = 0;
    const results = await Promise.allSettled(['old-one', 'old-two'].map(agent => db.transaction(async tx => {
      await assignment(tx, agent); if (++count === 2) entered.resolve(); await entered.promise;
      const nested = db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, owner)); pending.push(nested.then(() => {}));
      await timeout(nested, 150);
    })));
    assert.ok(results.some(result => result.status === 'rejected' && result.reason.message === 'Bounded fixture timeout'));
    await Promise.all(pending.splice(0));
  });
  const { createBrowserLockManager, assertBrowserLock, browserLockSignal } = await import('../server/utils/browser-lock.ts');
  const manager = createBrowserLockManager(client, { waitMs: 300, operationMs: 3000 });
  await check('dedicated lock-only transaction permits auth upsert while assignment is committed and browser waits', async () => {
    await timeout(manager.run(`browser:${workspace}:fixed-auth`, async () => {
      await db.transaction(tx => assignment(tx, 'fixed-auth'));
      await client`insert into pat_user (id,name,email,email_verified) values (${owner},'Browser pool regression',${`${owner}@example.test`},false) on conflict(id) do update set email=excluded.email,email_verified=excluded.email_verified`;
      await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, owner));
      await assertBrowserLock();
      const [locks] = await app.sql`select count(*)::int as n from pg_locks l join pg_stat_activity a using(pid) where a.application_name='syna-browser-lock' and l.relation in ('pat_user'::regclass,'pat_browser_assignments'::regclass)`;
      assert.equal(locks.n, 0, 'Lock-only transaction may not touch user or assignment relations');
    }));
  });
  await check('two independent browser sections and nested admissions complete with ordinary pool max2', async () => {
    const entered = deferred(); let count = 0;
    await timeout(Promise.all(['fixed-one', 'fixed-two'].map(agent => manager.run(`browser:${workspace}:${agent}`, async () => {
      await db.transaction(tx => assignment(tx, agent)); if (++count === 2) entered.resolve(); await entered.promise;
      const rows = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, owner)); assert.equal(rows.length, 1); await assertBrowserLock();
    }))));
  });
  await check('separate manager connection serializes the same key; wait is finite and performs zero callback effects', async () => {
    const second = createBrowserLockManager(client, { waitMs: 100, operationMs: 3000 }), entered = deferred(), release = deferred();
    const first = manager.run(`browser:${workspace}:same-key`, async () => { entered.resolve(); await release.promise; }); await entered.promise;
    let effects = 0;
    try { await assert.rejects(second.run(`browser:${workspace}:same-key`, async () => { effects++; }), error => error.statusCode === 503); assert.equal(effects, 0); }
    finally { release.resolve(); await first; }
    await second.run(`browser:${workspace}:same-key`, async () => { effects++; }); assert.equal(effects, 1);
  });
  await check('a separate Node process cannot enter the same browser section until the PostgreSQL lock is released', async () => {
    const key = `browser:${workspace}:separate-process`, entered = deferred(), release = deferred();
    const first = manager.run(key, async () => { entered.resolve(); await release.promise; }); await entered.promise;
    try { assert.deepEqual(await childLock(key), [{ state: 'rejected', status: 503 }]); }
    finally { release.resolve(); await first; }
    assert.deepEqual(await childLock(key), [{ state: 'acquired' }, { state: 'completed' }]);
  });
  await check('an ordinary rejected browser action retains its original reason when its lock is still held', async () => {
    const original = new Error('Explicit test permission refusal');
    await assert.rejects(manager.run(`browser:${workspace}:permission`, async () => { throw original; }), error => error === original);
  });
  await check('lock connection termination aborts context and prevents subsequent effects; cleanup releases exact lock', async () => {
    const key = `browser:${workspace}:lost`, entered = deferred(), release = deferred(); let effects = 0, aborted = false;
    const operation = manager.run(key, async () => { browserLockSignal().addEventListener('abort', () => { aborted = true; }); entered.resolve(); await release.promise; await assertBrowserLock(); effects++; });
    const rejection = assert.rejects(operation, error => error.statusCode === 409); await entered.promise;
    const [owned] = await app.sql`select a.pid from pg_stat_activity a join pg_locks l using(pid) where a.application_name='syna-browser-lock' and l.locktype='advisory'
      and l.classid::bigint=((hashtextextended(${key},0)>>32)&4294967295) and l.objid::bigint=(hashtextextended(${key},0)&4294967295) and l.granted`;
    assert.ok(owned); await app.sql`select pg_terminate_backend(${owned.pid})`; await rejection;
    release.resolve(); await delay(20); assert.equal(aborted, true); assert.equal(effects, 0);
    await manager.run(key, async () => { await assertBrowserLock(); });
  });
  await check('capacity and execution deadlines remain bounded without claiming already-sent effects were undone', async () => {
    const short = createBrowserLockManager(client, { capacity: 1, waitMs: 100, operationMs: 75 }), entered = deferred(), release = deferred();
    const operation = short.run(`browser:${workspace}:deadline`, async () => { entered.resolve(); await release.promise; await assertBrowserLock(); });
    const rejection = assert.rejects(operation, error => error.statusCode === 409); await entered.promise;
    await assert.rejects(short.run(`browser:${workspace}:capacity`, async () => { throw new Error('must not run'); }), error => error.statusCode === 503);
    await rejection; release.resolve(); await delay(10);
  });
  await check('a blackholed PostgreSQL socket cannot hold the expiry path waiting for its in-flight heartbeat', async () => {
    let blackhole = false; const sockets = new Set();
    const proxy = createServer({ allowHalfOpen: true }, downstream => {
      const upstream = createConnection({ host: client.options.host[0], port: client.options.port[0] });
      sockets.add(downstream); sockets.add(upstream);
      downstream.on('data', data => { if (!blackhole) upstream.write(data); });
      upstream.on('data', data => { if (!blackhole) downstream.write(data); });
      downstream.on('error', () => {}); upstream.on('error', () => {});
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const source = postgres(process.env.DATABASE_URL, { host: '127.0.0.1', port: proxy.address().port, max: 1, prepare: false });
    const bounded = createBrowserLockManager(source, { capacity: 1, waitMs: 500, operationMs: 1250 });
    const release = deferred(); let continued = false;
    try {
      const started = Date.now();
      await assert.rejects(timeout(bounded.run(`browser:${workspace}:blackhole`, async () => {
        blackhole = true; await release.promise; await assertBrowserLock(); continued = true;
      }), 3000), error => error.statusCode === 409);
      assert.ok(Date.now() - started < 2500, 'Heartbeat must not hold an expired lock client indefinitely');
      release.resolve(); await delay(20); assert.equal(continued, false);
      blackhole = false;
      await bounded.run(`browser:${workspace}:after-blackhole`, async () => { await assertBrowserLock(); });
    } finally {
      release.resolve(); for (const socket of sockets) socket.destroy();
      await source.end({ timeout: 0 }); await new Promise(resolve => proxy.close(resolve));
    }
  });
  await check('new lock connections ignore a conflicting ambient DB URL and use the already bound client', async () => {
    const previous = process.env.DATABASE_URL, previousPg = process.env.PGDATABASE;
    process.env.DATABASE_URL = 'postgres://must-not-read@203.0.113.10:5432/untrusted'; process.env.PGDATABASE = 'must-not-read';
    try { await manager.run(`browser:${workspace}:bound-client`, async () => { await assertBrowserLock(); }); }
    finally { process.env.DATABASE_URL = previous; if (previousPg === undefined) delete process.env.PGDATABASE; else process.env.PGDATABASE = previousPg; }
  });
  await check('authored browserAction commits an empty assignment and returns without external browser work', async () => {
    const { browserAction } = await import('../server/utils/browser.ts');
    const result = await timeout(Promise.all(['view-one', 'view-two'].map(agent => browserAction(owner, thread, { action: 'inspect' }, agent))));
    assert.ok(result.every(r => r.status === 'closed'));
  });
  await check('an assignment UPDATE blocked on a row lock rolls back after browser-lock loss; a new owner waits for consistent state', async () => {
    const { controlBrowser } = await import('../server/utils/browser.ts');
    const rowId = randomUUID(), sessionId = randomUUID(), key = `browser:${workspace}:${thread}:fenced-patch`;
    await db.insert(schema.browserAssignments).values({ id: rowId, userId: owner, workspaceId: workspace, threadId: thread, agentId: 'fenced-patch',
      sessionId, projectId: 'self-hosted-v1', connectUrl: 'ws://fixture.invalid', liveUrl: 'https://fixture.invalid', expiresAt: new Date(Date.now() + 60000) });
    const previousFetch = globalThis.fetch, entered = deferred(), remoteReply = deferred(), rowEntered = deferred(), rowRelease = deferred();
    globalThis.fetch = async (url, options) => {
      assert.equal(url, `${process.env.BROWSER_SERVICE_URL}/sessions/${sessionId}/human?scoped=1`);
      assert.equal(options.method, 'POST'); entered.resolve(); await remoteReply.promise; return Response.json({});
    };
    let blocker, next;
    try {
      const request = controlBrowser(owner, thread, 'human', sessionId);
      const rejected = assert.rejects(request, error => error.statusCode === 409); await entered.promise;
      blocker = app.db.transaction(async tx => { await tx.execute(sql`select id from pat_browser_assignments where id=${rowId} for update`); rowEntered.resolve(); await rowRelease.promise; });
      await rowEntered.promise; remoteReply.resolve();
      let updateBlocked = false;
      for (let i = 0; i < 100; i++) {
        const [row] = await app.sql`select count(*)::int n from pg_stat_activity where application_name=${`browser-pool-proof-${owner}`} and query ilike 'update "pat_browser_assignments"%' and cardinality(pg_blocking_pids(pid))>0`;
        if (row.n) { updateBlocked = true; break; } await delay(10);
      }
      assert.equal(updateBlocked, true, 'The actual assignment UPDATE must be blocked before terminating its browser lock');
      const [lock] = await app.sql`select a.pid from pg_stat_activity a join pg_locks l using(pid) where a.application_name='syna-browser-lock' and l.locktype='advisory'
        and l.classid::bigint=((hashtextextended(${key},0)>>32)&4294967295) and l.objid::bigint=(hashtextextended(${key},0)&4294967295) and l.granted`;
      assert.ok(lock); await app.sql`select pg_terminate_backend(${lock.pid})`; await rejected;
      let nextDone = false; next = controlBrowser(owner, thread, 'heartbeat', sessionId).then(value => { nextDone = true; return value; });
      await delay(75); assert.equal(nextDone, false, 'The new browser owner may not read the assignment before the pending row transaction resolves');
      rowRelease.resolve(); await blocker; await timeout(next);
      const [saved] = await db.select().from(schema.browserAssignments).where(eq(schema.browserAssignments.id, rowId));
      assert.equal(saved.control, 'agent');
    } finally { remoteReply.resolve(); rowRelease.resolve(); if (blocker) await blocker; if (next) await next; globalThis.fetch = previousFetch; }
  });
} finally {
  await Promise.allSettled(pending); await db.delete(schema.user).where(eq(schema.user.id, owner)); await client.end(); await app.close();
}
console.log(JSON.stringify({ passed: checks.length, checks, poolMax: 2, database: 'actual isolated PostgreSQL', physicalActions: 0 }));
