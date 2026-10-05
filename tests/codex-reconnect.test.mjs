import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { missionBindingSchema } from '../shared/mission-binding.ts';

function load(path, dependencies, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, Error, AbortSignal, ...globals, require: name => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  return exports.default;
}

function toolFixture(probeError) {
  const calls = [], probes = [];
  let key = 'expired-generation';
  const tool = load('../agent/tools/codex.ts', {
    'eve/tools': { defineTool: value => value }, zod: { z },
    '../../shared/mission-binding': { missionBindingSchema },
    '../lib/internal-api': { appOrigin: () => 'https://app.example', internalHeaders: () => ({}) },
    '../../shared/repository-request.mjs': { repositoryRequestId: () => 'stable-submission' },
    '../lib/codex-turn': { codexTurn: { update() {} } },
    '../../shared/codex-handoff.mjs': { isCodexBackground: () => true },
    '../../shared/repository-map': { repositoryMapTask: (_url, task) => task },
  }, { fetch: async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ status: 'starting' }) };
  } });
  const ctx = {
    callId: 'call', abortSignal: new AbortController().signal,
    session: { id: 'parent', turn: { id: 'turn' }, auth: { current: { authenticator: 'app', principalId: 'user', attributes: { browserThreadId: 'thread' } } } },
    async getSandbox() {
      // Mirrors Eve's wrapper: id is copied, not a live getter.
      return { id: key, async run(options) {
        probes.push(options.command);
        if (probeError) throw new Error(probeError);
        key = 'live-successor';
        return { exitCode: 0, stdout: '[The previous VPS environment expired. This is a NEW empty environment; old files and processes were not restored.]\n' };
      } };
    },
  };
  return { tool, ctx, calls, probes };
}

test('Otto start probes readiness and hands off the new generation, once', async () => {
  const { tool, ctx, calls, probes } = toolFixture();
  const result = await tool.execute({ action: 'start', task: 'Inspect repository' }, ctx);
  assert.deepEqual(probes, ['true']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionKey, 'live-successor');
  assert.equal(calls[0].jobId, 'stable-submission');
  assert.equal(result.environmentReset, true);
});

test('failed readiness never submits or retries an Otto job', async () => {
  const { tool, ctx, calls } = toolFixture('Worker unavailable');
  await assert.rejects(tool.execute({ action: 'start', task: 'Inspect' }, ctx), /Worker unavailable/);
  assert.equal(calls.length, 0);
});

test('status and cancellation never open or restart a sandbox', async () => {
  const { tool, ctx, calls } = toolFixture();
  ctx.getSandbox = () => { throw new Error('Must not open a sandbox'); };
  for (const action of ['status', 'cancel']) await tool.execute({ action, jobId: randomUUID() }, ctx);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.sessionKey === undefined));
});

function apiFixture({ denied = false } = {}) {
  const userId = randomUUID(), threadId = randomUUID(), jobId = randomUUID(), workspaceId = randomUUID();
  const calls = [];
  const saved = { threadId: 'original-thread', sessionKey: 'original-generation' };
  const handler = load('../server/api/internal/codex.post.ts', {
    zod: { z }, '../../utils/internal-api': { requireInternalRequest() {} },
    '../../../shared/mission-binding': { missionBindingSchema },
    '../../utils/missions': { validateMissionBinding: async () => { throw new Error('Status cannot change mission'); }, bindMissionSource: async () => { throw new Error('Status cannot bind a mission'); } },
    '../../utils/threads': { getThreadForUser: async () => ({ workspaceId }) },
    '../../utils/sandbox-scope': { sandboxScope: (user, thread, key) => ({ id: `${thread}:${key}`, owner: user }) },
    '../../utils/repositories': { repositoryRunner: async (_path, body) => { calls.push(body); return { status: 'completed' }; } },
    '@nuxthub/db': { db: { select: () => ({ from: () => ({ where: async () => [saved] }) }) }, schema: { setupJobs: { id: 'id' } } },
    'drizzle-orm': { eq() {} }, '../../../shared/runtime-scope': { runtimeScope: () => 'production' },
    '../../../shared/chat-models': {},
    '../../utils/setup-jobs': { ownedSetup: async (user, workspace, job) => {
      assert.equal(user, userId); assert.equal(workspace, workspaceId); assert.equal(job, jobId);
      if (denied) throw new Error('Job not found');
      return saved;
    }, receiveSetupResult: async () => {} },
    '../../../shared/repository-map': {},
    '../../utils/project-vault': { listVaultEntries: async () => { throw new Error('Historical status must not inspect credentials'); } },
  }, { defineEventHandler: fn => fn, readBody: async body => body, createError: options => new Error(options.statusMessage) });
  return { handler, calls, body: { userId, threadId, jobId, action: 'status', sessionKey: 'new-generation' } };
}

test('historical status uses the authorized saved job scope, not the current sandbox', async () => {
  const { handler, calls, body } = apiFixture();
  await handler(body);
  assert.equal(calls[0].id, 'original-thread:original-generation');
  assert.equal(calls[0].owner, body.userId);
});

test('an inaccessible historical job cannot reach the worker', async () => {
  const { handler, calls, body } = apiFixture({ denied: true });
  await assert.rejects(handler(body), /Job not found/);
  assert.equal(calls.length, 0);
});
