export interface ExecutionEvent<T = unknown> {
  version: 1;
  executionId: string;
  kind: 'repository' | 'browser' | 'sandbox';
  seq: number;
  at: string;
  type: string;
  snapshot: T;
}
export interface ExecutionTelemetry {
  workerId: string;
  heartbeatAt: string;
  startedAt?: string;
  phaseStartedAt: string;
  queuePosition?: number;
  cancellationRequested?: boolean;
  operationKind?: 'test' | 'static-check' | 'inspect' | 'build';
  failureKind?: 'runtime' | 'checkout' | 'configuration' | 'dependencies' | 'command' | 'timeout' | 'interrupted' | 'cleanup';
}
