import { z } from 'zod';
import { requireInternalRequest } from '../../utils/internal-api';
import { saveRepositoryJob } from '../../utils/repositories';
import type { RepoJob } from '../../../shared/repository';
const result = z.object({
  revision: z.number().int().nonnegative().optional(),
  directory: z.string().max(200).optional(), workspaceId: z.string().uuid().optional(),
  projects: z.array(z.object({ directory: z.string().max(200), kind: z.string().max(30) })).max(30).optional(),
  plan: z.object({ directory: z.string().max(200), runtime: z.string().max(40), operationKind: z.string().max(40), selectedScript: z.string().max(80), install: z.array(z.array(z.string().max(500))).max(10), command: z.array(z.string().max(500)).max(40) }).optional(),
  telemetry: z.object({ workerId: z.string().max(100), heartbeatAt: z.string().datetime(), phaseStartedAt: z.string().datetime(), startedAt: z.string().datetime().optional(), queuePosition: z.number().int().optional(), cancellationRequested: z.boolean().optional(), operationKind: z.enum(['test', 'static-check', 'inspect', 'build']).optional(), failureKind: z.enum(['runtime', 'checkout', 'configuration', 'dependencies', 'command', 'timeout', 'interrupted', 'cleanup']).optional() }).optional(),
  selectedScript: z.string().max(80).optional(),
  id: z.string().uuid(), url: z.string().url(), ref: z.string().max(150), script: z.string().max(80), mode: z.enum(['inspect', 'test']), args: z.array(z.string().max(300)).max(20).optional(),
  status: z.enum(['passed', 'failed', 'blocked', 'cancelled', 'review']), message: z.string().max(2000), logs: z.string().max(64000),
  commit: z.string().regex(/^[a-f0-9]{40}$/).nullable(), testExitCode: z.number().int().nullable(),
  package: z.object({ name: z.string().optional(), scripts: z.record(z.string(), z.string()), packageManager: z.string().nullable(), lock: z.boolean() }).nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), finishedAt: z.string().datetime(),
});
export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const job = result.parse(await readBody(event)) as RepoJob;
  await saveRepositoryJob(job);
  return { saved: true };
});
