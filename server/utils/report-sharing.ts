import { randomBytes, randomInt, randomUUID, scrypt as derive, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, isNull, sql, desc, gt } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { get } from '@vercel/blob';
import type { H3Event } from 'h3';
import { reportShares, reportShareSessions, reportShareAttempts, reportShareAudit } from '../db/schema/report-shares';
import { missionReports, missions } from '../db/schema/missions';
import { shareActionSchema, unlockShareSchema, sharedReportDocument } from '../../shared/report-sharing';
import { readOwnedReport } from './mission-reports';
import { workspaceBlobToken } from './workspaces';
import { missionItemEvidence } from './mission-sources';
const scrypt = promisify(derive);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const secret = () => { const s = process.env.REPORT_SHARE_PEPPER || process.env.INTERNAL_API_SECRET; if (!s) throw createError({ statusCode: 503, statusMessage: 'Delning är inte konfigurerad.' }); return s; };
const pepper = (s: string) => createHmac('sha256', secret()).update(s).digest('hex');
export async function hashReportPin(pin: string) { const salt = randomBytes(16).toString('hex'); return `${salt}:${(await scrypt(pepper(pin), salt, 32) as Buffer).toString('hex')}`; }
async function verifyPin(pin: string, stored: string) { const [salt, digest] = stored.split(':'); const actual = await scrypt(pepper(pin), salt!, 32) as Buffer; const expected = Buffer.from(digest!, 'hex'); return actual.length === expected.length && timingSafeEqual(actual, expected); }
export function requireReportMutation(event: H3Event) {
  if (!getHeader(event, 'content-type')?.startsWith('application/json')) throw createError({ statusCode: 415 });
  const origin = getHeader(event, 'origin');
  if (origin && origin !== getRequestURL(event).origin) throw createError({ statusCode: 403, statusMessage: 'Cross-origin request rejected' });
}
export function reportPrivacyHeaders(event: H3Event) { setHeaders(event, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'X-Content-Type-Options': 'nosniff' }); }
export async function manageReportShare(userId: string, workspaceId: string, reportId: string, raw: unknown) {
  const action = shareActionSchema.parse(raw);
  const row = await readOwnedReport(userId, workspaceId, reportId);
  if (!row.report.document || row.report.status !== 'completed') throw createError({ statusCode: 409, statusMessage: 'En färdig rapport krävs.' });
  const code = action.action === 'create' && action.mode === 'pin' ? action.pin ?? randomInt(0, 1000000).toString().padStart(6, '0') : action.action === 'change_pin' ? action.pin : null;
  const pinHash = code ? await hashReportPin(code) : null;
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`share:${row.mission.id}`}, 0))`);
    const reports = await tx.select({ id: missionReports.id }).from(missionReports).where(eq(missionReports.missionId, row.mission.id));
    const ids = reports.map(r => r.id);
    if (action.action === 'create') {
      if (action.expiresAt && Date.parse(action.expiresAt) <= Date.now()) throw createError({ statusCode: 400, statusMessage: 'Välj en framtida sluttid.' });
      if (action.evidenceIds.some(id => !row.report.document!.evidence.some(e => e.id === id && e.itemId && e.kind === 'image'))) throw createError({ statusCode: 400, statusMessage: 'Välj bara rapportens bildbilagor.' });
      for (const id of action.evidenceIds) { const ref = row.report.document!.evidence.find(e => e.id === id)!; const source = await missionItemEvidence(tx, workspaceId, ref.itemId!); if (source.unavailable || source.version !== ref.version) throw createError({ statusCode: 409, statusMessage: 'Bilagan ändrades eller togs bort.' }); }
      await tx.update(reportShares).set({ revokedAt: new Date() }).where(and(sql`${reportShares.reportId} in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`, isNull(reportShares.revokedAt)));
      const [share] = await tx.insert(reportShares).values({ id: randomUUID(), reportId, token: randomBytes(24).toString('base64url'), mode: action.mode, pinHash, evidenceIds: action.evidenceIds, expiresAt: action.expiresAt ? new Date(action.expiresAt) : null }).returning();
      await tx.insert(reportShareAudit).values({ id: randomUUID(), reportId, userId, action: `create:${action.mode}` });
      return { share: publicShare(share!), pin: code };
    }
    const [current] = await tx.select().from(reportShares).where(and(eq(reportShares.reportId, reportId), isNull(reportShares.revokedAt))).orderBy(desc(reportShares.createdAt)).limit(1);
    if (!current) return { share: null };
    if (action.action === 'change_pin' && current.mode !== 'pin') throw createError({ statusCode: 409, statusMessage: 'Aktivera privat delning först.' });
    await tx.update(reportShares).set(action.action === 'revoke' ? { revokedAt: new Date(), revision: current.revision + 1 } : { pinHash, revision: current.revision + 1 }).where(eq(reportShares.id, current.id));
    await tx.insert(reportShareAudit).values({ id: randomUUID(), reportId, userId, action: action.action });
    return { share: action.action === 'revoke' ? null : publicShare(current), pin: code };
  });
}
const publicShare = (share: typeof reportShares.$inferSelect) => ({ mode: share.mode, path: `/reports/shared/${share.token}`, expiresAt: share.expiresAt?.toISOString() ?? null });
export async function getOwnedShare(userId: string, workspaceId: string, reportId: string) {
  await readOwnedReport(userId, workspaceId, reportId);
  const [share] = await db.select().from(reportShares).where(and(eq(reportShares.reportId, reportId), isNull(reportShares.revokedAt))).orderBy(desc(reportShares.createdAt)).limit(1);
  return { share: share && (!share.expiresAt || share.expiresAt.getTime() > Date.now()) ? publicShare(share) : null };
}
async function getLiveShare(token: string) {
  if (!/^[\w-]{32}$/.test(token)) throw createError({ statusCode: 404, statusMessage: 'Länken är inte tillgänglig.' });
  const [row] = await db.select({ share: reportShares, report: missionReports, mission: missions, item: schema.workspaceItems }).from(reportShares).innerJoin(missionReports, eq(missionReports.id, reportShares.reportId)).innerJoin(missions, eq(missions.id, missionReports.missionId)).innerJoin(schema.workspaceItems, eq(schema.workspaceItems.id, missionReports.itemId)).where(and(eq(reportShares.token, token), isNull(reportShares.revokedAt), isNull(schema.workspaceItems.deletedAt)));
  if (!row || row.share.expiresAt && row.share.expiresAt.getTime() <= Date.now() || !row.report.document) throw createError({ statusCode: 404, statusMessage: 'Länken är inte tillgänglig.' });
  return row;
}
export async function readSharedReport(event: H3Event, token: string, assetId?: string) {
  reportPrivacyHeaders(event);
  const row = await getLiveShare(token);
  if (row.share.mode === 'pin') {
    const value = getCookie(event, `report_${row.share.id}`) ?? '';
    const [session] = await db.select().from(reportShareSessions).where(and(eq(reportShareSessions.tokenHash, hash(value)), eq(reportShareSessions.shareId, row.share.id), eq(reportShareSessions.revision, row.share.revision), gt(reportShareSessions.expiresAt, new Date())));
    if (!session) { if (assetId) throw createError({ statusCode: 401 }); return { locked: true as const }; }
  }
  if (assetId) {
    const ref = row.report.document!.evidence.find(e => e.id === assetId && row.share.evidenceIds.includes(e.id));
    if (!ref?.itemId || ref.kind !== 'image') throw createError({ statusCode: 404 });
    const [item] = await db.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.id, ref.itemId), eq(schema.workspaceItems.workspaceId, row.mission.workspaceId), isNull(schema.workspaceItems.deletedAt)));
    if (!item?.blobPath || item.version !== ref.version || item.content.kind !== 'image' || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(item.content.mime)) throw createError({ statusCode: 404 });
    const blob = await get(item.blobPath, { access: 'private', token: workspaceBlobToken() });
    if (!blob || blob.statusCode !== 200) throw createError({ statusCode: 404 });
    setHeader(event, 'Content-Type', item.content.mime); return sendStream(event, blob.stream);
  }
  const document = sharedReportDocument(row.report.document!, row.share.evidenceIds);
  // This allowlisted document contains no job records, snapshots, Vault, chat or access tokens.
  return { locked: false as const, document, assets: document.evidence.filter(e => e.kind === 'image').map(e => ({ id: e.id, url: `/api/report-shares/${token}/asset?evidenceId=${encodeURIComponent(e.id)}` })) };
}
export async function unlockReportShare(event: H3Event, token: string, raw: unknown) {
  reportPrivacyHeaders(event); requireReportMutation(event);
  const { pin } = unlockShareSchema.parse(raw);
  const row = await getLiveShare(token);
  if (row.share.mode !== 'pin') return { ok: true };
  const client = pepper(getRequestIP(event, { xForwardedFor: !!process.env.VERCEL }) ?? 'unknown');
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`share-attempt:${row.share.id}`}, 0))`);
    for (const [key, limit] of [[`${row.share.id}:${client}`, 5], [row.share.id, 50]] as const) {
      const [count] = await tx.insert(reportShareAttempts).values({ key, count: 1, expiresAt: new Date(Date.now() + 900000) }).onConflictDoUpdate({ target: reportShareAttempts.key, set: { count: sql`case when ${reportShareAttempts.expiresAt} < now() then 1 else ${reportShareAttempts.count} + 1 end`, expiresAt: sql`case when ${reportShareAttempts.expiresAt} < now() then now() + interval '15 minutes' else ${reportShareAttempts.expiresAt} end` } }).returning();
      if (count!.count > limit) throw createError({ statusCode: 429, statusMessage: 'För många försök. Försök igen senare.' });
    }
  });
  if (!row.share.pinHash || !await verifyPin(pin, row.share.pinHash)) throw createError({ statusCode: 401, statusMessage: 'Fel pinkod.' });
  const value = randomBytes(32).toString('base64url'); const expiresAt = new Date(Math.min(Date.now() + 7200000, row.share.expiresAt?.getTime() ?? Infinity));
  await db.insert(reportShareSessions).values({ tokenHash: hash(value), shareId: row.share.id, revision: row.share.revision, expiresAt });
  setCookie(event, `report_${row.share.id}`, value, { httpOnly: true, secure: getRequestURL(event).protocol === 'https:', sameSite: 'lax', path: `/api/report-shares/${token}`, expires: expiresAt });
  return { ok: true };
}
