import { z } from 'zod';
import { requireInternalRequest } from '../../utils/internal-api';
import { saveRepositoryJob } from '../../utils/repositories';
import type { RepoJob } from '../../../shared/repository';
const result = z.object({
  id: z.string().uuid(), url: z.string().url(), ref: z.string().max(150), script: z.string().max(80), mode: z.enum(['inspect', 'test']),
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
