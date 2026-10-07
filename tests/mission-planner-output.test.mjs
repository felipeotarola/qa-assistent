// Actual installed planner/AI SDK with one synthetic provider; no app or model calls.
import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { registerHooks } from 'node:module';
import { planningOutputObserver } from '../agent/lib/planning-output.ts';
import { missionPlanningFailureSchema, planningFailureAllowsRepair, MISSION_PLANNER_TIMEOUT_MS, MAX_PLANNED_STEPS } from '../shared/mission-planning.ts';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/agent/lib/mission-planner.ts') && ['../../shared/mission-planning', './model-usage'].includes(specifier)) return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
const { planMission, MissionPlanningError } = await import('../agent/lib/mission-planner.ts');
after(() => hooks.deregister());
const originalFetch = globalThis.fetch, saved = Object.fromEntries(['GRUNDEN_API_TOKEN', 'GRUNDEN_MIN_REQUEST_INTERVAL_MS'].map(k => [k, process.env[k]]));
afterEach(() => { globalThis.fetch = originalFetch; for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
const url = 'https://output.example.test/', sourceId = '11111111-1111-4111-8111-111111111111', canary = 'PRIVATE_OUTPUT_CANARY';
const input = () => ({ schemaVersion: 1, goal: 'Kontrollera startsidan.', intent: 'explore', target: { environment: 'Publik webb', url, revision: '' }, allowedOrigins: [new URL(url).origin], browserExecution: { version: 1, readOnly: true, agentHttpMethods: ['GET', 'HEAD', 'OPTIONS'], authenticationControls: 'inspect-only', authenticationAccess: 'human-takeover' }, maxCases: 4,
  sources: [{ itemId: sourceId, version: 1, sourceHash: 'a'.repeat(64), url, title: 'Startsidan', text: 'Välkommen', links: [], limited: false }], selectedCases: [], limitations: [] });
const draft = () => ({ schemaVersion: 1, title: 'Plan', summary: 'Kontrollera startsidan.', cases: [{ title: 'Startsida', entryUrl: url,
  steps: [{ action: 'Inspektera startsidan.', expected: 'Texten Välkommen finns.' }],  basis: { kind: 'exploratory', quote: '', source: { itemId: sourceId, version: 1 } } }], limitations: [] });
function transport(content, finishReason, usage = { prompt_tokens: 30, completion_tokens: 12000 }) {
  process.env.GRUNDEN_API_TOKEN = 'synthetic-only'; process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS = '0';
  const requests = [];
  globalThis.fetch = async (destination, options) => {
    assert.equal(String(destination), 'https://api.grunden.ai/v1/chat/completions');
    requests.push(JSON.parse(options.body));
    return Response.json({ id: canary, created: 0, model: 'glm-5.3-flash', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }], ...(usage ? { usage } : {}) });
  };
  return requests;
}
const expected = (finishReason, outputTokens = 12000) => ({ finishReason, maxOutputTokens: 12000, outputTokens, capReached: outputTokens === null ? null : outputTokens >= 12000 });
async function failure(content, reason, code, usage) {
  const requests = transport(content, reason, usage);
  let caught;
  await assert.rejects(planMission(input()), error => { caught = error; assert.ok(error instanceof MissionPlanningError); assert.equal(error.diagnostic.code, code); return true; });
  assert.equal(requests.length, 1); assert.equal(caught.usage.provider.providerCalls, 1);
  assert.ok(!JSON.stringify(caught).includes(canary)); assert.equal(caught.cause, undefined);
  return caught;
}

test('truncated JSON has length diagnostic before installed SDK parse fails, with unchanged accounting', async () => {
  const e = await failure('{"secret":"' + canary, 'length', 'output_json_invalid');
  assert.deepEqual(e.diagnostic.output, expected('length'));
  assert.equal(e.usage.tokens, 12030); assert.equal(e.usage.provider.outputTokens, 12000);
});
test('empty length response retains reason even though installed SDK NoOutputGeneratedError has none', async () => {
  const e = await failure('', 'length', 'output_missing');
  assert.deepEqual(e.diagnostic.output, expected('length'));
});
test('cap equality does not override stop or manufacture a truncation classification', async () => {
  const e = await failure('not JSON ' + canary, 'stop', 'output_json_invalid');
  assert.deepEqual(e.diagnostic.output, expected('stop'));
});
test('schema failure below cap stays distinct from JSON parsing and unknown usage', async () => {
  const e = await failure(JSON.stringify({ ...draft(), title: false }), 'stop', 'output_schema_invalid', { prompt_tokens: 30, completion_tokens: 20 });
  assert.deepEqual(e.diagnostic.output, expected('stop', 20));
  const missing = await failure('invalid ' + canary, 'length', 'output_json_invalid', null);
  assert.deepEqual(missing.diagnostic.output, expected('length', null)); assert.equal(missing.usage.tokens, null);
});
test('high request preserves model, cap, prompt input, schema, step ceiling, allowance and one admission', async () => {
  const requests = transport(JSON.stringify(draft()), 'stop', { prompt_tokens: 30, completion_tokens: 20 }); let admissions = 0;
  const value = input(), result = await planMission(value, undefined, 1000, async () => { admissions++; });
  assert.equal(requests.length, 1); assert.equal(admissions, 1); assert.equal(requests[0].reasoning_effort, 'high');
  assert.equal(requests[0].max_tokens, 12000); assert.equal(requests[0].model, 'glm-5.3-flash');
  assert.equal(MISSION_PLANNER_TIMEOUT_MS, 75000); assert.equal(MAX_PLANNED_STEPS, 24);
  assert.deepEqual(JSON.parse(requests[0].messages.find(m => m.role === 'user').content), value);
  assert.deepEqual(result.draft, draft()); assert.equal(result.usage.tokens, 50); assert.ok(!requests[0].tools?.length);
});
test('one completed response above the former cap keeps its full measured cost and no additional request', async () => {
  const requests = transport(JSON.stringify(draft()), 'stop', { prompt_tokens: 300, completion_tokens: 8500 });
  let admissions = 0;
  const result = await planMission(input(), undefined, 100000, async () => { admissions++; });
  assert.equal(requests.length, 1); assert.equal(admissions, 1);
  assert.equal(requests[0].max_tokens, 12000); assert.equal(requests[0].reasoning_effort, 'high');
  assert.deepEqual(result.draft, draft()); assert.equal(result.usage.tokens, 8800);
  assert.equal(result.usage.provider.unknownCalls, 0); assert.equal(result.usage.provider.outputTokens, 8500);
});
test('a provider length stop below the new cap stays a failed plan rather than being accepted or retried', async () => {
  const e = await failure('{"schemaVersion":', 'length', 'output_json_invalid', { prompt_tokens: 300, completion_tokens: 7500 });
  assert.deepEqual(e.diagnostic.output, expected('length', 7500));
  assert.equal(e.diagnostic.output.capReached, false); assert.equal(e.usage.tokens, 7800);
});
test('bounded 75-second request timeout aborts one physical request without erasing unknown consumption', async () => {
  transport(JSON.stringify(draft()), 'stop');
  const oldTimeout = AbortSignal.timeout, timeoutArguments = [];
  let requests = 0;
  // Accelerate only the real bound signal; exercise installed SDK cancellation.
  AbortSignal.timeout = ms => { timeoutArguments.push(ms); return oldTimeout(ms === 75000 ? 10 : ms); };
  globalThis.fetch = async (_url, options) => {
    requests++; return new Promise((_, reject) => {
      if (options.signal.aborted) reject(options.signal.reason);
      else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  };
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(planMission(input()), error => {
      assert.equal(error.diagnostic.code, 'timeout');
      assert.equal(error.usage.provider.providerCalls, 1); assert.equal(error.usage.provider.unknownCalls, 1);
      assert.equal(error.usage.tokens, null); assert.deepEqual(error.diagnostic.output, expected(null, null)); return true;
    });
    assert.equal(requests, 1); assert.ok(timeoutArguments.includes(75000));
  } finally { clearTimeout(keepAlive); AbortSignal.timeout = oldTimeout; }
});
test('the original caller deadline still aborts before the local output window', async () => {
  transport(JSON.stringify(draft()), 'stop'); let requests = 0;
  const caller = new AbortController();
  globalThis.fetch = async (_url, options) => {
    requests++; caller.abort(new DOMException('Caller deadline', 'TimeoutError'));
    options.signal.throwIfAborted(); throw new Error('Caller deadline was lost');
  };
  await assert.rejects(planMission(input(), caller.signal), error => {
    assert.equal(error.diagnostic.code, 'timeout'); assert.equal(error.usage.tokens, null);
    assert.equal(error.usage.provider.providerCalls, 1); return true;
  });
  assert.equal(requests, 1);
});
test('safe old and new diagnostics keep the same repair decision and never feed provider telemetry to the model', async () => {
  const old = { version: 1, code: 'output_json_invalid' }, revised = { ...old, output: expected('length') };
  assert.deepEqual(missionPlanningFailureSchema.parse(old), old); assert.deepEqual(missionPlanningFailureSchema.parse(revised), revised);
  assert.equal(planningFailureAllowsRepair(revised), planningFailureAllowsRepair(old));
  const requests = transport(JSON.stringify(draft()), 'stop');
  await planMission(input(), undefined, 100000, undefined, revised);
  assert.equal(requests.length, 1); assert.ok(!JSON.stringify(requests[0].messages).includes('finishReason'));
  assert.ok(!JSON.stringify(requests[0].messages).includes('capReached'));
  for (const output of [{ ...expected('length'), text: canary }, { ...expected('length'), finishReason: canary }, { ...expected('length'), capReached: false }]) {
    assert.equal(missionPlanningFailureSchema.safeParse({ ...old, output }).success, false);
  }
});
test('admission denial and caller abort make no physical request and keep output unknown', async () => {
  const requests = transport(JSON.stringify(draft()), 'stop');
  await assert.rejects(planMission(input(), undefined, 1000, async () => { throw new Error(canary); }), e => {
    assert.equal(e.diagnostic.code, 'admission_denied'); assert.deepEqual(e.diagnostic.output, expected(null, null));
    assert.equal(e.usage.provider.providerCalls, 0); assert.ok(!JSON.stringify(e).includes(canary)); return true;
  });
  const controller = new AbortController(); controller.abort(new Error(canary));
  await assert.rejects(planMission(input(), controller.signal), e => e.diagnostic.code === 'cancelled' && e.usage.provider.providerCalls === 0);
  assert.equal(requests.length, 0);
});
test('observer is inert for untrusted getters, preserves result/error identity and never reads raw response properties', async () => {
  const usage = { providerCalls: 1, unknownCalls: 0, outputTokens: 12000 };
  for (const reason of ['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other', canary, undefined]) {
    const observer = planningOutputObserver(12000), result = { finishReason: { unified: reason } };
    for (const key of ['raw', 'content', 'response', 'usage', 'cause']) Object.defineProperty(result, key, { get() { throw new Error(canary); } });
    Object.defineProperty(result.finishReason, 'raw', { get() { throw new Error(canary); } });
    assert.equal(await observer.middleware.wrapGenerate({ doGenerate: async () => result }), result);
    assert.deepEqual(observer.diagnostic(usage), expected(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other'].includes(reason) ? reason : null));
  }
  const observer = planningOutputObserver(12000), result = Object.defineProperty({}, 'finishReason', { get() { throw new Error(canary); } });
  assert.equal(await observer.middleware.wrapGenerate({ doGenerate: async () => result }), result);
  assert.deepEqual(observer.diagnostic(usage), expected(null));
  const original = new Error(canary);
  await assert.rejects(observer.middleware.wrapGenerate({ doGenerate: async () => { throw original; } }), e => e === original);
});
