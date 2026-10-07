import { createHash } from 'node:crypto';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { requireSessionUserId } from '../../../utils/session';
import { getThreadForUser } from '../../../utils/threads';
import { requireWorkspace, publicItem, saveItem } from '../../../utils/workspaces';

// A durable receipt makes retries (including a lost HTTP response) idempotent.
export default defineEventHandler(async (event) => {
  const userId = await requireSessionUserId(event);
  const workspaceId = getRouterParam(event, 'id')!;
  const input = await readValidatedBody(event, z.object({ threadId: z.string().uuid(), sourceId: z.string().min(1).max(500), text: z.string().trim().min(1).max(200000), title: z.string().trim().min(1).max(200) }).parse);
  await requireWorkspace(userId, workspaceId);
  const thread = await getThreadForUser(userId, input.threadId);
  if (thread?.workspaceId !== workspaceId) throw createError({ statusCode: 404, statusMessage: 'Thread not found' });
  const receipt = `activity:${createHash('sha256').update(JSON.stringify([workspaceId, input.threadId, input.sourceId])).digest('hex')}`;
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${receipt}, 0))`);
    const [prior] = await tx.select().from(schema.workspaceEvidence).where(eq(schema.workspaceEvidence.id, receipt));
    if (prior) {
      const [item] = await tx.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.id, prior.itemId));
      if (!item || item.deletedAt) throw createError({ statusCode: 409, statusMessage: 'Previously saved material is in the trash. Restore it there.' });
      return { item: publicItem(item) };
    }
    const item = await saveItem(userId, workspaceId, { title: input.title, content: { kind: 'text', text: input.text }, threadId: input.threadId }, tx, { provenance: { version: 1, origin: 'agent', producer: 'agent-authored', observedAt: null } });
    await tx.insert(schema.workspaceEvidence).values({ id: receipt, workspaceId, itemId: item.id, itemVersion: item.version, kind: 'origin', label: 'Sparat från aktivitetspanelen', threadId: input.threadId });
    return { item };
  });
});
