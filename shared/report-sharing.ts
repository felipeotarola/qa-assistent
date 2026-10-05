import { z } from 'zod';
import type { ReportDocument } from './mission-report';
export function sharedReportDocument(source: ReportDocument, included: string[]): ReportDocument {
  // Scrub internal URLs even when they occur in a generated paragraph or metric label.
  const scrub = (value: unknown): unknown => typeof value === 'string' ? value.replace(/https?:\/\/[^\s<>"']+/g, url => isPublicHost(url) ? url : '[intern testadress]') : Array.isArray(value) ? value.map(scrub) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)])) : value;
  const document = scrub(source) as ReportDocument;
  document.tests = document.tests.map(t => ({ ...t, runId: null }));
  document.evidence = document.evidence.map(e => ({ ...e, itemId: null, url: safeReportUrl(e.url), kind: included.includes(e.id) ? e.kind : 'unshared' }));
  return document;
}
export const shareActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), mode: z.enum(['public', 'pin']), pin: z.string().regex(/^\d{6}$/).optional(), evidenceIds: z.array(z.string().max(120)).max(50), expiresAt: z.string().datetime().nullable() }),
  z.object({ action: z.literal('revoke') }),
  z.object({ action: z.literal('change_pin'), pin: z.string().regex(/^\d{6}$/) }),
]);
export const unlockShareSchema = z.object({ pin: z.string().regex(/^\d{6}$/) });
export function safeReportUrl(value: string | null) {
  if (!value) return null;
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && isPublicHost(value) && !u.username && !u.password && !u.search && !u.hash ? u.href : null; } catch { return null; }
}
function isPublicHost(value: string) {
  try { const u = new URL(value), host = u.hostname.toLowerCase(); return !u.username && !u.password && host.includes('.') && !/(?:^localhost$|\.localhost$|\.local$|\.internal$|^127\.|^0\.|^10\.|^192\.168\.|^169\.254\.|^172\.(?:1[6-9]|2\d|3[01])\.|^\[)/.test(host); } catch { return false; }
}
