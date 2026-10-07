import { eq, sql } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { parseRepositoryMapReport } from '../../shared/repository-map';
import { saveItem } from './workspaces';

// The receipt survives edits and trash, so callback retries never create copies.
export async function saveRepositoryMap(userId: string, job: typeof schema.setupJobs.$inferSelect, report: string) {
  const content = parseRepositoryMapReport(job.task, report);
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`repository-map:${job.id}`},0))`);
    const receiptId = `repository-map:${job.id}`;
    const [receipt] = await tx.select().from(schema.workspaceEvidence).where(eq(schema.workspaceEvidence.id, receiptId));
    if (receipt) return receipt.itemId;
    const item = await saveItem(userId, job.workspaceId, { title: `${content.repository!.url.split('/').pop()} — repokarta`, content, threadId: job.threadId }, tx, { provenance: { version: 1, origin: 'agent', producer: 'agent-authored', sourceType: 'setup', sourceId: job.id, observedAt: null } });
    await tx.insert(schema.workspaceEvidence).values({ id: receiptId, workspaceId: job.workspaceId, itemId: item.id, itemVersion: item.version, kind: 'origin', label: 'Axels repositoryanalys', threadId: job.threadId });
    return item.id;
  });
}
