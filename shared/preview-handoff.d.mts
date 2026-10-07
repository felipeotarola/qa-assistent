import type { MissionExecution } from './mission-execution.mjs';
export type PreviewPolicy = { version: 1; allowedOrigins: string[]; readOnly: true; deadlineAt: string };
export type PreviewEnvironment = { jobId: string; planHash: string; processId: string };
export type PreviewHandoff = {
  version: 1; handoffId: string; sandboxId: string; sessionId: string; creationRequestHash: string;
  previousExecution: MissionExecution; execution: MissionExecution; policy: PreviewPolicy; expectedEnvironment: PreviewEnvironment; port: number;
};
export type PreviewHandoffReceipt = {
  version: 1; handoffId: string; requestHash: string; creationRequestHash: string; sandboxId: string; sessionId: string;
  policyDigest: string; attemptId: string; dispatchId: string; controlEpoch: number; observedAt: string;
};
export function previewPolicy(value: unknown, port: number): PreviewPolicy;
export function previewEnvironment(value: unknown): PreviewEnvironment;
export function previewHandoff(value: unknown): PreviewHandoff;
export function previewHandoffHash(value: unknown): string;
export function previewHandoffReceipt(value: unknown): PreviewHandoffReceipt;
export function matchPreviewHandoffReceipt(raw: unknown, input: unknown, policyDigest: string): PreviewHandoffReceipt;
