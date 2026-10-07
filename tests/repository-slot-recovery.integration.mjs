// Real isolated PostgreSQL/controller and runner persistence; Docker/network are synthetic.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { Runner } from '../infra/repo-runner/runner.mjs';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

const h = await controllerFixture(), { db, schema } = h;
const directory = await mkdtemp(join(tmpdir(), 'slot-recovery-'));
const runner = new Runner({ directory, execute: async args => { assert.equal(args[0], 'rm'); return { code: 0, output: '' }; } });
await runner.init();
let compatible = false, unavailable = false, mismatched = false, starts = 0;
process.env.REPO_RUNNER_URL = 'https://runner.fixture.invalid'; process.env.REPO_RUNNER_KEY = 'fixture';
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname;
  if (path === '/health') return Response.json(compatible ? { autonomousExecution: { version: 1, admission: true, frozenCommit: true } } : {});
  if (unavailable) throw new Error('transport unavailable');
  if (path === '/jobs' && options.method === 'GET') return Response.json({ jobs: [] });
  if (path.endsWith('/cancel-unsubmitted')) {
    const job = await runner.cancelUnsubmitted(JSON.parse(options.body));
    return Response.json(mismatched ? { ...job, fingerprint: '0'.repeat(64) } : job);
  }
  if (path === '/jobs') { starts++; throw new Error('Lost before runner admission'); }
  throw new Error(`Unexpected call ${path}`);
};
const target = { kind: 'repository', url: 'https://github.com/example/repo', ref: '', surface: 'checks' };
try {
  const unsupported = await h.fixture({ target }); await h.pass(unsupported);
  let state = await h.state(unsupported);
  assert.equal(state.attempts[0].status, 'failed'); assert.equal(state.tasks[0].state, 'blocked');
  assert.match(state.attempts[0].error, /Körservern behöver uppdateras/);
  assert.equal(state.claims.length, 0); assert.equal(starts, 0);
  assert.equal(await h.row(schema.repositoryRuns, state.attempts[0].dispatchId), undefined);

  compatible = true;
  const old = await h.fixture({ target }); await h.pass(old);
  state = await h.state(old); const attempt = state.attempts[0];
  assert.equal(attempt.status, 'dispatch_unknown'); assert.equal(state.claims.length, 1);
  await db.update(schema.missionAttempts).set({ status: 'failed', finishedAt: new Date() }).where(eq(schema.missionAttempts.id, attempt.id));
  await db.update(schema.missions).set({ lifecycle: 'closed', status: 'closed', closureReason: 'blocked', closedAt: new Date() }).where(eq(schema.missions.id, old.id));
  const next = await h.fixture({ target }); await h.pass(next);
  state = await h.state(next); assert.equal(state.attempts.length, 0); assert.equal(state.tasks[0].blockedReason, 'resource_busy');
  const { readMissionPresentation } = await import('../server/utils/mission-presentation.ts');
  assert.equal((await readMissionPresentation(h.owner, next.workspace, next.id)).nextStep.code, 'resource_wait');

  unavailable = true; await h.reconcileClosedMissionResources();
  assert.equal((await h.state(old)).claims.length, 1, 'Network failure must retain the claim');
  unavailable = false; mismatched = true; await h.reconcileClosedMissionResources();
  assert.equal((await h.state(old)).claims.length, 1, 'Wrong binding must retain the claim');
  mismatched = false; await h.reconcileClosedMissionResources();
  assert.equal((await h.state(old)).claims.length, 0);
  const saved = await h.row(schema.repositoryRuns, attempt.dispatchId);
  assert.equal(saved.job.status, 'cancelled'); assert.equal(saved.job.cleanup.confirmed, true);
  assert.equal((await runner.submit({ id: saved.id, ...saved.config })).status, 'cancelled');
  await h.pass(next); state = await h.state(next);
  assert.equal(state.attempts.length, 1); assert.equal(state.tasks[0].blockedReason, null);
  console.log('PASS: protocol preflight, queued projection, unavailable/mismatched cleanup, durable cancellation, slot release and next admission. No real Docker or model execution.');
} finally { await h.close(); await rm(directory, { recursive: true, force: true }); }
