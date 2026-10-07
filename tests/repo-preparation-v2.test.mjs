import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertEmptyPreparationWorkspace, consentPreparationPrompt, observedConfigurationWait, assertPreparationSource } from './helpers/repo-prepare-consent-protocol.mjs';

test('preparation manifest binds an exact authored snapshot before any model or API write', () => {
  const sha = 'a'.repeat(64);
  assert.doesNotThrow(() => assertPreparationSource({ sourceSha256: sha }, sha));
  assert.throws(() => assertPreparationSource({}, sha));
  assert.throws(() => assertPreparationSource({ sourceSha256: sha }, 'b'.repeat(64)));
});

function ready() {
  const runtime = 'autonomy-test:preparation-v2', repo = { url: 'https://github.com/syna-autonomy-fixture/configured', commit: 'b'.repeat(40) };
  const names = ['SERVICE_BASE_URL', 'SERVICE_ACCESS_TOKEN'], missionId = randomUUID(), taskId = randomUUID(), attemptId = randomUUID(), setupId = randomUUID(), applyId = randomUUID();
  const now = Date.parse('2026-10-06T12:00:00Z');
  const setup = { id: setupId, runtime, status: 'needs_configuration', autonomy: {
    execution: { missionId, taskId, attemptId, dispatchId: setupId, runtime, mandateRevision: 1, planRevision: 1 }, environmentExecution: { phase: 'prepare' },
  }, result: { cleanup: 'confirmed', executorStopped: true, environment: { repoUrl: repo.url, commit: repo.commit, probeKind: 'identity', variables: names.map(name => ({ name, required: true })) } } };
  const state = { missions: [{ id: missionId, runtime, lifecycle: 'waiting' }], setups: [setup],
    tasks: [{ id: taskId, state: 'completed', spec: { kind: 'environment_setup', phase: 'prepare' } },
      { id: applyId, state: 'waiting', spec: { kind: 'environment_setup', phase: 'apply', sourceSetupJobId: setupId, repoUrl: repo.url, expectedCommit: repo.commit } }],
    attempts: [{ id: attemptId, task_id: taskId, dispatch_id: setupId, status: 'completed', kind: 'environment_setup' }],
    waits: [{ id: randomUUID(), state: 'waiting', deadline_at: new Date(now + 60000), definition: { reason: 'configuration', setupJobId: setupId, taskIds: [applyId], mandateRevision: 1, planRevision: 1 } }],
    jobs: [], browsers: [], runs: [], repositories: [] };
  return { state, context: { runtime, repo, names, now } };
}

test('v2 requests ordinary app QA, without pretending that values exist or that a preparation-only mandate exists', () => {
  const { context } = ready(), prompt = consentPreparationPrompt(context.repo);
  assert.ok(prompt.includes(context.repo.url) && prompt.includes(context.repo.commit));
  assert.match(prompt, /Starta .*kontrollera startsidan och huvudnavigeringen.*rapport/);
  assert.doesNotMatch(prompt, /redan sparat|Starta inte|qa_mission|Otto|Iris|consentId/);
});
test('fresh preparation requires empty saved values, grants, jobs, missions and claims', () => {
  const empty = { setups: [], consents: [], vault: [], activeMissions: [], claims: [] };
  assert.doesNotThrow(() => assertEmptyPreparationWorkspace(empty));
  for (const field of Object.keys(empty)) {
    assert.throws(() => assertEmptyPreparationWorkspace({ ...empty, [field]: [{}] }), /already contains/);
    const incomplete = { ...empty }; delete incomplete[field];
    assert.throws(() => assertEmptyPreparationWorkspace(incomplete), /Missing/);
  }
});
test('a stopped preparation receipt alone does not synthesize a configuration wait', () => {
  const { state, context } = ready(); state.waits = []; state.tasks[0].state = 'running'; state.attempts[0].status = 'running';
  assert.equal(observedConfigurationWait(state, context), null);
});
test('actual committed wait returns the original setup, mission and waiting apply identity', () => {
  const { state, context } = ready(), result = observedConfigurationWait(state, context);
  assert.equal(result.setup, state.setups[0]); assert.equal(result.wait, state.waits[0]); assert.equal(result.apply, state.tasks[1]); assert.equal(result.mission, state.missions[0]);
});
test('foreign setup bindings, runtime, repository or version do not authorize cancellation/grant preparation', () => {
  for (const alter of [
    x => x.setups[0].autonomy.execution.missionId = randomUUID(), x => x.setups[0].autonomy.execution.dispatchId = randomUUID(),
    x => x.setups[0].autonomy.execution.runtime = 'autonomy-test:other', x => x.setups[0].runtime = 'autonomy-test:other',
    x => x.setups[0].result.environment.commit = 'c'.repeat(40), x => x.setups[0].result.environment.repoUrl = 'https://github.com/other/app',
  ]) { const { state, context } = ready(); alter(state); assert.throws(() => observedConfigurationWait(state, context)); }
});
test('a wait cannot cover an unfinished original task or uncommitted attempt', () => {
  for (const alter of [x => x.tasks[0].state = 'running', x => x.attempts[0].status = 'running', x => x.attempts[0].dispatch_id = randomUUID()]) {
    const { state, context } = ready(); alter(state); assert.throws(() => observedConfigurationWait(state, context), /not committed/);
  }
});
test('wait/apply relationship and current epoch are checked before ordinary user cancellation', () => {
  for (const alter of [x => x.tasks[1].spec.sourceSetupJobId = randomUUID(), x => x.tasks[1].state = 'pending',
    x => x.tasks[1].spec.expectedCommit = 'c'.repeat(40), x => x.waits[0].definition.taskIds = [randomUUID()],
    x => x.waits[0].definition.mandateRevision++, x => x.waits[0].definition.planRevision++,
    x => x.waits[0].deadline_at = null, x => x.waits[0].deadline_at = new Date('2020-01-01'), x => x.missions[0].lifecycle = 'closed',
  ]) { const { state, context } = ready(); alter(state); assert.throws(() => observedConfigurationWait(state, context)); }
});
test('premature apply reservation, application startup, browser or test work fails rather than being adopted', () => {
  for (const alter of [
    x => x.attempts.push({ task_id: x.tasks[1].id, kind: 'environment_setup' }),
    x => x.setups.push({ autonomy: { environmentExecution: { phase: 'apply' } } }),
    x => x.jobs.push({}), x => x.browsers.push({}), x => x.runs.push({}),
    x => x.attempts.push({ kind: 'preview_discovery' }), x => x.attempts.push({ kind: 'browser_tests' }),
    x => x.repositories.push({ config: { mode: 'test' } }),
  ]) { const { state, context } = ready(); alter(state); assert.throws(() => observedConfigurationWait(state, context)); }
});
test('the configured fixture cannot be mistaken for a keyless or differently configured app', () => {
  for (const variables of [[], [{ name: 'OPTIONAL', required: false }], [{ name: 'WRONG', required: true }]]) {
    const { state, context } = ready(); state.setups[0].result.environment.variables = variables;
    assert.throws(() => observedConfigurationWait(state, context), /exact configuration names/);
  }
});
test('duplicate preparations or waits never collapse into an arbitrary first match', () => {
  for (const alter of [x => x.setups.push(structuredClone(x.setups[0])), x => x.waits.push(structuredClone(x.waits[0])), x => x.missions.push(structuredClone(x.missions[0]))]) {
    const { state, context } = ready(); alter(state); assert.throws(() => observedConfigurationWait(state, context), /multiple|conflicting/);
  }
});
