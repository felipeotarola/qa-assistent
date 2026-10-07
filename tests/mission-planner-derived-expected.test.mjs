// Actual schema/projection/SDK with synthetic transport, not model compliance.
import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { registerHooks } from 'node:module';
import { missionPlanningDraftSchema, validateMissionPlanningDraft, plannedTestCase, planningFailureAllowsRepair } from '../shared/mission-planning.ts';
import { testCaseSchema } from '../shared/test-plan.ts';
import { runChecks } from '../shared/test-run.ts';

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/agent/lib/mission-planner.ts') && ['../../shared/mission-planning', './model-usage'].includes(specifier)) return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
after(() => hooks.deregister());
const { planMission } = await import('../agent/lib/mission-planner.ts');
const originalFetch = globalThis.fetch;
const environment = Object.fromEntries(['GRUNDEN_API_TOKEN', 'GRUNDEN_MIN_REQUEST_INTERVAL_MS'].map(key => [key, process.env[key]]));
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
const id = '11111111-1111-4111-8111-111111111111', url = 'https://example.test/account';
const input = () => ({ schemaVersion: 1, goal: 'Öppna profilsidan och kontrollera kontouppgifterna. Ange vad som behövs om åtkomst saknas.', intent: 'explore',
  target: { environment: 'Webb', url, revision: '' }, allowedOrigins: ['https://example.test'], browserExecution: { version: 1, readOnly: true, agentHttpMethods: ['GET', 'HEAD', 'OPTIONS'], authenticationControls: 'inspect-only', authenticationAccess: 'human-takeover' }, maxCases: 4,
  sources: [{ itemId: id, version: 1, sourceHash: 'a'.repeat(64), url: 'https://example.test/login', title: 'Logga in', text: 'E-post, lösenord, Logga in', links: [], limited: false }], selectedCases: [], limitations: [] });
const draft = () => ({ schemaVersion: 1, title: 'Kontouppgifter', summary: 'Kontrollera det efterfrågade innehållet och redovisa faktiska hinder.',
  cases: [{ title: 'Profilsida', entryUrl: url, basis: { kind: 'explicit_requirement', quote: input().goal, source: null },
    steps: [{ action: 'Öppna profilsidan och inspektera innehållet eller den faktiska åtkomstspärren.', expected: 'Kontouppgifterna visas. Vid kvarstående spärr är innehållskravet overifierat och det konkreta behovet redovisas.' }] }],
  limitations: ['Den tidigare observerade inloggningsvyn bevisar inte vilket tillstånd den nya körningen möter.'] });
const invalid = error => error.diagnostic?.code === 'output_schema_invalid';
function transport(output) {
  process.env.GRUNDEN_API_TOKEN = 'synthetic-only'; process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS = '0';
  const requests = [];
  globalThis.fetch = async (destination, options) => {
    assert.equal(String(destination), 'https://api.grunden.ai/v1/chat/completions');
    requests.push(JSON.parse(options.body));
    return Response.json({ id: 'synthetic-derived', created: 0, model: 'glm-5.3-flash', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 20 } });
  };
  return requests;
}

test('derived expectation rejects the obsolete contradictory or empty second acceptance source without erasing it', () => {
  for (const expected of ['', 'Inloggningssidan måste visas och formuläret får inte skickas.', 'Kontouppgifterna visas.']) {
    const value = draft(); value.cases[0].expected = expected; const before = structuredClone(value);
    assert.equal(missionPlanningDraftSchema.safeParse(value).success, false);
    assert.throws(() => validateMissionPlanningDraft(input(), value), invalid);
    assert.deepEqual(value, before);
  }
});

test('derived expectation preserves profile requirement instead of adding observed login UI as a mandatory outcome', () => {
  const value = draft(), before = structuredClone(value), originalInput = input();
  const parsed = validateMissionPlanningDraft(originalInput, value), saved = plannedTestCase(parsed.cases[0], id);
  assert.equal(saved.expected, '1. Kontouppgifterna visas. Vid kvarstående spärr är innehållskravet overifierat och det konkreta behovet redovisas.');
  assert.equal(saved.preconditions, ''); assert.equal(saved.checksVersion, 2);
  assert.deepEqual(runChecks(saved).map(c => c.id), ['step-1', 'expected']);
  assert.deepEqual(value, before); assert.deepEqual(originalInput, input());
  assert.ok(!('outcome' in saved), 'Projection never declares access or product success');
});

test('derived expectation retains every explicit condition and cross-step outcome verbatim in order', () => {
  const value = draft();
  value.cases[0].steps = [
    { action: 'Fastställ en uttryckligen begärd ren session.', expected: 'En ren session utan tidigare cookies styrks; okänt tillstånd är overifierat.' },
    { action: 'Använd enbart tillåtna testdata och pröva åtkomsten för angiven identitet.', expected: 'Endast tillåtna testdata används och den uttryckliga kontoidentiteten styrks.' },
    { action: 'Inspektera uppgifterna efter den tillåtna åtkomsten.', expected: 'Kontouppgifterna för samma identifierade konto visas; utebliven åtkomst lämnar kravet overifierat.' },
  ];
  const before = structuredClone(value), saved = plannedTestCase(validateMissionPlanningDraft(input(), value).cases[0], id);
  assert.equal(saved.expected, '1. En ren session utan tidigare cookies styrks; okänt tillstånd är overifierat.\n2. Endast tillåtna testdata används och den uttryckliga kontoidentiteten styrks.\n3. Kontouppgifterna för samma identifierade konto visas; utebliven åtkomst lämnar kravet overifierat.');
  assert.equal(runChecks(saved).length, 4); assert.deepEqual(value, before);
});

test('derived expectation accepts exact 5000 characters and rejects 5001 before persistence without clipping', () => {
  const value = draft(); value.cases[0].steps = Array.from({ length: 9 }, (_, i) => ({ action: 'A', expected: 'E'.repeat(i < 8 ? 600 : 165) }));
  const saved = plannedTestCase(validateMissionPlanningDraft(input(), value).cases[0], id);
  assert.equal(saved.expected.length, 5000); assert.equal(saved.expected.endsWith('E'.repeat(165)), true);
  value.cases[0].steps[8].expected += 'E'; const before = structuredClone(value);
  assert.throws(() => validateMissionPlanningDraft(input(), value), error => invalid(error) && planningFailureAllowsRepair(error.diagnostic));
  assert.deepEqual(value, before);
});

test('derived expectation validates exact stored steps after canonical entry binding, including all separators', () => {
  const value = draft(), provided = input();
  // Nine complete 450-character expectations remain below the existing 5000 limit.
  value.cases[0].steps = Array.from({ length: 9 }, () => ({ action: 'A'.repeat(600), expected: 'E'.repeat(450) }));
  const fixed = 9 * (3 + 600 + ' Förväntat: '.length + 450) + 8 + 'Utgå från '.length + '. '.length;
  const addressLength = 10000 - fixed;
  const observed = 'https://example.test/' + 'x'.repeat(addressLength - 'https://example.test/'.length);
  provided.target.url = observed; value.cases[0].entryUrl = observed;
  const saved = plannedTestCase(validateMissionPlanningDraft(provided, value).cases[0], id);
  assert.equal(saved.steps.length, 10000); assert.ok(saved.expected.length < 5000);
  provided.target.url = observed.replace('example.test', 'EXAMPLE.test:443');
  assert.throws(() => validateMissionPlanningDraft(provided, value), invalid, 'The longer exact observed entry, not the shorter normalized input, is checked');
});

test('derived expectation keeps selected historical prerequisites and overall requirements unchanged', async () => {
  const value = input(), selected = testCaseSchema.parse({ id, title: 'Original', preconditions: 'Original prerequisites', steps: 'Original steps', expected: 'Original overall requirement' });
  value.selectedCases = [{ key: id + ':' + id, version: 3, sourceHash: 'b'.repeat(64), testCase: selected }];
  const before = structuredClone(value), requests = transport(draft());
  await assert.rejects(planMission(value), error => error.diagnostic?.code === 'input_not_plannable');
  assert.deepEqual(value, before); assert.equal(requests.length, 0); assert.equal(selected.expected, 'Original overall requirement');
});

test('derived expectation SDK exposes strict native fields and unchanged one-call budget with complete output', async () => {
  const proposed = draft(), requests = transport(proposed); let admissions = 0;
  const result = await planMission(input(), undefined, 1000, async () => { admissions++; });
  assert.equal(requests.length, 1); assert.equal(admissions, 1); assert.equal(requests[0].max_tokens, 12000);
  assert.equal(requests[0].model, 'glm-5.3-flash'); assert.equal(requests[0].reasoning_effort, 'high');
  const schema = requests[0].response_format.json_schema.schema.properties.cases.items;
  assert.equal(schema.additionalProperties, false); assert.equal(schema.properties.expected, undefined);
  assert.equal(schema.required.includes('expected'), false); assert.equal(schema.properties.steps.items.properties.expected.maxLength, 600);
  assert.match(schema.properties.steps.items.properties.expected.description, /5000/); assert.match(schema.properties.steps.items.properties.expected.description, /10000/);
  assert.deepEqual(result.draft, proposed); assert.equal(result.usage.provider.providerCalls, 1); assert.equal(result.usage.tokens, 50);
});

test('derived expectation SDK rejects old extra expected and over-limit aggregate with measured usage and no implicit retry', async () => {
  for (const failure of ['old-field', 'aggregate']) {
    const proposed = draft();
    if (failure === 'old-field') proposed.cases[0].expected = 'Only the login view is acceptable';
    else proposed.cases[0].steps = Array.from({ length: 9 }, () => ({ action: 'A', expected: 'E'.repeat(600) }));
    const requests = transport(proposed);
    await assert.rejects(planMission(input()), error => invalid(error) && error.usage.provider.providerCalls === 1 && error.usage.tokens === 50 && planningFailureAllowsRepair(error.diagnostic));
    assert.equal(requests.length, 1);
  }
});
