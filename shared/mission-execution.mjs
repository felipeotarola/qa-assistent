// Wire contract shared by the app and its separately deployed Linux executors.
// This is an authority reference, never credentials or an executable instruction.
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const keys = ['version', 'runtime', 'missionId', 'taskId', 'attemptId', 'dispatchId', 'mandateRevision', 'planRevision', 'requestHash', 'deadlineAt'];
const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function canonicalExecutionPayload(value) {
  const canonical = input => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(canonical);
    if (object(input)) return Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])]));
    throw new Error('Invalid execution payload');
  };
  return JSON.stringify(canonical(value));
}
export function missionExecution(value) {
  if (!object(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid execution binding');
  if (value.version !== 1 || typeof value.runtime !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(value.runtime)) throw new Error('Invalid execution version or runtime');
  for (const key of ['missionId', 'taskId', 'attemptId', 'dispatchId']) if (typeof value[key] !== 'string' || !uuid.test(value[key])) throw new Error('Invalid execution identity');
  for (const key of ['mandateRevision', 'planRevision']) if (!Number.isSafeInteger(value[key]) || value[key] < 1) throw new Error('Invalid execution revision');
  if (typeof value.requestHash !== 'string' || !hash.test(value.requestHash)) throw new Error('Invalid execution request hash');
  if (typeof value.deadlineAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.deadlineAt) || !Number.isFinite(Date.parse(value.deadlineAt)) || new Date(value.deadlineAt).toISOString() !== value.deadlineAt) throw new Error('Invalid execution deadline');
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}
export const executionOperationKinds = Object.freeze(['repository.inspect', 'repository.test', 'repository.command', 'sandbox.ensure', 'sandbox.command', 'codex.initialize', 'codex.turn', 'codex.tool', 'environment.preview']);
export function executionAdmission(value) {
  const fields = ['execution', 'resourceId', 'operationId', 'kind', 'payloadHash'];
  if (!object(value) || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) throw new Error('Invalid executor admission');
  if (typeof value.resourceId !== 'string' || !uuid.test(value.resourceId) || typeof value.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(value.operationId) || !executionOperationKinds.includes(value.kind) || typeof value.payloadHash !== 'string' || !hash.test(value.payloadHash)) throw new Error('Invalid executor operation identity');
  return { execution: missionExecution(value.execution), resourceId: value.resourceId, operationId: value.operationId, kind: value.kind, payloadHash: value.payloadHash };
}
