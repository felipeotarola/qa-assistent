// Permission to use the approved entry is separate from evidence about its content.
import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { registerHooks } from 'node:module';
import { validateMissionPlanningDraft, MISSION_PLANNER_VERSION } from '../shared/mission-planning.ts';
const expectedFromSteps = value => value.steps.map((step, index) => `${index + 1}. ${step.expected}`).join('\n');
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/agent/lib/mission-planner.ts') && ['../../shared/mission-planning', './model-usage'].includes(specifier)) return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
const { planMission } = await import('../agent/lib/mission-planner.ts'); after(() => hooks.deregister());
const originalFetch = globalThis.fetch, saved = Object.fromEntries(['GRUNDEN_API_TOKEN', 'GRUNDEN_MIN_REQUEST_INTERVAL_MS'].map(k => [k, process.env[k]]));
afterEach(() => { globalThis.fetch = originalFetch; for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
const origin = 'https://member.example.test', target = origin + '/membership', login = origin + '/sign-in';
const sourceId = '11111111-1111-4111-8111-111111111111', goal = 'Öppna medlemsvyn och kontrollera medlemskapets uppgifter. Säg vad du behöver om du inte kommer in.';
const input = () => ({ schemaVersion: 1, goal, intent: 'explore', target: { environment: 'Publik webb', url: target, revision: '' }, allowedOrigins: [origin], browserExecution: { version: 1, readOnly: true, agentHttpMethods: ['GET', 'HEAD', 'OPTIONS'], authenticationControls: 'inspect-only', authenticationAccess: 'human-takeover' }, maxCases: 4,
  sources: [{ itemId: sourceId, version: 1, sourceHash: 'a'.repeat(64), url: login, title: 'Logga in', text: 'Logga in för att fortsätta.', links: [{ label: 'Kontakt', url: origin + '/contact' }], limited: false }], selectedCases: [], limitations: [] });
const draft = (entryUrl = target) => ({ schemaVersion: 1, title: 'Medlemsuppgifter', summary: 'Pröva den godkända ingången utan att anta autentisering.',
  cases: [{ title: 'Åtkomst till medlemsuppgifter', entryUrl,
    steps: [{ action: 'Öppna den godkända ingången och inspektera faktiskt nådd sida. Redovisa åtkomstbehov om medlemsuppgifterna inte kan nås.', expected: 'Medlemsuppgifterna kontrolleras med egna observationer, eller lämnas uttryckligen overifierade vid saknad åtkomst.' }],
     basis: { kind: 'explicit_requirement', quote: goal, source: null } }], limitations: ['Den sparade inloggningssidan bevisar inte innehåll eller autentisering på medlemsvyn.', 'Giltig åtkomst krävs. Om den saknas ska behovet återkopplas; inga inloggningsuppgifter finns i underlaget.'] });

test('authorized original target survives discovery redirect without fabricating destination evidence', () => {
  const value = input(), proposed = draft(), result = validateMissionPlanningDraft(value, proposed);
  assert.equal(MISSION_PLANNER_VERSION, '21'); assert.equal(result.cases[0].entryUrl, target);
  assert.deepEqual(value.sources.map(s => s.url), [login]); assert.deepEqual(result, proposed);
  assert.equal(result.cases[0].basis.source, null); assert.equal(result.cases[0].basis.quote, goal);
  assert.ok(!('outcome' in result.cases[0])); assert.ok(!('authenticated' in result.cases[0]));
});
test('observed entries stay allowed while other same-origin guesses remain denied', () => {
  for (const entry of [login, origin + '/contact']) assert.equal(validateMissionPlanningDraft(input(), draft(entry)).cases[0].entryUrl, entry);
  for (const entry of [origin + '/settings', target + '/private', target + '?admin=1', target + '#unknown', 'https://other.example.test/membership']) {
    assert.throws(() => validateMissionPlanningDraft(input(), draft(entry)), e => e.diagnostic?.code === 'entry_url_unobserved');
  }
});
test('an approved-looking target outside the mandate origins cannot become an entry', () => {
  const value = input(); value.target.url = 'https://foreign.example.test/membership';
  assert.throws(() => validateMissionPlanningDraft(value, draft(value.target.url)), e => e.diagnostic?.code === 'entry_url_unobserved');
  assert.equal(validateMissionPlanningDraft(value, draft(login)).cases[0].entryUrl, login, 'Allowed observed entry is still independently constrained');
});
test('normalization binds back to exact authorized target without inventing aliases or credentials', () => {
  const value = input(); value.target.url = 'https://MEMBER.example.test:443/membership';
  assert.equal(validateMissionPlanningDraft(value, draft(target)).cases[0].entryUrl, value.target.url);
  for (const entry of ['http://member.example.test/membership', 'https://user:secret@member.example.test/membership', origin + '/Membership']) assert.throws(() => validateMissionPlanningDraft(value, draft(entry)));
});
test('target permission never relaxes source provenance, literal requirement or case/step constraints', () => {
  const sourceMismatch = draft(); sourceMismatch.cases[0].basis = { kind: 'exploratory', quote: '', source: { itemId: sourceId, version: 2 } };
  assert.throws(() => validateMissionPlanningDraft(input(), sourceMismatch), e => e.diagnostic?.code === 'source_reference_invalid');
  const quoteMismatch = draft(); quoteMismatch.cases[0].basis.quote = 'Invented requirement';
  assert.throws(() => validateMissionPlanningDraft(input(), quoteMismatch), e => e.diagnostic?.code === 'explicit_requirement_invalid');
  const tooMany = draft(); tooMany.cases = Array.from({ length: 5 }, (_, i) => ({ ...draft().cases[0], title: 'Fall ' + i }));
  assert.throws(() => validateMissionPlanningDraft(input(), tooMany), e => e.diagnostic?.code === 'plan_case_budget');
});
test('installed SDK gets the original approved target and redirected source separately, with explicit access limitation preserved', async () => {
  const value = input(), proposed = draft(), requests = [];
  process.env.GRUNDEN_API_TOKEN = 'synthetic-only'; process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS = '0';
  globalThis.fetch = async (destination, options) => {
    assert.equal(String(destination), 'https://api.grunden.ai/v1/chat/completions'); requests.push(JSON.parse(options.body));
    return Response.json({ id: 'synthetic-target', created: 0, model: 'glm-5.3-flash', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(proposed) }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 30 } });
  };
  const result = await planMission(value);
  assert.equal(requests.length, 1); assert.equal(result.usage.provider.providerCalls, 1); assert.deepEqual(result.draft, proposed);
  assert.equal(requests[0].reasoning_effort, 'high'); assert.equal(requests[0].max_tokens, 12000);
  assert.deepEqual(JSON.parse(requests[0].messages.find(m => m.role === 'user').content), value);
  const instructions = requests[0].messages.find(m => m.role === 'system').content;
  assert.match(instructions, /omdirigering vid discovery tar inte bort uppdragets godkända ingång/);
  assert.match(instructions, /inte bevis för innehåll, kontroller eller inloggning/);
  assert.match(instructions, /utan att hitta på inloggningsuppgifter, anta autentisering/);
  assert.ok(!requests[0].tools?.length); assert.equal(expectedFromSteps(result.draft.cases[0]), expectedFromSteps(proposed.cases[0]));
});
test('bounded repair reminder uses the same approved-target permission and preserves original requirements', async () => {
  const value = input(), proposed = draft(), requests = [];
  process.env.GRUNDEN_API_TOKEN = 'synthetic-only'; process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS = '0';
  globalThis.fetch = async (destination, options) => {
    assert.equal(String(destination), 'https://api.grunden.ai/v1/chat/completions'); requests.push(JSON.parse(options.body));
    return Response.json({ id: 'synthetic-target-repair', created: 0, model: 'glm-5.3-flash', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(proposed) }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 30 } });
  };
  const result = await planMission(value, undefined, 100000, undefined, { version: 1, code: 'output_missing' });
  assert.equal(requests.length, 1); assert.deepEqual(result.draft, proposed);
  assert.deepEqual(JSON.parse(requests[0].messages.find(m => m.role === 'user').content), value);
  assert.match(requests[0].messages.find(m => m.role === 'system').content, /Adresser ska vara uppdragets godkända target.url eller källans sparade URL:er inom allowedOrigins/);
});
