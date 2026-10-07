import assert from 'node:assert/strict';
import { repoPrompt } from './repo-benchmark-contract.mjs';

export function assertPreparationSource(protocol, sourceSha256) {
  assert.match(protocol.sourceSha256, /^[a-f0-9]{64}$/, 'Preparation must bind an exact authored snapshot');
  assert.equal(sourceSha256, protocol.sourceSha256, 'Preparation authored snapshot changed');
}

/** Preparation is a separately measured, ordinarily cancelled QA assignment.
 * It does not pretend the product has a preparation-only execution mandate. */
export const consentPreparationPrompt = repo => repoPrompt('REPO-11', repo);

export function assertEmptyPreparationWorkspace(state) {
  for (const field of ['setups', 'consents', 'vault', 'activeMissions', 'claims']) {
    assert.ok(Array.isArray(state[field]), `Missing preparation baseline: ${field}`);
    assert.equal(state[field].length, 0, `Preparation workspace already contains ${field}`);
  }
}

/** Read-only predicate over actual saved rows. No synthetic wait, cancellation,
 * controller advancement or creation of an execution/consent receipt. */
export function observedConfigurationWait(state, { runtime, repo, names, now = Date.now() }) {
  assert.equal(state.runs.length, 0, 'Preparation unexpectedly ran functional tests');
  assert.equal(state.jobs.length, 0, 'Preparation unexpectedly dispatched a browser');
  assert.equal(state.browsers.length, 0, 'Preparation unexpectedly allocated a browser');
  assert.ok(!state.attempts.some(x => ['preview_discovery', 'browser_tests', 'repository_check'].includes(x.kind)), 'Preparation unexpectedly dispatched testing or preview');
  assert.ok(!state.setups.some(x => x.autonomy?.environmentExecution?.phase === 'apply'), 'Preparation unexpectedly applied credentials or started the app');
  assert.ok(!state.repositories.some(x => x.config?.mode === 'test'), 'Preparation unexpectedly ran repository tests');
  assert.ok(state.missions.length <= 1, 'Preparation created multiple missions');
  if (!state.missions.length) return null;
  const mission = state.missions[0];
  assert.equal(mission.runtime, runtime);
  const prepared = state.setups.filter(x => x.autonomy?.environmentExecution?.phase === 'prepare'
    && ['needs_configuration', 'completed'].includes(x.status) && x.result?.cleanup === 'confirmed' && x.result.executorStopped === true);
  assert.ok(prepared.length <= 1, 'Preparation produced multiple verified setup receipts');
  if (!prepared.length) return null;
  const setup = prepared[0], execution = setup.autonomy.execution, environment = setup.result.environment;
  assert.equal(setup.runtime, runtime); assert.equal(execution?.missionId, mission.id);
  assert.equal(execution.dispatchId, setup.id); assert.equal(execution.runtime, runtime);
  assert.equal(environment?.repoUrl, repo.url); assert.equal(environment?.commit, repo.commit); assert.equal(environment?.probeKind, 'identity');
  assert.deepEqual(environment.variables.filter(x => x.required).map(x => x.name).sort(), [...names].sort(), 'The configured fixture must require its exact configuration names');
  const waits = state.waits.filter(x => x.state === 'waiting' && x.definition?.reason === 'configuration' && x.definition.setupJobId === setup.id);
  assert.ok(waits.length <= 1, 'Preparation has conflicting configuration waits');
  if (!waits.length) return null;
  const originalTask = state.tasks.find(x => x.id === execution.taskId);
  assert.ok(originalTask?.state === 'completed' && originalTask.spec?.kind === 'environment_setup' && originalTask.spec.phase === 'prepare', 'Preparation task is not committed completed');
  assert.ok(state.attempts.some(x => x.id === execution.attemptId && x.task_id === execution.taskId && x.dispatch_id === setup.id && x.status === 'completed'), 'Preparation attempt is not committed completed');
  const wait = waits[0], ids = wait.definition.taskIds;
  assert.equal(wait.definition.mandateRevision, execution.mandateRevision); assert.equal(wait.definition.planRevision, execution.planRevision);
  assert.equal(ids.length, 1, 'Configuration wait must bind exactly one apply task');
  assert.ok(Number.isFinite(Date.parse(wait.deadline_at)) && Date.parse(wait.deadline_at) > now, 'Configuration wait is no longer actionable');
  const apply = state.tasks.find(x => x.id === ids[0]);
  assert.ok(apply?.state === 'waiting' && apply.spec?.kind === 'environment_setup' && apply.spec.phase === 'apply'
    && apply.spec.sourceSetupJobId === setup.id && apply.spec.repoUrl === repo.url && apply.spec.expectedCommit === repo.commit,
  'Configuration wait does not bind the original saved start plan');
  assert.ok(!state.attempts.some(x => x.task_id === apply.id), 'Apply was reserved before ordinary cancellation');
  assert.ok(['running', 'waiting'].includes(mission.lifecycle), 'Configuration wait belongs to a terminal or paused mission');
  return { setup, mission, wait, apply };
}
