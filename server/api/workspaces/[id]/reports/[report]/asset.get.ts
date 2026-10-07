import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { get } from '../../../../../utils/evidence-storage';
import { requireSessionUserId } from '../../../../../utils/session';
import { readOwnedReport } from '../../../../../utils/mission-reports';
import { workspaceBlobToken } from '../../../../../utils/workspaces';
export default defineEventHandler(async event => {
  const workspaceId = getRouterParam(event, 'id')!;
  const { report } = await readOwnedReport(await requireSessionUserId(event), workspaceId, getRouterParam(event, 'report')!);
  const ref = report.document?.evidence.find(e => e.id === getQuery(event).evidenceId);
  if (!ref?.itemId) throw createError({ statusCode: 404 });
  const [item] = await db.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.id, ref.itemId), eq(schema.workspaceItems.workspaceId, workspaceId), isNull(schema.workspaceItems.deletedAt)));
  if (!item?.blobPath || item.version !== ref.version || item.content.kind !== 'image' || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(item.content.mime)) throw createError({ statusCode: 404 });
  const blob = await get(item.blobPath, { access: 'private', token: workspaceBlobToken() });
  if (!blob || blob.statusCode !== 200) throw createError({ statusCode: 404 });
  setHeaders(event, { 'Content-Type': item.content.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  return sendStream(event, blob.stream);
});
