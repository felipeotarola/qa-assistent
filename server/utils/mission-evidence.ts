import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { get } from './evidence-storage';
import { missionItemEvidence } from './mission-sources';
import { workspaceBlobToken } from './workspaces';
import { missionRedactor } from './mission-redaction';
import type { EvidenceRef, EvidenceRead } from '../../shared/mission';
export type { EvidenceRead } from '../../shared/mission';

export async function readMissionEvidence(workspaceId: string, ref: EvidenceRef, signal: AbortSignal): Promise<EvidenceRead> {
  if (ref.unavailable) return { id: ref.id, unavailable: true, reason: 'Underlaget är otillgängligt.' };
  const redact = await missionRedactor(db, workspaceId);
  if (!ref.itemId) return { id: ref.id, origin: ref.origin, text: redact(ref.excerpt), digest: ref.hash, limited: ref.excerpt.length >= 32000, observedAt: ref.observedAt };
  const current = await missionItemEvidence(db, workspaceId, ref.itemId);
  if (current.unavailable || current.version !== ref.version || current.hash !== ref.hash) return { id: ref.id, unavailable: true, reason: 'Underlaget ändrades eller togs bort.' };
  const [item] = await db.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.id, ref.itemId), eq(schema.workspaceItems.workspaceId, workspaceId)));
  if (item?.content.kind === 'text' || item?.content.kind === 'diagram' || item?.content.kind === 'test_plan') return { id: ref.id, origin: ref.origin, text: redact(ref.excerpt), digest: ref.hash, limited: ref.excerpt.length >= 32000, observedAt: ref.observedAt };
  if (!item?.blobPath || !['file', 'image'].includes(item.content.kind)) return { id: ref.id, unavailable: true, reason: 'Filformatet stöds inte.' };
  if (item.content.kind !== 'file' && item.content.kind !== 'image') throw new Error('Invalid evidence type');
  const image = ['image/png', 'image/jpeg', 'image/webp'].includes(item.content.mime);
  const text = /^(text\/|application\/(json|xml))/.test(item.content.mime);
  if ((!image && !text) || item.content.size > 4 * 1024 * 1024) return { id: ref.id, unavailable: true, reason: 'Underlaget överskrider storleksgränsen eller har ett format som inte stöds.' };
  const blob = await get(item.blobPath, { access: 'private', token: workspaceBlobToken(), abortSignal: signal });
  if (!blob || blob.statusCode !== 200) return { id: ref.id, unavailable: true, reason: 'Filen saknas.' };
  const reader = blob.stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 4 * 1024 * 1024) throw new Error('Evidence too large'); chunks.push(part.value); } }
  finally { await reader.cancel(); }
  const bytes = Buffer.concat(chunks), digest = createHash('sha256').update(bytes).digest('hex');
  if (!ref.provenance?.sha256 || ref.provenance.sha256 !== digest) return { id: ref.id, unavailable: true, reason: 'Filens sparade innehållsidentitet saknas eller matchar inte.' };
  return { id: ref.id, origin: ref.origin, digest, observedAt: ref.observedAt, ...(image ? { image: { data: bytes.toString('base64'), mediaType: item.content.mime } } : { text: redact(bytes.toString('utf8')).slice(0, 32000), limited: bytes.length > 32000 }) };
}
