// Actual API/service/SQL integration; only the external runner is substituted.
// Never reads .env and refuses non-loopback or non-test databases.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and, sql } from 'drizzle-orm';
import { createApp, createError, defineEventHandler, getRequestHeader, readBody, toNodeListener } from 'h3';
import { assertIsolatedDatabaseUrl } from './helpers/autonomy-isolation.mjs';

const databaseUrl = new URL(assertIsolatedDatabaseUrl(process.env.SYNA_TEST_DATABASE_URL));
const runtime = `repository-binding:${randomUUID()}`;
process.env.PAT_RUNTIME_SCOPE = runtime;
process.env.INTERNAL_API_SECRET = 'repository-binding-fixture-internal';
process.env.REPO_RUNNER_URL = 'http://runner.fixture.invalid';
process.env.REPO_RUNNER_KEY = 'repository-binding-fixture-runner';
process.env.MISSIONS_ENABLED = 'true';

const moduleCode = code => `data:text/javascript,${encodeURIComponent(code)}`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@nuxthub/db') return { url: moduleCode('export const db = globalThis.repositoryBindingDb; export const schema = globalThis.repositoryBindingSchema;'), shortCircuit: true };
  if (specifier.startsWith('#shared/')) return { url: new URL(`../shared/${specifier.slice(8)}.ts`, import.meta.url).href, shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const schema = {};
for (const file of readdirSync(new URL('../server/db/schema/', import.meta.url)).filter(name => name.endsWith('.ts'))) Object.assign(schema, await import(`../server/db/schema/${file}`));
const connection = postgres(databaseUrl.toString(), { prepare: false, max: 4 });
const db = drizzle(connection);
Object.assign(globalThis, { repositoryBindingDb: db, repositoryBindingSchema: schema, createError, defineEventHandler, readBody, getRequestHeader });
const { missionAction, bindMissionSource } = await import('../server/utils/missions.ts');
const { listRepositories } = await import('../server/utils/repositories.ts');
const handler = (await import('../server/api/internal/repository.post.ts')).default;
const server = createServer(toNodeListener(createApp().use('/api/internal/repository', handler)));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const originalFetch = globalThis.fetch;
const runnerJobs = new Map();
const heldRunnerJobs = new Map();
const submissions = [];
let checks = 0;
const owners = [randomUUID(), randomUUID()];
const workspaces = [randomUUID(), randomUUID()];
const threads = [randomUUID(), randomUUID()];

globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith(process.env.REPO_RUNNER_URL)) return originalFetch(url, options);
  assert.equal(options.headers.authorization, `Bearer ${process.env.REPO_RUNNER_KEY}`);
  const route = new URL(url);
  if (options.method === 'GET') return Response.json({ jobs: (route.searchParams.get('ids') ?? '').split(',').flatMap(id => runnerJobs.has(id) ? [runnerJobs.get(id)] : []) });
  assert.equal(route.pathname, '/jobs');
  const input = JSON.parse(options.body);
  submissions.push(input);
  const [saved] = await db.select().from(schema.repositoryRuns).where(eq(schema.repositoryRuns.id, input.id));
  assert.ok(saved, 'Submission must be persisted before runner call');
  if (saved.missionBinding) {
    const [task] = await db.select().from(schema.missionTasks).where(eq(schema.missionTasks.id, saved.missionBinding.taskId));
    assert.ok(task.sources.some(source => source.type === 'repository' && source.id === saved.id), 'Mission binding must be attached before first dispatch or recovery');
  }
  const hold = heldRunnerJobs.get(input.id);
  if (hold) { hold.entered(); await hold.released; }
  if (!runnerJobs.has(input.id)) {
    const now = new Date().toISOString();
    runnerJobs.set(input.id, { ...input, revision: 1, status: 'review', message: 'Fixture inspected', logs: 'Fixture only', commit: 'a'.repeat(40), package: null, testExitCode: null, createdAt: now, updatedAt: now, finishedAt: now });
  }
  return Response.json(runnerJobs.get(input.id));
};
async function api(input, owner = 0, expectedStatus = 200, overrides = {}) {
  const response = await originalFetch(`${origin}/api/internal/repository`, { method: 'POST', headers: { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify({ userId: owners[owner], threadId: threads[owner], input, ...overrides }) });
  const body = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(body));
  checks++;
  return body;
}
async function createMission(owner = 0) {
  const mission = await missionAction(owners[owner], workspaces[owner], threads[owner], { action: 'create', requestId: randomUUID(), config: { title: 'Repository fixture', goal: 'Inspect fixture', scope: 'No external actions', criteria: [{ id: 'inspect', text: 'Save inspection' }], target: null, caseKeys: [], automaticReports: false } });
  const task = await missionAction(owners[owner], workspaces[owner], threads[owner], { action: 'task', missionId: mission.id, requestId: randomUUID(), task: { title: 'Inspect', actor: 'repo', criterionIds: ['inspect'], dependsOn: [] } });
  return { missionId: mission.id, taskId: task.id };
}
try {
  for (let index = 0; index < owners.length; index++) {
    await db.insert(schema.user).values({ id: owners[index], name: 'Isolated repository fixture', email: `repository-${owners[index]}@example.test` });
    await db.insert(schema.workspaces).values({ id: workspaces[index], userId: owners[index], name: 'Isolated repository fixture' });
    await db.insert(schema.threads).values({ id: threads[index], userId: owners[index], workspaceId: workspaces[index], title: 'Repository fixture' });
  }
  const repository = await api({ action: 'connect', url: 'https://github.com/fixture/repo', script: 'auto' });
  const binding = await createMission();
  const otherBinding = await createMission();
  const foreignBinding = await createMission(1);
  const otherRuntime = await createMission();
  await db.update(schema.missions).set({ runtime: `${runtime}:foreign` }).where(eq(schema.missions.id, otherRuntime.missionId));
  const start = { action: 'start', repositoryId: repository.id, requestId: randomUUID(), mode: 'inspect', mission: binding };
  const before = submissions.length;
  for (const [mission, status] of [['{', 400], [{ ...binding, taskId: randomUUID() }, 409], [{ ...binding, taskId: otherBinding.taskId }, 409], [foreignBinding, 404], [otherRuntime, 404]]) await api({ ...start, requestId: randomUUID(), mission }, 0, status);
  await api(start, 1, 404, { threadId: threads[0] });
  assert.equal(submissions.length, before, 'Scope and JSON failures never dispatch');
  assert.equal((await db.select().from(schema.repositoryRuns)).filter(row => row.workspaceId === workspaces[0]).length, 0, 'Rejected input leaves no recoverable submission');

  const started = await api({ ...start, mission: JSON.stringify(binding) });
  const [saved] = await db.select().from(schema.repositoryRuns).where(eq(schema.repositoryRuns.id, started.id));
  assert.deepEqual(saved.missionBinding, binding);
  assert.equal(saved.runtime, runtime);
  assert.equal(saved.bindingVersion, 1);
  const repeat = await api(start);
  assert.equal(repeat.id, started.id);
  assert.equal(submissions.length, before + 1, 'Completed replay does not redispatch');
  await api({ ...start, mission: otherBinding }, 0, 409);
  await api({ ...start, mission: undefined }, 0, 409);
  // A report may explicitly reuse a historical source without rewriting its owner.
  await missionAction(owners[0], workspaces[0], threads[0], { action: 'attach', ...otherBinding, sourceType: 'repository', sourceId: started.id });
  assert.deepEqual((await db.select().from(schema.repositoryRuns).where(eq(schema.repositoryRuns.id, started.id)))[0].missionBinding, binding);
  await db.update(schema.missions).set({ status: 'closed' }).where(eq(schema.missions.id, binding.missionId));
  assert.equal((await api(start)).id, started.id, 'A closed mission still permits receipt readback');
  await api({ ...start, requestId: randomUUID() }, 0, 409);
  const adHocInput = { ...start, requestId: randomUUID(), mission: undefined };
  const adHoc = await api(adHocInput);
  assert.equal((await db.select().from(schema.repositoryRuns).where(eq(schema.repositoryRuns.id, adHoc.id)))[0].missionBinding, null);
  await api({ ...adHocInput, mission: otherBinding }, 0, 409);

  const recoveryBinding = await createMission();
  const interruptedId = randomUUID();
  await db.insert(schema.repositoryRuns).values({ id: interruptedId, runtime, bindingVersion: 1, workspaceId: workspaces[0], repositoryId: repository.id, requestId: randomUUID(), missionBinding: recoveryBinding, config: saved.config });
  const recovery = await listRepositories(owners[0], workspaces[0]);
  assert.equal(recovery.syncError, undefined);
  assert.equal(recovery.runs.find(run => run.id === interruptedId).job.status, 'review');
  assert.ok(runnerJobs.has(interruptedId), 'Interrupted insert-before-attach is safely recovered');

  const foreignId = randomUUID();
  await db.insert(schema.repositoryRuns).values({ id: foreignId, runtime: `${runtime}:foreign`, bindingVersion: 1, workspaceId: workspaces[0], repositoryId: repository.id, requestId: randomUUID(), config: saved.config });
  await listRepositories(owners[0], workspaces[0]);
  assert.equal(runnerJobs.has(foreignId), false, 'Status reading does not start work from another runtime');
  await api({ action: 'cancel', runId: foreignId }, 0, 409);
  const invalidId = randomUUID();
  await db.insert(schema.repositoryRuns).values({ id: invalidId, runtime, bindingVersion: 1, workspaceId: workspaces[0], repositoryId: repository.id, requestId: randomUUID(), missionBinding: { ...recoveryBinding, taskId: randomUUID() }, config: saved.config });
  assert.ok((await listRepositories(owners[0], workspaces[0])).syncError);
  assert.equal(runnerJobs.has(invalidId), false, 'An invalid interrupted binding cannot be recovered as ad hoc work');
  const legacyId = randomUUID();
  await db.insert(schema.repositoryRuns).values({ id: legacyId, runtime, workspaceId: workspaces[0], repositoryId: repository.id, requestId: randomUUID(), config: saved.config });
  await listRepositories(owners[0], workspaces[0]);
  assert.equal(runnerJobs.has(legacyId), false, 'Unknown pre-migration binding is not treated as authorized ad hoc work');
  const parallelBinding = await createMission();
  const parallelId = randomUUID();
  await db.insert(schema.repositoryRuns).values({ id: parallelId, runtime, bindingVersion: 1, workspaceId: workspaces[0], repositoryId: repository.id, requestId: randomUUID(), missionBinding: parallelBinding, config: saved.config });
  let entered, release;
  const runnerEntered = new Promise(resolve => { entered = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  heldRunnerJobs.set(parallelId, { entered, released });
  let recoveryReturned = false;
  const parallelRecovery = listRepositories(owners[0], workspaces[0]).then(value => { recoveryReturned = true; return value; });
  await runnerEntered;
  try { assert.equal(recoveryReturned, false, 'A rejected legacy recovery must not return while valid sibling dispatch is in flight'); }
  finally { release(); }
  const parallelResult = await parallelRecovery;
  assert.ok(parallelResult.syncError);
  assert.equal(parallelResult.runs.find(run => run.id === parallelId).job.status, 'review');

  // Hold the same lock as a closure transaction, then let a competing execution
  // attachment proceed only after closure committed. The actual service must
  // reject it inside that lock, not rely solely on earlier validation.
  const raceBinding = await createMission();
  const raceId = randomUUID();
  await db.insert(schema.repositoryRuns).values({ id: raceId, runtime, bindingVersion: 1, workspaceId: workspaces[0], repositoryId: repository.id, requestId: randomUUID(), missionBinding: raceBinding, config: saved.config });
  let competing;
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mission:${raceBinding.missionId}`}, 0))`);
    competing = bindMissionSource(owners[0], workspaces[0], threads[0], raceBinding, 'repository', raceId).then(() => ({ accepted: true }), error => ({ statusCode: error.statusCode }));
    await tx.update(schema.missions).set({ status: 'closed' }).where(eq(schema.missions.id, raceBinding.missionId));
  });
  assert.deepEqual(await competing, { statusCode: 409 });
  assert.equal((await db.select().from(schema.missionTasks).where(eq(schema.missionTasks.id, raceBinding.taskId)))[0].sources.length, 0);
  const pendingBinding = await createMission();
  const pendingId = randomUUID();
  await db.insert(schema.repositoryRuns).values({ id: pendingId, runtime, bindingVersion: 1, workspaceId: workspaces[0], repositoryId: repository.id, requestId: randomUUID(), missionBinding: pendingBinding, config: saved.config });
  await bindMissionSource(owners[0], workspaces[0], threads[0], pendingBinding, 'repository', pendingId);
  const [pendingMission] = await db.select().from(schema.missions).where(eq(schema.missions.id, pendingBinding.missionId));
  await assert.rejects(missionAction(owners[0], workspaces[0], threads[0], { action: 'update', missionId: pendingMission.id, expectedRevision: pendingMission.revision, config: pendingMission.config, status: 'closed', reason: 'Closure race fixture' }), error => error.statusCode === 409);
  assert.equal((await db.select().from(schema.repositoryRuns).where(and(eq(schema.repositoryRuns.workspaceId, workspaces[0]), eq(schema.repositoryRuns.requestId, start.requestId)))).length, 1);
  console.log(JSON.stringify({ status: 'passed', checks, logicalRunnerJobs: runnerJobs.size, actualApi: true, actualPostgreSQL: true, externalRunner: 'deterministic fixture', scenarios: ['schema/JSON', 'owner/workspace/runtime/task boundaries', 'immutable replay', 'receipt after closure', 'ad hoc', 'explicit historical report reuse', 'interrupted binding recovery', 'foreign-runtime/invalid/legacy recovery denial', 'mixed recovery waits for siblings', 'closure and execution attachment serialization'] }));
} finally {
  globalThis.fetch = originalFetch;
  for (const owner of owners) await db.delete(schema.user).where(eq(schema.user.id, owner));
  await connection.end();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  hooks.deregister();
}
