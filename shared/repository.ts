import { z } from 'zod';
import { missionBindingSchema } from './mission-binding.ts';
import type { ExecutionTelemetry } from './execution';
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
export type RepositoryAction = z.infer<typeof repositoryActionSchema>;
export interface RepoJob {
  revision?: number;
  directory?: string;
  workspaceId?: string;
  projects?: { directory: string; kind: string }[];
  plan?: { directory: string; runtime: string; operationKind: string; selectedScript: string; install: string[][]; command: string[] };
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
