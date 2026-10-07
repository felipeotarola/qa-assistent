import { createHash } from 'node:crypto';
import { environmentPlanIdentity, canonicalEnvironmentPlan } from './environment-plan-identity.mjs';
import { canonicalExecutionPayload, missionExecution } from './mission-execution.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function keys(value, names) {
  if (!object(value) || Object.keys(value).length !== names.length || Object.keys(value).some(key => !names.includes(key))) throw new Error('Invalid environment execution fields');
}
export function environmentPlanHash(plan) { return createHash('sha256').update(canonicalEnvironmentPlan(plan)).digest('hex'); }
export function environmentRequestFingerprint(execution, task, environmentExecution) {
  if (typeof task !== 'string' || !task.trim() || task.length > 12000) throw new Error('Invalid environment task');
  return createHash('sha256').update(canonicalExecutionPayload({ execution: missionExecution(execution), task, environmentExecution: missionEnvironmentExecution(environmentExecution) })).digest('hex');
}
function frozenPlan(value, hash) {
  keys(value, ['version', 'repoUrl', 'root', 'directory', 'commit', 'command', 'port', 'variables', 'executionProfile']);
  if (value.version !== 1) throw new Error('Invalid environment plan version');
  for (const variable of value.variables || []) keys(variable, ['name', 'required']);
  const plan = environmentPlanIdentity(value);
  if (hash !== environmentPlanHash(plan)) throw new Error('Environment plan hash mismatch');
  return plan;
}
export function missionEnvironmentExecution(value) {
  if (!object(value) || value.version !== 1) throw new Error('Invalid environment execution');
  if (value.phase === 'prepare') {
    keys(value, ['version', 'phase', 'repoUrl', 'commit', 'inspectedRunId', ...(Object.hasOwn(value, 'approvedPlan') ? ['approvedPlan'] : [])]);
    if (!uuid(value.inspectedRunId) || typeof value.repoUrl !== 'string' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(value.repoUrl) || value.repoUrl.split('/').some(part => ['.', '..'].includes(part)) || typeof value.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.commit)) throw new Error('Invalid inspected repository');
    let approvedPlan;
    if (Object.hasOwn(value, 'approvedPlan')) {
      keys(value.approvedPlan, ['plan', 'planHash']);
      const plan = frozenPlan(value.approvedPlan.plan, value.approvedPlan.planHash);
      if (!plan.executionProfile || plan.repoUrl !== value.repoUrl || plan.commit !== value.commit) throw new Error('Approved preparation identity mismatch');
      approvedPlan = { plan, planHash: value.approvedPlan.planHash };
    }
    return { version: 1, phase: 'prepare', repoUrl: value.repoUrl, commit: value.commit, inspectedRunId: value.inspectedRunId, ...(approvedPlan ? { approvedPlan } : {}) };
  }
  if (value.phase !== 'apply') throw new Error('Invalid environment execution phase');
  keys(value, ['version', 'phase', 'sourceSetupJobId', 'plan', 'planHash', 'consent']);
  if (!uuid(value.sourceSetupJobId)) throw new Error('Invalid source setup job');
  const plan = frozenPlan(value.plan, value.planHash);
  let consent = null;
  if (value.consent !== null) {
    keys(value.consent, ['id', 'revision', 'vaultRevision']);
    if (!uuid(value.consent.id) || !Number.isSafeInteger(value.consent.revision) || value.consent.revision < 1 || !Number.isSafeInteger(value.consent.vaultRevision) || value.consent.vaultRevision < 1) throw new Error('Invalid environment consent');
    consent = { ...value.consent };
  }
  return { version: 1, phase: 'apply', sourceSetupJobId: value.sourceSetupJobId, plan, planHash: value.planHash, consent };
}
