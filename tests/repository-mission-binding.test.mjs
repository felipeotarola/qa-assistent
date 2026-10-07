import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { repositoryActionSchema, repositoryToolInputSchema } from '../shared/repository.ts';
import { repositoryRequestId, repositoryRequestMatches } from '../shared/repository-request.mjs';

const uuid = value => repositoryRequestId('binding-fixture', value);
const binding = { missionId: uuid('mission'), taskId: uuid('task') };
const start = { action: 'start', repositoryId: uuid('repo'), mode: 'inspect' };

test('provider and server preserve object and serialized mission bindings', () => {
  for (const mission of [binding, JSON.stringify(binding)]) {
    const modelInput = repositoryToolInputSchema.parse({ ...start, mission });
    const serverInput = repositoryActionSchema.parse({ ...modelInput, requestId: uuid('request') });
    assert.deepEqual(modelInput.mission, binding);
    assert.deepEqual(serverInput.mission, binding);
  }
  const adHoc = repositoryToolInputSchema.parse(start);
  assert.equal(repositoryActionSchema.parse({ ...adHoc, requestId: uuid('ad-hoc') }).mission, undefined);
});

test('malformed bindings cannot silently degrade into unbound execution', () => {
  for (const mission of ['{', '{}', 'null', JSON.stringify({ ...binding, taskId: 'not-a-uuid' }), { missionId: binding.missionId }, null, []]) {
    assert.equal(repositoryToolInputSchema.safeParse({ ...start, mission }).success, false);
    assert.equal(repositoryActionSchema.safeParse({ ...start, requestId: uuid('bad'), mission }).success, false);
  }
});

test('a submission identity includes exact execution binding and runtime', () => {
  const request = { repositoryId: start.repositoryId, runtime: 'fixture:a', bindingVersion: 1, config: { url: 'https://github.com/fixture/repo', ref: '', mode: 'inspect' }, missionBinding: binding };
  assert.equal(repositoryRequestMatches(structuredClone(request), request), true);
  for (const changed of [
    { missionBinding: { ...binding, missionId: uuid('other-mission') } },
    { missionBinding: { ...binding, taskId: uuid('other-task') } },
    { missionBinding: null },
    { missionBinding: undefined },
    { runtime: 'fixture:b' },
    { runtime: null },
    { bindingVersion: null },
    { bindingVersion: undefined },
    { repositoryId: uuid('other-repo') },
    { config: { ...request.config, ref: 'another-ref' } },
  ]) assert.equal(repositoryRequestMatches(request, { ...request, ...changed }), false);
  const legacy = { ...request, missionBinding: null };
  assert.equal(repositoryRequestMatches(legacy, { ...request, missionBinding: undefined }), true);
  assert.equal(repositoryRequestMatches(legacy, request), false, 'Legacy unbound runs cannot acquire execution ownership by replay');
  assert.equal(repositoryRequestMatches({ ...legacy, bindingVersion: null }, { ...legacy, bindingVersion: 1 }), false, 'Unknown legacy binding cannot be replayed as a new ad hoc authorization');
});

test('V and Axel use the real tool schema and send mission binding to internal API', async () => {
  // Replace only Eve registration and HTTP transport: this loads the authored
  // tools, parses their provider-facing input, and inspects their real API body.
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'eve/tools') return { url: 'data:text/javascript,export const defineTool = value => value;', shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, context);
  } });
  const originalFetch = globalThis.fetch;
  const previousSecret = process.env.INTERNAL_API_SECRET;
  process.env.INTERNAL_API_SECRET = 'fixture-internal-secret';
  const submissions = [];
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).endsWith('/api/internal/repository'));
    assert.equal(options.headers.authorization, 'Bearer fixture-internal-secret');
    const body = JSON.parse(options.body);
    const input = repositoryActionSchema.parse(body.input);
    submissions.push({ ...body, input });
    return Response.json({ accepted: true });
  };
  try {
    const tool = (await import('../agent/tools/repository.ts')).default;
    const axel = (await import('../agent/subagents/repo/tools/repository.ts')).default;
    assert.equal(axel, tool);
    assert.equal(tool.inputSchema, repositoryToolInputSchema);
    const ctx = { session: { auth: { current: { authenticator: 'app', principalId: uuid('user'), attributes: { browserThreadId: uuid('thread') } } } }, callId: 'call-a', abortSignal: new AbortController().signal };
    for (const mission of [binding, JSON.stringify(binding)]) {
      await tool.execute(tool.inputSchema.parse({ ...start, mission }), ctx);
    }
    assert.equal(submissions.length, 2);
    assert.deepEqual(submissions[0], submissions[1]);
    assert.deepEqual(submissions[0].input.mission, binding);
    assert.equal(submissions[0].input.requestId, repositoryRequestId(uuid('thread'), 'call-a'));
    const invalid = await tool.execute({ ...start, mission: '{' }, ctx);
    assert.ok(invalid.error);
    assert.equal(submissions.length, 2, 'Invalid binding never reaches the API');
    await tool.execute(tool.inputSchema.parse(start), { ...ctx, callId: 'ad-hoc' });
    assert.equal(submissions[2].input.mission, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = previousSecret;
    hooks.deregister();
  }
});
