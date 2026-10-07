import { z } from 'zod';

export const EVIDENCE_POLICY_VERSION = 2 as const;
export const evidenceProducers = ['research-page', 'browser-screenshot', 'test-capture', 'browser-action', 'repository-runner', 'environment-probe', 'capture-metadata', 'agent-authored', 'user-authored', 'unknown'] as const;
const toolProducers = new Set<string>(['research-page', 'browser-screenshot', 'test-capture', 'browser-action', 'repository-runner', 'environment-probe', 'capture-metadata']);
const evidenceUrlSchema = z.string().url().max(4000).refine(value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}, 'Evidence URLs must use HTTP(S) without credentials');

/** Store the observed location, never editable source links. Omit credentials
 * and redact common secret query values before saving acquisition metadata. */
export function sanitizeEvidenceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const secretKey = /(?:authorization|api[-_]?key|token|secret|password|signature|credential|session|^code$)/i;
    for (const key of [...url.searchParams.keys()]) if (secretKey.test(key)) url.searchParams.set(key, '[REDACTED]');
    if (url.hash && secretKey.test(url.hash)) url.hash = '';
    return evidenceUrlSchema.safeParse(url.href).success ? url.href : null;
  } catch { return null; }
}

/** Set only by a trusted producer; URLs and model-supplied labels confer no trust. */
export const evidenceProvenanceSchema = z.object({
  version: z.literal(1),
  origin: z.enum(['tool', 'agent', 'user', 'unknown']),
  producer: z.enum(evidenceProducers),
  sourceType: z.enum(['test', 'repository', 'browser', 'research', 'setup']).optional(),
  sourceId: z.string().min(1).max(200).optional(),
  observedAt: z.string().datetime({ offset: true }).nullable(),
  url: evidenceUrlSchema.nullable().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine(value => value.origin === 'tool' ? toolProducers.has(value.producer)
  : value.origin === 'agent' ? value.producer === 'agent-authored'
    : value.origin === 'user' ? value.producer === 'user-authored'
      : value.producer === 'unknown', 'Evidence origin and producer must agree');
export type EvidenceProvenance = z.infer<typeof evidenceProvenanceSchema>;

/** Historical or invalid metadata is readable but cannot acquire trusted origin. */
export function normalizeEvidenceProvenance(value: unknown): EvidenceProvenance | null {
  const parsed = evidenceProvenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Trust is necessary, not sufficient: consumers also check reads, scope,
 * freshness and relevance to each claim. Capture metadata is not image proof. */
export function isIndependentEvidence(evidence: { evidencePolicyVersion?: number; origin?: string; provenance?: unknown; unavailable?: boolean }) {
  const provenance = normalizeEvidenceProvenance(evidence.provenance);
  return evidence.evidencePolicyVersion === EVIDENCE_POLICY_VERSION
    && !evidence.unavailable
    && evidence.origin === 'tool'
    && provenance?.origin === 'tool'
    && provenance.producer !== 'capture-metadata';
}
