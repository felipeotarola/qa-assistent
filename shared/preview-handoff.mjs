import { createHash } from 'node:crypto';
import { canonicalExecutionPayload, missionExecution } from './mission-execution.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fail = () => { throw new Error('Invalid preview handoff binding'); };
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
}

export function previewPolicy(value, port) {
  exact(value, ['version', 'allowedOrigins', 'readOnly', 'deadlineAt']);
  if (value.version !== 1 || value.readOnly !== true || !instant(value.deadlineAt)
    || !Array.isArray(value.allowedOrigins) || value.allowedOrigins.length !== 1) fail();
  const url = new URL(value.allowedOrigins[0]);
  if (url.origin !== value.allowedOrigins[0] || url.protocol !== 'http:' || !/^172\.30\.0\.\d{1,3}$/.test(url.hostname)
    || Number(url.hostname.split('.').at(-1)) <= 1 || Number(url.hostname.split('.').at(-1)) >= 255
    || Number(url.port) !== port || url.username || url.password) fail();
  return { version: 1, allowedOrigins: [...value.allowedOrigins], readOnly: true, deadlineAt: value.deadlineAt };
}

export function previewEnvironment(value) {
  exact(value, ['jobId', 'planHash', 'processId']);
  if (!uuid(value.jobId) || !uuid(value.processId) || !digest(value.planHash)) fail();
  return { ...value };
}

/** An authorization transition on an existing preview, never a creation request.
 * The physical policy belongs to creation and may outlive a shorter attempt.
 * Only the current execution is shortened; no policy or origin is replaced. */
export function previewHandoff(value) {
  exact(value, ['version', 'handoffId', 'sandboxId', 'sessionId', 'creationRequestHash', 'previousExecution', 'execution', 'policy', 'expectedEnvironment', 'port']);
  if (value.version !== 1 || !uuid(value.handoffId) || !uuid(value.sandboxId) || !uuid(value.sessionId)
    || !digest(value.creationRequestHash) || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) fail();
  const previousExecution = missionExecution(value.previousExecution), execution = missionExecution(value.execution);
  if (['runtime', 'missionId', 'taskId', 'requestHash', 'mandateRevision', 'planRevision'].some(key => previousExecution[key] !== execution[key])
    || previousExecution.attemptId === execution.attemptId || previousExecution.dispatchId === execution.dispatchId
    || Date.parse(execution.deadlineAt) > Date.parse(previousExecution.deadlineAt)) fail();
  const policy = previewPolicy(value.policy, value.port), expectedEnvironment = previewEnvironment(value.expectedEnvironment);
  if (Date.parse(execution.deadlineAt) > Date.parse(policy.deadlineAt)) fail();
  return { version: 1, handoffId: value.handoffId, sandboxId: value.sandboxId, sessionId: value.sessionId,
    creationRequestHash: value.creationRequestHash, previousExecution, execution, policy, expectedEnvironment, port: value.port };
}

export const previewHandoffHash = value => createHash('sha256').update(canonicalExecutionPayload(previewHandoff(value))).digest('hex');

export function previewHandoffReceipt(value) {
  exact(value, ['version', 'handoffId', 'requestHash', 'creationRequestHash', 'sandboxId', 'sessionId', 'policyDigest', 'attemptId', 'dispatchId', 'controlEpoch', 'observedAt']);
  if (value.version !== 1 || ['handoffId', 'sandboxId', 'sessionId', 'attemptId', 'dispatchId'].some(key => !uuid(value[key]))
    || ['requestHash', 'creationRequestHash', 'policyDigest'].some(key => !digest(value[key]))
    || !Number.isSafeInteger(value.controlEpoch) || value.controlEpoch < 1 || !instant(value.observedAt)) fail();
  return { ...value };
}

export function matchPreviewHandoffReceipt(raw, input, policyDigest) {
  const receipt = previewHandoffReceipt(raw), handoff = previewHandoff(input);
  if (receipt.requestHash !== previewHandoffHash(handoff) || receipt.creationRequestHash !== handoff.creationRequestHash
    || receipt.handoffId !== handoff.handoffId || receipt.sandboxId !== handoff.sandboxId || receipt.sessionId !== handoff.sessionId
    || receipt.attemptId !== handoff.execution.attemptId || receipt.dispatchId !== handoff.execution.dispatchId
    || receipt.policyDigest !== policyDigest || Date.parse(receipt.observedAt) >= Date.parse(handoff.execution.deadlineAt)) fail();
  return receipt;
}
