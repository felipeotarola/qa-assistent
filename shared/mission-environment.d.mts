import type { EnvironmentConsentPlan } from './environment-plan-identity.mjs';
export type MissionEnvironmentExecution =
  | { version: 1; phase: 'prepare'; repoUrl: string; commit: string; inspectedRunId: string; approvedPlan?: { plan: EnvironmentConsentPlan; planHash: string } }
  | { version: 1; phase: 'apply'; sourceSetupJobId: string; plan: EnvironmentConsentPlan; planHash: string; consent: { id: string; revision: number; vaultRevision: number } | null };
export function missionEnvironmentExecution(value: unknown): MissionEnvironmentExecution;
export function environmentPlanHash(value: unknown): string;
export function environmentRequestFingerprint(execution: unknown, task: string, environmentExecution: unknown): string;
