import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { jsonSchema } from 'ai';

// Real Eve definitions, transform, resolver, durable descriptors and executor.
// Only provider HTTP responses are synthetic; no external request is permitted.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const path = new URL(specifier + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(path))) return { url: path.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const capabilities = await import('../agent/lib/iris-capabilities.ts');
const { ContextContainer, contextStorage } = await import('../node_modules/eve/dist/src/context/container.js');
const { SessionKey, AuthKey, InitiatorAuthKey, SessionIdKey, SessionDynamicToolMetadataKey, TurnDynamicToolMetadataKey } = await import('../node_modules/eve/dist/src/context/keys.js');
const { dispatchDynamicToolEvent } = await import('../node_modules/eve/dist/src/context/dynamic-tool-lifecycle.js');
const { buildResponseAuthorizationTools, replayDynamicTools } = await import('../node_modules/eve/dist/src/context/build-dynamic-tools.js');
const { buildToolSetFromDefinitions } = await import('../node_modules/eve/dist/src/harness/tools.js');
const { createToolLoopHarness } = await import('../node_modules/eve/dist/src/harness/tool-loop.js');
const { createHarnessDelegationToolDefinition } = await import('../node_modules/eve/dist/src/execution/delegation-tool.js');
const { createDynamicCapabilityTransformPlugin } = await import('../node_modules/eve/dist/src/internal/workflow-bundle/dynamic-capability-transform-plugin.js');
const { grundenModelSelection } = await import('../agent/lib/grunden.ts');
const identity = { authenticator: 'app', principalType: 'user', principalId: 'fixture-user', attributes: { browserWorker: 'iris', browserThreadId: 'fixture-thread', browserJobId: 'fixture-job' } };
const iris = { session: { id: 'fixture-session', auth: { current: identity, initiator: identity } }, callId: 'fixture-call', abortSignal: new AbortController().signal, getSandbox() { throw new Error('Unexpected sandbox effect'); } };
const normal = { session: { auth: { current: { ...identity, attributes: {} }, initiator: { ...identity, attributes: {} } } } };

test('Iris capability detection includes initiating identity and permits ordinary sessions', () => {
  assert.equal(capabilities.isIrisSession(iris), true); assert.equal(capabilities.isIrisSession(normal), false);
  assert.throws(() => capabilities.denyIrisCapability({ session: { auth: { current: normal.session.auth.current, initiator: identity } } }), /Iris may only/);
  assert.doesNotThrow(() => capabilities.denyIrisCapability(normal));
});

test('Every unrelated authored executor rejects Iris before fetch, sandbox or state effects', async () => {
  const savedFetch = globalThis.fetch; let effects = 0;
  globalThis.fetch = async () => { effects++; throw new Error('Unexpected external effect'); };
  try {
    for (const name of ['browser_job', 'codex', 'external', 'inspect_environment', 'mission', 'preview', 'quality', 'report', 'repository', 'research', 'test_plan', 'test_requirement', 'web_search', 'weather', 'suggest_next_steps']) {
      const definition = (await import(`../agent/tools/${name}.ts`)).default;
      await assert.rejects(async () => definition.execute({ action: 'read', location: 'Stockholm', query: 'fixture' }, iris), /Iris may only/, name);
    }
    assert.equal(effects, 0);
  } finally { globalThis.fetch = savedFetch; }
});

test('Sandbox, memory, MCP and delegated repo deny Iris while ordinary memory scope is preserved', async () => {
  const sandbox = (await import('../agent/sandbox.ts')).default;
  let used = false; await assert.rejects(() => sandbox.onSession({ use: async () => { used = true; }, ctx: iris }), /Iris may only/); assert.equal(used, false);
  const memory = (await import('../agent/memory/profile.ts')).default;
  assert.equal(await memory.scope(iris), null); assert.equal(typeof await memory.scope(normal), 'string');
  const linear = (await import('../agent/connections/linear.ts')).default;
  assert.equal((await linear.approval(iris)).type, 'denied'); assert.equal(await linear.approval(normal), 'not-applicable');
  const repo = (await import('../agent/subagents/repo/agent.ts')).default;
  assert.throws(() => repo.model.events['step.started']({}, iris), /Iris may only/);
});

test('Actual Eve transform, resolver and replay replace forged builtin dispatch with denial', async () => {
  const root = resolve('.data/autonomy-isolation'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(resolve(root, 'iris-policy-'));
  try {
    const path = resolve('agent/tools/iris_restrictions.ts');
    const source = readFileSync(path, 'utf8').replace("'../lib/iris-capabilities'", JSON.stringify(pathToFileURL(resolve('agent/lib/iris-capabilities.ts')).href));
    const transformed = await createDynamicCapabilityTransformPlugin().transform(source, path); assert.ok(transformed?.code, 'The actual Eve compiler must stamp callbacks');
    const output = resolve(directory, 'restrictions.ts'); writeFileSync(output, transformed.code);
    const definition = (await import(pathToFileURL(output).href)).default;
    const resolver = { slug: 'iris_restrictions', logicalPath: 'agent/tools/iris_restrictions.ts', eventNames: ['session.started', 'turn.started'], events: definition.events };
    const ctx = new ContextContainer(); ctx.set(AuthKey, identity); ctx.set(InitiatorAuthKey, identity); ctx.set(SessionIdKey, 'fixture-session'); ctx.set(SessionKey, { sessionId: 'fixture-session', auth: iris.session.auth, turn: { id: 'fixture-turn' } });
    await contextStorage.run(ctx, async () => {
      await dispatchDynamicToolEvent({ ctx, resolvers: [resolver], event: { type: 'session.started' }, messages: [] });
      await dispatchDynamicToolEvent({ ctx, resolvers: [resolver], event: { type: 'turn.started' }, messages: [] });
      const metadata = JSON.parse(JSON.stringify(ctx.require(TurnDynamicToolMetadataKey)));
      assert.equal(metadata.length, capabilities.IRIS_DENIED_LOCAL_TOOLS.length); assert.equal(ctx.require(SessionDynamicToolMetadataKey).length, capabilities.IRIS_DENIED_LOCAL_TOOLS.length);
      assert.deepEqual(metadata.map(entry => entry.name).sort(), [...capabilities.IRIS_DENIED_LOCAL_TOOLS].sort());
      let escaped = 0;
      const fallback = { name: 'bash', description: 'Original shell executor', inputSchema: { type: 'object' }, execute() { escaped++; } };
      const policy = buildResponseAuthorizationTools({ authoredTools: new Map([['bash', fallback]]), context: ctx });
      assert.notEqual(policy.get('bash').execute, fallback.execute, 'Local executor must be replaced');
      const executor = buildToolSetFromDefinitions({ tools: [...replayDynamicTools(metadata), fallback], capabilities: { requestInput: true } });
      for (const entry of metadata) await assert.rejects(() => executor[entry.name].execute({ fabricated: true }, { toolCallId: `forged-${entry.name}`, messages: [] }), /Iris may only/, entry.name);
      assert.equal(escaped, 0);
      ctx.set(AuthKey, normal.session.auth.current); ctx.set(InitiatorAuthKey, normal.session.auth.initiator);
      await dispatchDynamicToolEvent({ ctx, resolvers: [resolver], event: { type: 'session.started' }, messages: [] });
      await dispatchDynamicToolEvent({ ctx, resolvers: [resolver], event: { type: 'turn.started' }, messages: [] });
      assert.equal(buildResponseAuthorizationTools({ authoredTools: new Map([['bash', fallback]]), context: ctx }).get('bash'), fallback);
    });
  } finally {
    assert.ok(resolve(directory).startsWith(root + sep)); rmSync(directory, { recursive: true, force: true });
  }
});

test('Actual model middleware rejects invented tool calls in generate and stream, including absent deny-map recovery', async () => {
  const originalFetch = globalThis.fetch, oldToken = process.env.GRUNDEN_API_TOKEN;
  process.env.GRUNDEN_API_TOKEN = 'isolated-fixture-token';
  let requestedName = 'bash'; const advertised = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); advertised.push((body.tools || []).map(value => value.function.name));
    if (body.stream) {
      const event = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'forged', type: 'function', function: { name: requestedName, arguments: '{}' } }] }, finish_reason: null }] };
      return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({ id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'forged', type: 'function', function: { name: requestedName, arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  };
  try {
    const model = grundenModelSelection('glm-5.3-flash', 'low', false, true).model;
    const options = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic policy probe' }] }], tools: ['browser', 'workspace', 'test_run', 'load_skill', 'bash', 'linear__read', 'github__getRepository'].map(name => ({ type: 'function', name, inputSchema: { type: 'object', properties: {} } })) };
    for (const name of ['bash', 'agent', 'eve:subagent:repo', 'task_cancel', 'task_update', 'Workflow', 'external', 'linear__read', 'github__getRepository', 'profile__save_memory', 'fake_load_skill']) {
      requestedName = name; await assert.rejects(() => model.doGenerate(options), /Iris may only/, name);
      const { stream } = await model.doStream(options); const reader = stream.getReader();
      await assert.rejects(async () => { while (!(await reader.read()).done) { /* drain actual middleware stream */ } }, /Iris may only/, name);
    }
    requestedName = 'browser'; assert.equal((await model.doGenerate(options)).content[0].toolName, 'browser');
    for (const names of advertised) assert.deepEqual(names, ['browser', 'workspace', 'test_run', 'load_skill']);
    assert.throws(() => capabilities.assertIrisToolOutput({ type: 'tool-call', toolName: 'browser', providerExecuted: true }), /Iris may only/);
    requestedName = 'external'; assert.equal((await grundenModelSelection('glm-5.3-flash', 'low').model.doGenerate(options)).content[0].toolName, 'external');
  } finally { globalThis.fetch = originalFetch; if (oldToken === undefined) delete process.env.GRUNDEN_API_TOKEN; else process.env.GRUNDEN_API_TOKEN = oldToken; }
});

test('Actual Eve tool loop composes Iris restrictions with runtime delegation before its first provider call', async () => {
  const root = resolve('.data/autonomy-isolation'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(resolve(root, 'iris-composition-'));
  const originalFetch = globalThis.fetch, oldToken = process.env.GRUNDEN_API_TOKEN;
  process.env.GRUNDEN_API_TOKEN = 'isolated-fixture-token';
  let calls = 0, effects = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.grunden.ai/v1/chat/completions', 'No other network request is permitted');
    const body = JSON.parse(options.body); calls++;
    assert.deepEqual(body.tools.map(tool => tool.function.name).sort(), [...capabilities.IRIS_TOOL_NAMES].sort());
    assert.equal(body.stream, true, 'Exercise the real tool loop streaming path');
    const chunks = [
      { id: 'composed', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Composition accepted.' }, finish_reason: null }] },
      { id: 'composed', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const path = resolve('agent/tools/iris_restrictions.ts');
    const source = readFileSync(path, 'utf8').replace("'../lib/iris-capabilities'", JSON.stringify(pathToFileURL(resolve('agent/lib/iris-capabilities.ts')).href));
    const transformed = await createDynamicCapabilityTransformPlugin().transform(source, path);
    assert.ok(transformed?.code);
    const output = resolve(directory, 'restrictions.ts'); writeFileSync(output, transformed.code);
    const definition = (await import(pathToFileURL(output).href)).default;
    const resolver = { slug: 'iris_restrictions', logicalPath: 'agent/tools/iris_restrictions.ts', eventNames: ['session.started', 'turn.started'], events: definition.events };
    // Use Eve's own lowering of the real built-in and declared-subagent shape,
    // not an ordinary executable tool pretending to be a runtime action.
    const delegation = ['agent', 'eve:subagent:repo'].map(name => createHarnessDelegationToolDefinition({ name, kind: 'local', nodeId: name === 'agent' ? '__root__' : 'repo', rootOnly: name === 'agent', description: name, inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }));
    const local = [...capabilities.IRIS_DENIED_LOCAL_TOOLS, ...capabilities.IRIS_TOOL_NAMES].map(name => ({ name, description: name, inputSchema: jsonSchema({ type: 'object', properties: {} }), execute() { effects++; throw new Error('Unexpected tool execution'); } }));
    for (const name of ['browser', 'workspace', 'test_run']) {
      // Validate the real authored schemas through the installed AI SDK too.
      const authored = (await import(`../agent/tools/${name}.ts`)).default;
      const tool = local.find(tool => tool.name === name);
      tool.inputSchema = authored.inputSchema; tool.description = authored.description;
    }
    const taskControl = { name: 'task_cancel', description: 'Cancel task', inputSchema: jsonSchema({ type: 'object', properties: {} }), runtimeAction: { kind: 'task-control' } };
    const tools = new Map([...delegation, ...local, taskControl].map(tool => [tool.name, tool]));
    const events = [];
    async function run(selectedResolver) {
      const ctx = new ContextContainer(); ctx.set(AuthKey, identity); ctx.set(InitiatorAuthKey, identity); ctx.set(SessionIdKey, 'composed-session');
      ctx.set(SessionKey, { sessionId: 'composed-session', auth: iris.session.auth, turn: { id: 'turn_0' } });
      const harness = createToolLoopHarness({ mode: 'task', capabilities: { requestInput: true }, tools,
        resolveModel: async () => grundenModelSelection('glm-5.3-flash', 'low', false, true).model,
        handleEvent: async (event, messages) => { events.push(event); await dispatchDynamicToolEvent({ ctx, resolvers: [selectedResolver], event, messages: messages || [] }); },
      });
      const session = { sessionId: 'composed-session', continuationToken: 'fixture', history: [], state: {}, compaction: { recentWindowSize: 20, threshold: 100000 },
        agent: { system: 'Synthetic framework composition test.', modelReference: { id: 'grunden/glm-5.3-flash', contextWindowTokens: 190000 }, tools: [] } };
      return contextStorage.run(ctx, () => harness(session, { message: 'Reply briefly.' }));
    }
    const result = await run(resolver);
    assert.equal(calls, 1, 'The actual tool loop must reach the provider after composing all descriptors');
    assert.equal(effects, 0);
    assert.equal(result.next?.isError, undefined, JSON.stringify(events.filter(event => /fail|error/.test(event.type))));
    assert.equal(result.next?.done, true); assert.equal(result.next.output, 'Composition accepted.');
    // Negative control proves the previous bug fails at the actual composition
    // boundary before a provider call, rather than only checking array contents.
    const faulty = { ...resolver, events: Object.fromEntries(Object.entries(definition.events).map(([event, resolve]) => [event, async (...args) => {
      const values = await resolve(...args); return { ...values, agent: values.bash };
    }])) };
    await assert.rejects(() => run(faulty), /Dynamic tool "agent" collides with a runtime-visible subagent/);
    assert.equal(calls, 1, 'Collision must be rejected before any additional provider request');
  } finally {
    globalThis.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.GRUNDEN_API_TOKEN; else process.env.GRUNDEN_API_TOKEN = oldToken;
    assert.ok(resolve(directory).startsWith(root + sep)); rmSync(directory, { recursive: true, force: true });
  }
});

test.after(() => hooks.deregister());
