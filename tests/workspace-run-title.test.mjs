import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';

// Real source, schema, Drizzle expression and Eve instruction definition.
// Only the database execution port and internal HTTP response are synthetic.
const state = { queries: [], runs: [] };
globalThis.workspaceTitleFixture = state;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/server/utils/workspace-context.ts')) {
    if (specifier === '@nuxthub/db') return { url: 'data:text/javascript,export const db = globalThis.workspaceTitleFixture.db; export const schema = globalThis.workspaceTitleFixture.schema;', shortCircuit: true };
    if (specifier === './threads') return { url: 'data:text/javascript,export const getThreadForUser = async (user,id) => user === "owner" && id === "thread" ? {id,workspaceId:"workspace"} : null;', shortCircuit: true };
    if (specifier === './workspaces') return { url: 'data:text/javascript,export const requireWorkspace = async () => ({id:"workspace",name:"Synthetic workspace"});', shortCircuit: true };
  }
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
state.schema = {};
for (const file of readdirSync(resolve('server/db/schema')).filter(name => name.endsWith('.ts'))) {
  Object.assign(state.schema, await import(pathToFileURL(resolve('server/db/schema', file)).href));
}
state.db = { select(fields) {
  const query = { fields };
  const chain = {
    from(table) { query.table = table; return chain; },
    where(condition) { query.condition = condition; return chain; },
    orderBy(...order) { query.order = order; return chain; },
    limit(limit) { query.limit = limit; return chain; },
    then(resolve) {
      state.queries.push(query);
      return Promise.resolve(query.table === state.schema.testRuns ? state.runs : []).then(resolve);
    },
  };
  return chain;
} };
const previousCreateError = globalThis.createError;
globalThis.createError = value => Object.assign(new Error(value.statusMessage), value);
const { workspaceContext } = await import(pathToFileURL(resolve('server/utils/workspace-context.ts')).href);
const instruction = (await import(pathToFileURL(resolve('agent/instructions/workspace-context.ts')).href)).default;
after(() => { hooks.deregister(); delete globalThis.workspaceTitleFixture; globalThis.createError = previousCreateError; });

test('index selects bounded immutable snapshot title, not current plan or result prose', async () => {
  state.queries.length = 0;
  await workspaceContext('owner', 'thread');
  const query = state.queries.find(q => q.table === state.schema.testRuns);
  assert.ok(query.fields.snapshotTitle, 'Frozen run title is necessary for title-based source selection');
  const sql = new PgDialect().sqlToQuery(query.fields.snapshotTitle).sql;
  assert.match(sql, /"pat_test_runs"\."snapshot"/);
  assert.match(sql, /jsonb_typeof/);
  assert.match(sql, /between 1 and 300/);
  assert.doesNotMatch(sql, /pat_workspace_items|result/);
  assert.equal(query.limit, 11);
  assert.deepEqual(Object.keys(query.fields).sort(), ['id', 'itemId', 'caseId', 'planVersion', 'snapshotTitle', 'reportedOutcome', 'startedAt', 'finishedAt'].sort());
});

test('duplicate and unresolved titles preserve separate canonical run IDs without selecting one', async () => {
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  state.runs = ids.map((id, i) => ({ id, snapshotTitle: i === 2 ? null : 'Same frozen title', itemId: 'plan', caseId: `case-${i}`, planVersion: i + 1 }));
  const before = structuredClone(state.runs);
  const result = await workspaceContext('owner', 'thread');
  assert.deepEqual(result.recentTestRuns.map(run => run.snapshotTitle), ['Same frozen title', 'Same frozen title', null]);
  assert.deepEqual(result.recentTestRuns.map(run => run.reportSource), ids.map(id => ({ type: 'test', id })));
  assert.deepEqual(state.runs, before);
  assert.equal(result.testRunsTruncated, false);
});

test('actual Eve dynamic instruction keeps application data untrusted and requires ambiguity resolution', async () => {
  const previousFetch = globalThis.fetch;
  const oldUrl = process.env.APP_URL, oldSecret = process.env.INTERNAL_API_SECRET;
  process.env.APP_URL = 'http://127.0.0.1:12345';
  process.env.INTERNAL_API_SECRET = 'synthetic-test-secret';
  const context = await workspaceContext('owner', 'thread');
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests++;
    assert.equal(url, 'http://127.0.0.1:12345/api/internal/workspace-context');
    assert.deepEqual(JSON.parse(options.body), { userId: 'owner', threadId: 'thread' });
    return Response.json(context);
  };
  try {
    const result = await instruction.events['turn.started']({}, { session: { auth: { current: { authenticator: 'app', principalId: 'owner', attributes: { browserThreadId: 'thread' } } } } });
    assert.equal(result.role, 'user');
    assert.ok(result.content.endsWith(JSON.stringify(context)));
    for (const phrase of ['untrusted data', 'snapshotTitle', 'frozen case title', 'Titles are not unique', 'read test_run list', 'Never infer a title-to-run mapping', 'ask one focused clarification', 'not independent verification']) assert.ok(result.content.includes(phrase), phrase);
    assert.equal(requests, 1);
    assert.equal(await instruction.events['turn.started']({}, { session: { auth: { current: null } } }), null);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of [['APP_URL', oldUrl], ['INTERNAL_API_SECRET', oldSecret]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('unowned thread remains denied before a database read', async () => {
  state.queries.length = 0;
  await assert.rejects(workspaceContext('other', 'thread'), error => error.statusCode === 404);
  assert.equal(state.queries.length, 0);
});
