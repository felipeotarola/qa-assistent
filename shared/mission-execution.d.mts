export interface MissionExecution {
  version: 1
  runtime: string
  missionId: string
  taskId: string
  attemptId: string
  dispatchId: string
  mandateRevision: number
  planRevision: number
  requestHash: string
  deadlineAt: string
}
export type ExecutionOperationKind = 'repository.inspect' | 'repository.test' | 'repository.command' | 'sandbox.ensure' | 'sandbox.command' | 'codex.initialize' | 'codex.turn' | 'codex.tool' | 'environment.preview'
export interface ExecutionAdmission { execution: MissionExecution; resourceId: string; operationId: string; kind: ExecutionOperationKind; payloadHash: string }
export interface ExecutionAdmissionReceipt { allowed: true; attemptId: string; dispatchId: string; resourceId: string; operationId: string; kind: ExecutionOperationKind; payloadHash: string; validUntil: string }
export function missionExecution(value: unknown): MissionExecution
export function canonicalExecutionPayload(value: unknown): string
export function executionAdmission(value: unknown): ExecutionAdmission
export const executionOperationKinds: readonly ExecutionOperationKind[]
