import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { missionPlanningInputSchema, missionPlanningDraftSchema, validateMissionPlanningDraft, plannedTestCase, DEFAULT_NEW_MISSION_CASES } from '../shared/mission-planning.ts';
import { testCaseSchema, renderTestPlan } from '../shared/test-plan.ts';
import { runChecks } from '../shared/test-run.ts';
const expectedFromSteps = value => value.steps.map((step, index) => `${index + 1}. ${step.expected}`).join('\n');

const sourceId = randomUUID(), url = 'https://planning.example.test/';
const input = () => ({ schemaVersion: 1, goal: 'Kontrollera att sökningen visar recept', intent: 'explore', target: { environment: 'Publik webb', url, revision: '' }, allowedOrigins: [new URL(url).origin], browserExecution: { version: 1, readOnly: true, agentHttpMethods: ['GET', 'HEAD', 'OPTIONS'], authenticationControls: 'inspect-only', authenticationAccess: 'human-takeover' }, maxCases: DEFAULT_NEW_MISSION_CASES,
  sources: [{ itemId: sourceId, version: 1, sourceHash: 'a'.repeat(64), url, title: 'Recept', text: 'Sök recept', links: [{ url: `${url}recept`, label: 'Recept' }], limited: false }], selectedCases: [], limitations: [] });
const draft = () => ({ schemaVersion: 1, title: 'Testplan', summary: 'Planera sparade observationer.', cases: [{ title: 'Receptsök', entryUrl: url, steps: [{ action: 'Öppna den observerade sökningen.', expected: 'Sökfält visas.' }],  basis: { kind: 'exploratory', quote: '', source: { itemId: sourceId, version: 1 } } }], limitations: [] });

test('bounded draft becomes ordinary test plan with explicit checkpoint expectations', () => {
  const candidate = validateMissionPlanningDraft(missionPlanningInputSchema.parse(input()), draft()), converted = plannedTestCase(candidate.cases[0], randomUUID());
  assert.equal(converted.type, 'browser'); assert.equal(converted.basis.kind, 'exploratory');
  assert.equal(runChecks(converted).length, 2); assert.ok(converted.steps.includes(url)); assert.ok(converted.steps.includes('Förväntat: Sökfält visas.'));
  assert.match(renderTestPlan('Test', { kind: 'test_plan', summary: '', cases: [converted], sources: [] }, 1), /Utforskande hypotes/);
});
test('explicit requirements quote the goal exactly; page claims never become requirements', () => {
  const candidate = draft(); candidate.cases[0].basis = { kind: 'explicit_requirement', quote: 'sökningen visar recept', source: null };
  assert.doesNotThrow(() => validateMissionPlanningDraft(input(), candidate));
  for (const basis of [{ kind: 'explicit_requirement', quote: '', source: null }, { kind: 'explicit_requirement', quote: 'Marknadsledande sökning', source: null }, { kind: 'explicit_requirement', quote: input().goal, source: { itemId: sourceId, version: 1 } }]) {
    assert.throws(() => validateMissionPlanningDraft(input(), { ...candidate, cases: [{ ...candidate.cases[0], basis }] }));
  }
});
test('observed in-scope entry and exact source version are mandatory', () => {
  for (const entryUrl of [`${url}invented`, 'https://outside.example.test/', 'https://user:pass@planning.example.test/']) assert.throws(() => validateMissionPlanningDraft(input(), { ...draft(), cases: [{ ...draft().cases[0], entryUrl }] }));
  const foreign = input(); foreign.sources[0].links.push({ url: 'https://outside.example.test/', label: 'External' });
  assert.throws(() => validateMissionPlanningDraft(foreign, { ...draft(), cases: [{ ...draft().cases[0], entryUrl: 'https://outside.example.test/' }] }));
  assert.throws(() => validateMissionPlanningDraft(input(), { ...draft(), cases: [{ ...draft().cases[0], basis: { kind: 'exploratory', quote: '', source: { itemId: sourceId, version: 2 } } }] }));
});
test('limits cap generated cases, steps, duplicate names and context', () => {
  const candidate = draft(); candidate.cases = Array.from({ length: 5 }, (_, i) => ({ ...draft().cases[0], title: `Test ${i}` }));
  assert.throws(() => validateMissionPlanningDraft(input(), candidate));
  candidate.cases = [0, 1, 2].map(i => ({ ...draft().cases[0], title: `Test ${i}`, steps: Array.from({ length: 9 }, () => draft().cases[0].steps[0]) }));
  assert.throws(() => validateMissionPlanningDraft(input(), candidate));
  assert.throws(() => validateMissionPlanningDraft(input(), { ...draft(), cases: [draft().cases[0], draft().cases[0]] }));
  assert.equal(missionPlanningInputSchema.safeParse({ ...input(), sources: [{ ...input().sources[0], text: 'x'.repeat(12001) }] }).success, false);
  assert.equal(missionPlanningDraftSchema.safeParse({ ...draft(), tool: 'browser', outcome: 'passed' }).success, false);
});
test('selected cases cannot be rewritten or replaced and absent research does not invent tests', () => {
  const selected = input(); selected.selectedCases = [{ key: `${randomUUID()}:${randomUUID()}`, version: 1, sourceHash: 'a', testCase: testCaseSchema.parse({ id: randomUUID(), title: 'Original', type: 'manual', expected: 'Original requirement' }) }];
  assert.throws(() => validateMissionPlanningDraft(selected, draft()));
  assert.throws(() => validateMissionPlanningDraft({ ...input(), sources: [] }, draft()));
  assert.ok(!('basis' in selected.selectedCases[0].testCase));
  assert.equal(missionPlanningInputSchema.safeParse({ ...input(), intent: 'report_only' }).success, false);
});



test('no-generated preconditions rejects obsolete fields, including empty and exact goal quotes, without erasing drafts', () => {
  const value = input();
  for (const preconditions of ['', value.goal, 'Skriv vad du behöver om åtkomst nekas.', 'Sessionen måste vara ren.']) {
    const proposed = draft(); proposed.cases[0].preconditions = preconditions;
    const original = structuredClone(proposed);
    assert.throws(() => validateMissionPlanningDraft(value, proposed), error => error.diagnostic?.code === 'output_schema_invalid');
    assert.deepEqual(proposed, original);
  }
  const proposed = draft(); proposed.cases[0].executionNotes = 'Unknown substitute field';
  assert.equal(missionPlanningDraftSchema.safeParse(proposed).success, false);
});

test('no-generated preconditions preserves explicit session, identity and permitted-data conditions in executable checks', () => {
  for (const condition of ['en separat ren session utan tidigare cookies', 'en verifierat inloggad session',
    'den identifierade testanvändarens egna uppgifter', 'endast de angivna syntetiska testuppgifterna']) {
    const value = input(), proposed = draft();
    value.goal = 'Kontrollera innehållet med ' + condition + '.';
    const requirement = 'Innehållet visas med ' + condition + '; okänt villkor är overifierat.';
    proposed.cases[0].steps = [{ action: 'Fastställ ' + condition + ' inom mandatet och inspektera innehållet.', expected: requirement }];

    proposed.cases[0].basis = { kind: 'explicit_requirement', quote: value.goal, source: null };
    const original = structuredClone(proposed), originalInput = structuredClone(value);
    const accepted = validateMissionPlanningDraft(value, proposed), frozen = plannedTestCase(accepted.cases[0], randomUUID());
    assert.deepEqual(proposed, original); assert.deepEqual(value, originalInput);
    assert.equal(frozen.preconditions, '');
    assert.deepEqual(runChecks(frozen), [
      { id: 'step-1', requirement: '1. Utgå från ' + url + '. ' + proposed.cases[0].steps[0].action + ' Förväntat: ' + requirement },
      { id: 'expected', requirement: '1. ' + requirement },
    ]);
    assert.equal(frozen.basis.quote, value.goal);
    assert.ok(!('outcome' in frozen));
  }
});

test('no-generated preconditions retains context without a duplicate goal or reporting-duty check', () => {
  const value = input(), proposed = draft();
  value.goal = 'Visa sidans innehåll. Skriv vad som behövs om åtkomst nekas.';
  proposed.cases[0].steps = [{ action: 'Inspektera sidans innehåll eller den faktiska åtkomstspärren.', expected: 'Innehållet visas; kvarstående spärr lämnar kravet overifierat med konkret förklaring.' }];

  proposed.limitations = ['Tillgänglig åtkomst är okänd; en verklig spärr ska redovisas för originalkravet.'];
  const accepted = validateMissionPlanningDraft(value, proposed);
  assert.deepEqual(accepted.limitations, proposed.limitations);
  assert.equal('preconditions' in accepted.cases[0], false);
  const frozen = plannedTestCase(accepted.cases[0], randomUUID()), checks = runChecks(frozen);
  assert.equal(frozen.preconditions, '');
  assert.deepEqual(checks.map(check => check.id), ['step-1', 'expected']);
  assert.equal(checks.at(-1).requirement, expectedFromSteps(proposed.cases[0]));
  assert.ok(!checks.some(check => check.requirement === value.goal || check.requirement === proposed.limitations[0]));
});

test('no-generated preconditions leaves selected original plan requirements immutable and outside generation', () => {
  const value = input(), originalCase = testCaseSchema.parse({ id: randomUUID(), title: 'Original access contract',
    type: 'browser', preconditions: 'Original manually approved condition not present in the new goal.',
    steps: '1. Original action', expected: 'Original result' });
  value.selectedCases = [{ key: 'original:case', version: 7, sourceHash: 'a'.repeat(64), testCase: originalCase }];
  const before = structuredClone(value);
  assert.throws(() => validateMissionPlanningDraft(value, draft()), error => error.diagnostic?.code === 'input_not_plannable');
  assert.deepEqual(value, before);
  assert.equal(runChecks(originalCase)[0].id, 'preconditions');
  assert.equal(runChecks(originalCase)[0].requirement, originalCase.preconditions);
});
