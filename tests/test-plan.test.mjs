import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testPlanSchema, caseReady, newTestCase, renderTestPlan, planSection, updatePlanSection } from '../shared/test-plan.ts';
import { contentSchema } from '../shared/workspace.ts';
import { testPlanFromItem } from '../shared/test-plan-conversion.ts';

test('conversion preserves source, ignores past results and marks incomplete cases', () => {
  const item = { id: randomUUID(), version: 3, title: 'Login', content: { kind: 'table', columns: ['Test', 'Steg', 'Förväntat resultat', 'Status'], rows: [['Maskering', 'Öppna login', 'Maskerat', 'Godkänt'], ['Loggar', '', '', 'Godkänt']] } };
  const original = JSON.stringify(item);
  const plan = contentSchema.parse(testPlanFromItem(item));
  assert.equal(plan.kind, 'test_plan');
  assert.equal(JSON.stringify(item), original);
  assert.deepEqual(plan.sources, [{ itemId: item.id, version: 3 }]);
  assert.equal(caseReady(plan.cases[0]), true);
  assert.equal(caseReady(plan.cases[1]), false);
  assert.equal('status' in plan.cases[0], false);
  assert.notEqual(plan.cases[0].id, plan.cases[1].id);
});
test('URL inventory stays a source without inventing executable tests', () => {
  const plan = testPlanFromItem({ id: randomUUID(), title: 'Sidor', version: 1, content: { kind: 'table', columns: ['URL', 'Titel'], rows: [['https://example.com', 'Home']] } });
  assert.equal(plan.cases.length, 0);
  assert.equal(plan.sources.length, 1);
});
test('duplicate case IDs rejected; incomplete drafts can be saved', () => {
  const draft = { kind: 'test_plan', cases: [newTestCase()] };
  assert.equal(testPlanSchema.safeParse(draft).success, true);
  draft.cases.push(draft.cases[0]);
  assert.equal(testPlanSchema.safeParse(draft).success, false);
});
test('publication updates only the managed section and never claims execution', () => {
  const id = randomUUID();
  const plan = testPlanSchema.parse({ kind: 'test_plan', cases: [newTestCase()] });
  const markdown = renderTestPlan('Login', plan, 2);
  assert.match(markdown, /inte ett testresultat/);
  const old = 'Human notes\n\n' + planSection(id, 'Old plan') + '\n\nOther work';
  const updated = updatePlanSection(old, id, markdown);
  assert.ok(updated.startsWith('Human notes\n\n'));
  assert.ok(updated.endsWith('\n\nOther work'));
  assert.equal(updatePlanSection(updated, id, markdown), updated);
  assert.throws(() => updatePlanSection(`Testplan-ID: ${id} — början broken`, id, markdown));
  assert.throws(() => updatePlanSection('Markers removed by external editor', id, markdown));
});
