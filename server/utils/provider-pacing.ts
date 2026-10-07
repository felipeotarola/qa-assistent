import { createHash } from 'node:crypto';
import { db } from '@nuxthub/db';
import { eq, sql } from 'drizzle-orm';
import { providerPacing } from '../db/schema/provider-pacing';
import { PROVIDER_PACING_MAX_COOLDOWN_MS, providerPacingInterval, providerPacingRequestSchema, type ProviderPacingRequest, type ProviderPacingReservation } from '../../shared/provider-pacing';

/** No future queue slots: callers wait outside the transaction, then contend
 * again. A lost HTTP acknowledgement consumes a slot but never starts a model. */
export async function paceProviderRequest(input: ProviderPacingRequest): Promise<ProviderPacingReservation | { recorded: true }> {
  const request = providerPacingRequestSchema.parse(input);
  const interval = providerPacingInterval(process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS);
  const credential = process.env.GRUNDEN_API_TOKEN?.trim();
  if (!credential || !interval || request.intervalMs !== interval
    || request.credentialHash !== createHash('sha256').update(credential).digest('hex')) {
    throw createError({ statusCode: 503, statusMessage: 'Provider pacing configuration does not match' });
  }
  const bucketHash = createHash('sha256').update(`grunden:v1:${request.credentialHash}:${request.model}`).digest('hex');
  return db.transaction(async tx => {
    await tx.execute(sql`set local lock_timeout = '3s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`provider-pacing:${bucketHash}`}, 0))`);
    const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
    const current = new Date(clock!.now);
    const [row] = await tx.select().from(providerPacing).where(eq(providerPacing.bucketHash, bucketHash));
    const next = row?.nextStartAt.getTime() ?? 0;
    if (request.action === 'reserve' && next > current.getTime()) {
      return { allowed: false as const, waitMs: Math.min(PROVIDER_PACING_MAX_COOLDOWN_MS, Math.max(1, Math.ceil(next - current.getTime()))) };
    }
    const nextStartAt = new Date(request.action === 'cooldown'
      ? Math.max(next, current.getTime() + request.delayMs)
      : current.getTime() + interval);
    await tx.insert(providerPacing).values({ bucketHash, nextStartAt, updatedAt: current })
      .onConflictDoUpdate({ target: providerPacing.bucketHash, set: { nextStartAt, updatedAt: current } });
    return request.action === 'cooldown' ? { recorded: true as const } : { allowed: true as const };
  });
}
