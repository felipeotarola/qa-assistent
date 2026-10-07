// Installed SDK with synthetic transport only; no provider or app API calls.
import assert from 'node:assert/strict';
import { test, after, afterEach } from 'node:test';
import { registerHooks } from 'node:module';
import { missionPlanningFailureSchema, planningFailureAllowsRepair, validateMissionPlanningDraft, plannedTestCase } from '../shared/mission-planning.ts';
const expectedFromSteps = value => value.steps.map((step, index) => `${index + 1}. ${step.expected}`).join('\n');
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/agent/lib/mission-planner.ts') && ['../../shared/mission-planning', './model-usage'].includes(specifier)) return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
const { planMission, MissionPlanningError, classifyPlanningFailure } = await import('../agent/lib/mission-planner.ts');
after(() => hooks.deregister());
const originalFetch = globalThis.fetch;
const saved = Object.fromEntries(['GRUNDEN_API_TOKEN', 'GRUNDEN_MIN_REQUEST_INTERVAL_MS'].map(key => [key, process.env[key]]));
afterEach(() => { globalThis.fetch = originalFetch; for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
const sourceId = '11111111-1111-4111-8111-111111111111';
function input(url = 'https://planning.example.test/') {
  return { schemaVersion: 1, goal: 'Kontrollera startsidan.', intent: 'explore', target: { environment: 'Publik webb', url, revision: '' }, allowedOrigins: [new URL(url).origin], browserExecution: { version: 1, readOnly: true, agentHttpMethods: ['GET', 'HEAD', 'OPTIONS'], authenticationControls: 'inspect-only', authenticationAccess: 'human-takeover' }, maxCases: 4,
    sources: [{ itemId: sourceId, version: 1, sourceHash: 'a'.repeat(64), url, title: 'Startsidan', text: 'Välkommen', links: [], limited: false }], selectedCases: [], limitations: [] };
}
function draft(entryUrl = 'https://planning.example.test/') {
  return { schemaVersion: 1, title: 'Plan', summary: 'Kontrollera det observerade innehållet.', cases: [{ title: 'Startsidan', entryUrl,
    steps: [{ action: 'Inspektera startsidan.', expected: 'Texten Välkommen visas.' }],
    basis: { kind: 'exploratory', quote: '', source: { itemId: sourceId, version: 1 } } }], limitations: [] };
}
function transport(text, usage = { prompt_tokens: 30, completion_tokens: 20 }) {
  process.env.GRUNDEN_API_TOKEN = 'synthetic-planner-only'; process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS = '0';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.grunden.ai/v1/chat/completions'); calls.push(JSON.parse(options.body));
    return Response.json({ id: 'synthetic-only', created: 0, model: 'glm-5.3-flash', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], ...(usage ? { usage } : {}) });
  };
  return calls;
}
test('root slash/default port/host case bind back to the exact observed URL', () => {
  const value = input('https://planning.example.test/');
  for (const candidate of ['https://planning.example.test', 'https://PLANNING.example.test:443/']) {
    const proposed = draft(candidate), result = validateMissionPlanningDraft(value, proposed);
    assert.equal(result.cases[0].entryUrl, value.sources[0].url);
    assert.equal(proposed.cases[0].entryUrl, candidate, 'Parser clone does not mutate caller history');
  }
});
test('canonical comparison does not invent paths, alias origins, remove query order or fragment', () => {
  const pairs = [
    ['https://planning.example.test/a', 'https://planning.example.test/a/'], ['https://planning.example.test/A', 'https://planning.example.test/a'],
    ['https://planning.example.test/?a=1&b=2', 'https://planning.example.test/?b=2&a=1'], ['https://planning.example.test/#x', 'https://planning.example.test/'],
    ['https://planning.example.test/', 'http://planning.example.test/'], ['https://planning.example.test/', 'https://www.planning.example.test/'],
    ['https://planning.example.test/a%2Fb', 'https://planning.example.test/a/b'], ['https://planning.example.test/', 'https://user:secret@planning.example.test/'],
  ];
  for (const [observed, candidate] of pairs) assert.throws(() => validateMissionPlanningDraft(input(observed), draft(candidate)));
});
test('trusted validation diagnostics distinguish URL, basis, literal quote and budgets', () => {
  const cases = [
    ['entry_url_unobserved', value => { value.cases[0].entryUrl += 'invented'; }],
    ['source_reference_invalid', value => { value.cases[0].basis.source.version = 2; }],
    ['explicit_requirement_invalid', value => { value.cases[0].basis = { kind: 'explicit_requirement', quote: 'invented secret', source: null }; }],
    ['duplicate_case_title', value => { value.cases.push(structuredClone(value.cases[0])); }],
    ['plan_case_budget', value => { value.cases = Array.from({ length: 5 }, (_, i) => ({ ...value.cases[0], title: `Fall ${i}` })); }],
  ];
  for (const [code, mutate] of cases) { const value = draft(); mutate(value); assert.throws(() => validateMissionPlanningDraft(input(), value), error => error.diagnostic?.code === code); }
});
test('installed SDK JSON failure is diagnosed with measured usage and no raw canary', async () => {
  const canary = 'private-provider-body-canary', calls = transport('not JSON ' + canary);
  await assert.rejects(planMission(input()), error => {
    assert.ok(error instanceof MissionPlanningError); assert.equal(error.diagnostic.code, 'output_json_invalid');
    assert.equal(error.usage.tokens, 50); assert.equal(error.usage.provider.providerCalls, 1);
    assert.ok(!JSON.stringify(error).includes(canary)); assert.ok(!error.message.includes(canary)); assert.equal(error.cause, undefined); return true;
  });
  assert.equal(calls.length, 1, 'No hidden SDK retry');
});
test('installed SDK schema failure remains different from authored URL validation', async () => {
  const bad = draft(); bad.title = false; transport(JSON.stringify(bad));
  await assert.rejects(planMission(input()), error => error.diagnostic?.code === 'output_schema_invalid' && error.usage.tokens === 50);
  transport(JSON.stringify(draft('https://planning.example.test/invented')));
  await assert.rejects(planMission(input()), error => error.diagnostic?.code === 'entry_url_unobserved' && error.usage.tokens === 50);
});
test('missing provider usage remains unknown even for a repairable output failure', async () => {
  transport('not JSON', null);
  await assert.rejects(planMission(input()), error => error.usage.tokens === null && error.usage.provider.unknownCalls === 1);
});
test('admission rejection performs no physical call and does not persist raw error text', async () => {
  const calls = transport(JSON.stringify(draft()));
  await assert.rejects(planMission(input(), undefined, 1000, async () => { throw new Error('private-admission-canary'); }), error => {
    assert.equal(error.diagnostic.code, 'admission_denied'); assert.equal(error.usage.provider.providerCalls, 0); assert.equal(error.usage.tokens, 0);
    assert.ok(!JSON.stringify(error).includes('private-admission-canary')); return true;
  });
  assert.equal(calls.length, 0);
});
test('structural retry receives only a safe fixed reminder and unchanged input', async () => {
  const calls = transport(JSON.stringify(draft())), value = input();
  await planMission(value, undefined, 1000, undefined, { version: 1, code: 'entry_url_unobserved' });
  assert.equal(calls.length, 1); assert.deepEqual(JSON.parse(calls[0].messages.find(m => m.role === 'user').content), value);
  assert.match(calls[0].messages.find(m => m.role === 'system').content, /tidigare separat planeringsförsök/);
  assert.equal(classifyPlanningFailure(new Error('private-secret')).code, 'unexpected');
  assert.equal(missionPlanningFailureSchema.safeParse({ version: 1, code: 'output_json_invalid', raw: 'secret' }).success, false);
  for (const code of ['unexpected', 'admission_denied', 'timeout', 'provider_rate_limited', 'configuration_missing']) assert.equal(planningFailureAllowsRepair({ version: 1, code }), false);
});
test('installed SDK receives the generic observation boundary and negative destination-flow examples', async () => {
  const value = input(); value.sources[0].links = [{ label: 'Produkter', url: 'https://planning.example.test/products' }];
  const proposed = draft(); proposed.cases[0].steps = [{ action: 'Klicka på länken Produkter.', expected: 'Länkens målsida öppnas; inspektera sidans innehåll och eventuella fel.' }];

  proposed.limitations = ['Målsidans kontroller har ännu inte observerats; inget djupare produktflöde ingår.'];
  const calls = transport(JSON.stringify(proposed)), result = await planMission(value);
  const system = calls[0].messages.find(message => message.role === 'system').content;
  assert.match(system, /enbart observerade länkar/);
  assert.match(system, /Produkter motiverar inte.*klickbar produktlänk och en detaljsida/);
  assert.match(system, /Mitt konto motiverar inte.*återställ-lösenordskontroll/);
  assert.match(system, /om funktionen finns/);
  assert.deepEqual(JSON.parse(calls[0].messages.find(message => message.role === 'user').content), value);
  assert.deepEqual(result.draft.cases[0].steps, proposed.cases[0].steps);
  assert.equal(calls.length, 1);
  // This checks the actual request contract and accepted bounded example,
  // not how a real model will obey semantic grounding in future runs.
});
test('an explicit deeper requirement remains a requirement with its missing prerequisite', async () => {
  const value = input(); value.goal = 'Kontrollera produktdetaljsidan.';
  const proposed = draft(); proposed.cases[0] = { ...proposed.cases[0], title: 'Uttryckligt detaljkrav',
    steps: [{ action: 'Inspektera ingångssidan för en väg till den efterfrågade produktdetaljsidan. Dokumentera en saknad förutsättning om ingen kan fastställas.', expected: 'Produktdetaljsidan ska kontrolleras enligt användarens krav; om ingången inte kan fastställas kvarstår kravet som ej verifierat. Det framgår vilken väg som observerats eller vilken förutsättning som saknas; ingen detaljsida antas verifierad.' }],

    basis: { kind: 'explicit_requirement', quote: value.goal, source: null } };
  proposed.limitations = ['Underlaget visar inte hur produktdetaljsidan nås. Det uttryckliga kravet är kvar och saknar ännu en bekräftad ingång.', 'En bekräftad ingång till produktdetaljsidan saknas i det sparade observationsunderlaget.'];
  const calls = transport(JSON.stringify(proposed)), result = await planMission(value);
  assert.equal(result.draft.cases[0].basis.kind, 'explicit_requirement');
  assert.equal(result.draft.cases[0].basis.quote, value.goal);
  const savedCase = plannedTestCase(result.draft.cases[0], sourceId);
  assert.equal(savedCase.expected, '1. Produktdetaljsidan ska kontrolleras enligt användarens krav; om ingången inte kan fastställas kvarstår kravet som ej verifierat. Det framgår vilken väg som observerats eller vilken förutsättning som saknas; ingen detaljsida antas verifierad.');
  assert.equal(savedCase.steps, '1. Utgå från https://planning.example.test/. Inspektera ingångssidan för en väg till den efterfrågade produktdetaljsidan. Dokumentera en saknad förutsättning om ingen kan fastställas. Förväntat: Produktdetaljsidan ska kontrolleras enligt användarens krav; om ingången inte kan fastställas kvarstår kravet som ej verifierat. Det framgår vilken väg som observerats eller vilken förutsättning som saknas; ingen detaljsida antas verifierad.');
  assert.equal(expectedFromSteps(result.draft.cases[0]), expectedFromSteps(proposed.cases[0]));
  assert.deepEqual(result.draft.limitations, proposed.limitations);
  assert.match(calls[0].messages.find(message => message.role === 'system').content, /Uttryckliga användarkrav får däremot inte tas bort eller försvagas/);
});
