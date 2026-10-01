import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { requireInternalRequest } from '../../utils/internal-api';
import { runtimeScope } from '../../../shared/runtime-scope';
import { appOrigin, internalHeaders } from '../../../agent/lib/internal-api';
export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const body = await readValidatedBody(event, z.object({ jobId: z.string().uuid(), status: z.enum(['completed', 'failed', 'cancelled']).optional(), report: z.string().max(50000).optional() }).parse);
  const [job] = await db.update(schema.browserJobs).set({ ...(body.status ? { status: body.status } : {}), ...(body.report !== undefined ? { report: body.report } : {}), updatedAt: new Date() }).where(and(eq(schema.browserJobs.id, body.jobId), eq(schema.browserJobs.runtime, runtimeScope()), inArray(schema.browserJobs.status, ['starting', 'running', 'dispatch_unknown']))).returning();
  if (job && body.status && body.status !== 'cancelled') {
    const [thread] = await db.select().from(schema.threads).where(eq(schema.threads.id, job.threadId));
    if (thread) {
      // At-most-once notification attempt. The durable report remains available
      // even if the parent no longer exists; never rerun tests to resend a report.
      await fetch(`${appOrigin()}/eve/v1/workers/iris/notify`, { method: 'POST', headers: internalHeaders(), signal: AbortSignal.timeout(15000), body: JSON.stringify({ ...job, userId: thread.userId, jobId: job.id }) }).catch(() => undefined);
    }
  }
  return { ok: true };
});
