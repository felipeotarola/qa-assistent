import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setTimeout as delay } from 'node:timers/promises';
import { missionEnvironmentExecution, environmentPlanHash, environmentRequestFingerprint } from '../shared/mission-environment.mjs';
import { EnvironmentManager } from '../infra/codex-worker/environment.mjs';
import { CodexWorker } from '../infra/codex-worker/worker.mjs';

import { executionHash } from '../infra/execution/admission.mjs';

const execution = () => ({ version: 1, runtime: 'unit:environment', missionId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), dispatchId: randomUUID(), mandateRevision: 1, planRevision: 1, requestHash: 'a'.repeat(64), deadlineAt: new Date(Date.now() + 60000).toISOString() });
const executionProfile = () => ({ version: 1, runtime: 'node24', imageDigest: `sha256:${'1'.repeat(64)}`, packageManager: 'npm', packageManagerVersion: '11.5.0', installDirectory: '/workspace/repository', lockfile: 'package-lock.json', lockfileSha256: '2'.repeat(64), ignoreScripts: true });
const plan = () => ({ version: 1, repoUrl: 'https://github.com/example/project', root: '/workspace/repository', directory: '/workspace/repository', commit: 'a'.repeat(40), command: 'npm --ignore-scripts run dev -- --host 0.0.0.0', port: 3000, variables: [{ name: 'PUBLIC_TEST_KEY', required: true }], executionProfile: executionProfile() });
const prepare = () => ({ version: 1, phase: 'prepare', repoUrl: plan().repoUrl, commit: plan().commit, inspectedRunId: randomUUID() });
const apply = () => { const value = plan(); return { version: 1, phase: 'apply', sourceSetupJobId: randomUUID(), plan: value, planHash: environmentPlanHash(value), consent: { id: randomUUID(), revision: 1, vaultRevision: 1 } }; };
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'syna-mission-environment-'));
  const binding = execution(), spec = options.prepare ? prepare() : apply();
  if (options.approved) { const value = plan(); spec.approvedPlan = { plan: value, planHash: environmentPlanHash(value) }; }
  const input = { action: 'start', id: randomUUID(), owner: 'b'.repeat(64), workspaceId: randomUUID(), userId: randomUUID(), jobId: binding.dispatchId, task: 'Prepare this application for QA', execution: binding, environmentExecution: spec };
  const state = { id: input.id, owner: input.owner, workspaceId: input.workspaceId, execution: binding, status: 'ready', processes: [], containerCreated: true }, calls = [], admissions = [], requests = [];
  let lock = Promise.resolve(), constructors = 0;
  const sandboxes = { leaseMs: 300000, sessions: new Map([[state.id, state]]),
    owned(id, owner) { const value = this.sessions.get(id); if (!value || value.owner !== owner) throw Error('Not found'); return value; },
    serial(_id, fn) { const pending = lock.catch(() => {}).then(fn); lock = pending; return pending; },
    async save() {},
    async close(value, status) {
      assert.equal(status, 'deleted');
      calls.push({ args: ['close', value.id] }); value.status = status; value.containerCreated = false;
      return { resourceId: value.id, executionHash: executionHash(value.execution), confirmed: true };
    },
    async execute(args, stdin) {
      calls.push({ args, stdin });
      if (options.execute) { const result = await options.execute(args, stdin); if (result !== undefined) return result; }
      if (args[0] === 'inspect') return executionProfile().imageDigest;
      if (args.some(value => String(value).includes('function inspectMissionProfile'))) { const profile = executionProfile(); delete profile.imageDigest; return JSON.stringify(profile); }
      const script = args.find(value => typeof value === 'string' && value.includes('projects'));
      if (script) return JSON.stringify({ projects: [{ directory: '.', kind: 'node', scripts: { dev: 'node app.mjs' }, lock: true, engines: {}, packageManager: null }] });
      if (args.some(value => String(value).includes('function healthInside'))) return '{"httpStatus":200}';
      return '{}';
    },
  };
  const secretValue = 'SYNTHETIC_TEST_VALUE_NOT_A_REAL_KEY';
  const manager = new EnvironmentManager({ sandboxes, directory: join(directory, 'redaction'), key: 'test-key', appUrl: 'http://127.0.0.1:1', secret: 'local-key-'.repeat(4), fetch: async (url, request) => {
    requests.push({ url: String(url), request });
    if (options.release) return options.release(url, request);
    return new Response(JSON.stringify({ values: { PUBLIC_TEST_KEY: secretValue }, releaseId: randomUUID(), validUntil: binding.deadlineAt }));
  } }); await manager.init();
  const clients = [];
  class Client {
    constructor(options) { constructors++; this.options = options; clients.push(this); }
    async initialize() {}
    async request(method) { return method === 'thread/start' ? { thread: { id: 'synthetic-thread' } } : {}; }
    async close() { this.stopReceipt = { mechanism: 'synthetic', scopeId: 'test', empty: true, observedAt: new Date().toISOString() }; }
  }
  const worker = new CodexWorker({ directory: join(directory, 'jobs'), sandboxes, environments: manager, Client, accessMode: 'shared', inspectionCommand: 'inspect', admission: { admit: async value => { admissions.push(value); if (options.deny?.(value)) throw Error('Revoked'); return {}; } } }); await worker.init();
  if (!options.prepare) {
    const source = { id: randomUUID(), jobId: spec.sourceSetupJobId, owner: 'c'.repeat(64), userId: input.userId, workspaceId: input.workspaceId, status: 'needs_configuration', execution: binding, environmentExecution: prepare(), environment: { ...spec.plan, variables: spec.plan.variables.map(v => ({ ...v, reason: 'Needed' })) }, cleanup: 'confirmed', executorStopped: true };
    worker.jobs.set(spec.sourceSetupJobId, source); sandboxes.sessions.set(source.id, { id: source.id, owner: source.owner, workspaceId: source.workspaceId, execution: binding, status: 'stopped', processes: [] });
  }
  t.after(async () => { await worker.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, worker, manager, input, state, calls, admissions, requests, secretValue, clients, constructors: () => constructors };
}
async function finished(worker, jobId) {
  for (let i = 0; i < 200; i++) { const job = worker.jobs.get(jobId); if (job && !worker.active.has(jobId)) return job; await delay(5); }
  throw Error('Synthetic worker did not settle');
}

export { fixture, finished, plan, executionProfile, prepare, apply, execution, missionEnvironmentExecution, environmentPlanHash, environmentRequestFingerprint };
