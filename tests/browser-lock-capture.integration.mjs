import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { eq } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Actual PostgreSQL lock termination and capture/file persistence; the page is
// synthetic. Only exact lock connections and rows created here are affected.
process.env.PAT_RUNTIME_SCOPE += `-capture-lock-${randomUUID()}`;
const app = await isolatedApp(), { db, schema } = app;
const { createBrowserLockManager, browserLockSignal } = await import('../server/utils/browser-lock.ts');
const { saveItem, saveFile } = await import('../server/utils/workspaces.ts');
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const userId = randomUUID(), workspaceId = randomUUID(), threadId = randomUUID(), paths = [], savedItems = [], checks = [];
const target = { environment: 'Synthetic capture lock proof', url: 'https://example.test/', revision: 'v1' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=', 'base64');
const manager = createBrowserLockManager(app.sql, { waitMs: 500, operationMs: 3000 });
let currentKey, loseAfterWrite = false;
async function loseLock() {
  const [row] = await app.sql`select a.pid from pg_stat_activity a join pg_locks l using(pid) where a.application_name='syna-browser-lock' and l.locktype='advisory'
    and l.classid::bigint=((hashtextextended(${currentKey},0)>>32)&4294967295) and l.objid::bigint=(hashtextextended(${currentKey},0)&4294967295) and l.granted`;
  assert.ok(row); const signal = browserLockSignal();
  const aborted = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  await app.sql`select pg_terminate_backend(${row.pid})`; await aborted;
}
globalThis.browserLockCaptureSaveFile = async (...args) => {
  const item = await saveFile(...args);
  const [stored] = await args[6].select().from(schema.workspaceItems).where(eq(schema.workspaceItems.id, item.id));
  assert.ok(stored.blobPath); paths.push(stored.blobPath); savedItems.push(item.id);
  if (loseAfterWrite) { loseAfterWrite = false; await loseLock(); }
  return item;
};
const captureUrl = new URL('../server/utils/test-captures.ts', import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === captureUrl && specifier === './workspaces') return { url: 'data:text/javascript,export const saveFile=(...args)=>globalThis.browserLockCaptureSaveFile(...args);', shortCircuit: true };
  return next(specifier, context);
} });
const { captureTestStep } = await import('../server/utils/test-captures.ts');
try {
  await db.insert(schema.user).values({ id: userId, name: 'Capture lock proof', email: `${userId}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspaceId, userId, name: 'Capture lock proof' });
  await db.insert(schema.threads).values({ id: threadId, userId, workspaceId, title: 'Capture lock proof' });
  for (const fault of ['before-persist', 'after-item-version-write']) {
    const test = { id: randomUUID(), title: fault, type: 'browser', preconditions: '', steps: 'Observe fixture', expected: 'Fixture visible' };
    const plan = await saveItem(userId, workspaceId, { title: fault, content: { kind: 'test_plan', sources: [], cases: [test] } });
    const run = await testRunAction(userId, workspaceId, threadId, { action: 'start', requestId: randomUUID(), itemId: plan.id, caseId: test.id, expectedVersion: plan.version, environment: target.environment, target });
    const itemsBefore = await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, workspaceId));
    currentKey = `browser:${workspaceId}:${fault}`; loseAfterWrite = fault === 'after-item-version-write';
    let capture;
    const operation = manager.run(currentKey, async () => {
      capture = captureTestStep(userId, workspaceId, threadId, 'click', {
        url: () => target.url, title: async () => 'Synthetic page', locator: () => ({}),
        screenshot: async () => { if (fault === 'before-persist') await loseLock(); return png; },
      }, run.id);
      capture.catch(() => {}); return capture;
    });
    await assert.rejects(operation, error => error.statusCode === 409);
    await assert.rejects(capture, error => error.statusCode === 409);
    assert.equal((await db.select().from(schema.testCaptures).where(eq(schema.testCaptures.runId, run.id))).length, 0);
    assert.deepEqual(await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, workspaceId)), itemsBefore);
    for (const id of savedItems) assert.equal((await db.select().from(schema.workspaceItemVersions).where(eq(schema.workspaceItemVersions.itemId, id))).length, 0);
    checks.push(`${fault}: lock loss denies capture and rolls back item/version writes without error-metadata retry`);
  }
  assert.equal(paths.length, 1, 'The second fault occurs after a real isolated file write');
  console.log(JSON.stringify({ passed: checks.length, checks, database: 'actual isolated PostgreSQL', storage: 'actual isolated file', physicalBrowser: false }));
} finally {
  hooks.deregister(); delete globalThis.browserLockCaptureSaveFile;
  try { for (const path of paths) await del(path, { token: workspaceStorageToken() }); }
  finally { await db.delete(schema.user).where(eq(schema.user.id, userId)); await app.close(); }
}
