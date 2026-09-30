import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { repositoryRuns } from '../../../db/schema/repositories';
import { requireSessionUserId } from '../../../utils/session';
import { requireWorkspace, publicItem, saveItem } from '../../../utils/workspaces';
import { repoStatusLabels, repoTerminal } from '../../../../shared/repository';

export default defineEventHandler(async event => {
  const userId = await requireSessionUserId(event);
  const workspaceId = getRouterParam(event, 'id')!;
  const { runId } = await readValidatedBody(event, z.object({ runId: z.string().uuid() }).parse);
  await requireWorkspace(userId, workspaceId);
  return db.transaction(async tx => {
    const receipt = `repository-report:${workspaceId}:${runId}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${receipt}, 0))`);
    const [run] = await tx.select().from(repositoryRuns).where(and(eq(repositoryRuns.id, runId), eq(repositoryRuns.workspaceId, workspaceId)));
    if (!run) throw createError({ statusCode: 404, statusMessage: 'Körningen saknas.' });
    const job = run.job;
    if (!job || !repoTerminal(job.status)) throw createError({ statusCode: 409, statusMessage: 'Körningen är inte klar.' });
    const [prior] = await tx.select().from(schema.workspaceEvidence).where(eq(schema.workspaceEvidence.id, receipt));
    if (prior) {
      const [item] = await tx.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.id, prior.itemId));
      if (!item || item.deletedAt) throw createError({ statusCode: 409, statusMessage: 'Rapporten finns i papperskorgen. Återställ den där.' });
      return { item: publicItem(item) };
    }
    const text = [`Repository: ${job.url}`, `Körning: ${runId}`, `Commit: ${job.commit || 'Ej hämtad'}`, `Script: ${job.script} ${(job.args || []).join(" ")}`, `Status: ${repoStatusLabels[job.status]}`, `Exitkod: ${job.testExitCode ?? 'Ingen'}`, job.message, 'Ett lyckat kommando bekräftar inte enskilda testfall.', 'Körlogg (senaste 64 000 tecken):', job.logs].join('\n\n');
    const item = await saveItem(userId, workspaceId, { title: `Repositorykörning · ${job.url.split('/').at(-1)} · ${runId.slice(0, 8)}`, content: { kind: 'text', text } }, tx);
    await tx.insert(schema.workspaceEvidence).values({ id: receipt, workspaceId, itemId: item.id, itemVersion: item.version, kind: 'origin', label: `VPS-körning ${runId}` });
    return { item };
  });
});
