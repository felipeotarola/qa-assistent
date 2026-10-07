import { z } from 'zod';
import { missionBindingSchema } from './mission-binding.ts';
import type { ExecutionTelemetry } from './execution';
import { missionExecution, type MissionExecution } from './mission-execution.mjs';
export const repositoryExecutionSchema = z.unknown().transform((value, context) => {
  try { return missionExecution(value); }
  catch { context.addIssue({ code: 'custom', message: 'Invalid execution binding' }); return z.NEVER; }
});
export interface RepositoryRunConfig {
  url: string; ref: string; script: string; mode: 'inspect' | 'test'; args?: string[]; directory?: string; workspaceId?: string;
  execution?: MissionExecution; expectedCommit?: string;
}
export const repositorySchema = z.object({
  url: z.string().max(300).refine(value => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(value), 'Ange en publik GitHub repository-URL utan token.'),
  ref: z.string().max(150).regex(/^(?:[\w][\w./-]*)?$/).refine(value => !value.includes('..')).default(''),
  script: z.string().max(80).regex(/^[\w][\w:-]*$/).default('auto'),
});
export const repositoryActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('connect'), ...repositorySchema.shape }),
  z.object({ action: z.literal('start'), mission: missionBindingSchema.optional(), repositoryId: z.string().uuid(), requestId: z.string().uuid(), mode: z.enum(['inspect', 'test']), script: repositorySchema.shape.script.unwrap().optional(), directory: z.string().max(200).optional(), args: z.array(z.string().max(300)).max(20).optional() }),
  z.object({ action: z.literal('cancel'), runId: z.string().uuid() }),
]);
// Keep the provider-facing object schema and server action schema on the same
// binding contract. toolJson validates serialized nested objects as well.
export const repositoryToolInputSchema = z.object({
  action: z.enum(['list', 'connect', 'start', 'cancel']),
  url: repositorySchema.shape.url.optional(),
  ref: repositorySchema.shape.ref.optional(),
  script: repositorySchema.shape.script.unwrap().optional().describe('connect: saved default. start: override for this run, e.g. build. Omit to use the saved default; auto selects a check, never starts a server.'),
  repositoryId: z.string().uuid().optional(),
  mode: z.enum(['inspect', 'test']).optional(),
  directory: z.string().max(200).optional().describe('Project directory from inspection, e.g. apps/web. Omit to discover the root or single project.'),
  runId: z.string().uuid().optional(),
  args: z.array(z.string().max(300)).max(20).optional(),
  mission: missionBindingSchema.optional().describe('start: existing missionId and taskId for this execution. Preserve this binding on retries. Omit only for work outside a mission.'),
});
export type RepositoryAction = z.infer<typeof repositoryActionSchema>;
export interface RepoJob {
  execution?: MissionExecution;
  fingerprint?: string;
  expectedCommit?: string;
  cleanup?: { resourceId: string; confirmed: boolean; observedAt: string };
  revision?: number;
  directory?: string;
  workspaceId?: string;
  projects?: { directory: string; kind: string }[];
  plan?: { directory: string; runtime: string; operationKind: string; selectedScript: string; install: string[][]; command: string[] } | null;
  telemetry?: ExecutionTelemetry;
  selectedScript?: string;
  id: string; url: string; ref: string; script: string; mode: 'inspect' | 'test'; args?: string[];
  status: 'queued' | 'preparing' | 'installing' | 'running' | 'cleaning' | 'passed' | 'failed' | 'blocked' | 'cancelled' | 'review';
  message: string; logs: string; commit: string | null; testExitCode: number | null;
  package: { name?: string; scripts: Record<string, string>; packageManager: string | null; lock: boolean } | null;
  createdAt: string; updatedAt: string; finishedAt: string | null;
}
export const repoStatusLabels: Record<RepoJob['status'], string> = { queued: 'I kö', preparing: 'Förbereder', installing: 'Installerar', running: 'Kör kommando', cleaning: 'Städar', passed: 'Kommandot lyckades', failed: 'Kommandot misslyckades', blocked: 'Blockerad', cancelled: 'Avbruten', review: 'Redo att granska' };
export const repoTerminal = (status: RepoJob['status']) => ['passed', 'failed', 'blocked', 'cancelled', 'review'].includes(status);
export interface WorkspaceRepository { id: string; url: string; ref: string; script: string }
export interface RepositoryRun { id: string; repositoryId: string; job: RepoJob | null; createdAt: string }
export interface RepositoryState { repositories: WorkspaceRepository[]; runs: RepositoryRun[]; available: boolean; syncError?: string }
