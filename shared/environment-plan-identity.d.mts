export interface EnvironmentConsentPlan {
  version: 1; repoUrl: string; root: string; directory: string; commit: string;
  command: string; port: number; variables: { name: string; required: boolean }[];
  executionProfile?: EnvironmentExecutionProfile;
}
export interface EnvironmentExecutionProfile {
  version: 1; runtime: 'node24'; imageDigest: string; packageManager: 'npm' | 'pnpm';
  packageManagerVersion: string; installDirectory: string; lockfile: 'package-lock.json' | 'pnpm-lock.yaml';
  lockfileSha256: string; ignoreScripts: true;
}
export function environmentPlanIdentity(value: unknown): EnvironmentConsentPlan;
export function canonicalEnvironmentPlan(value: unknown): string;
