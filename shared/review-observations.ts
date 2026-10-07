import { z } from 'zod';
import { normalizeEvidenceProvenance, isIndependentEvidence } from './evidence-provenance.ts';
import type { EvidenceRead } from './mission.ts';

const short = z.string().max(4000);
// Narrow projection of the server-owned browser-action v1 format. This is not
// a parser for arbitrary logs, DOM prose or agent-authored action claims.
const traceSchema = z.object({
  version: z.literal(1), browserJobId: z.string().min(1), callId: z.string().min(1),
  execution: z.object({ attemptId: z.string().min(1), dispatchId: z.string().min(1) }),
  action: z.string().min(1).max(80), startedAt: z.string().datetime({ offset: true }), finishedAt: z.string().datetime({ offset: true }),
  fromUrl: short.nullable(), toUrl: short.nullable(), httpStatus: z.number().int().min(100).max(599).nullable(),
  outcome: z.enum(['observed', 'action_failed']),
  observation: z.object({ linkObservation: z.object({ method: z.literal('dom-css-visible-anchors'),
    links: z.array(z.object({ label: z.string().max(300), href: short })).max(40), truncated: z.boolean(),
  }).optional() }).nullable(),
  filledField: z.object({ method: z.literal('dom-value-and-css'), valueMatchesRequested: z.boolean(), nonEmpty: z.boolean(), cssVisible: z.boolean(),
    masking: z.enum(['masked', 'not-detected']), observedAt: z.string().datetime({ offset: true }),
  }).nullable().optional(),
});
export type ReadObservation = {
  evidenceId: string; runId: string; action: string; outcome: 'observed' | 'action_failed';
  fromUrl: string | null; toUrl: string | null; httpStatus: number | null;
  domLinks?: { label: string; href: string }[]; domLinksTruncated?: boolean;
  filledField?: z.infer<typeof traceSchema>['filledField'];
};
type Evidence = { id: string; evidencePolicyVersion?: number; origin?: string; provenance?: unknown; unavailable?: boolean };

/** The caller supplies only an independently applicable source and its actual
 * full read receipt. Report reads can be redacted: digest attests original
 * bytes, so never hash the redacted text as if it were the original blob. */
export function readObservation(evidence: Evidence, read: EvidenceRead | undefined, runId: string): ReadObservation | null {
  const provenance = normalizeEvidenceProvenance(evidence.provenance);
  if (!read || read.id !== evidence.id || read.unavailable || read.limited || !read.text || !isIndependentEvidence(evidence)
    || provenance?.producer !== 'browser-action' || provenance.sourceType !== 'test' || provenance.sourceId !== runId
    || !provenance.sha256 || read.digest !== provenance.sha256) return null;
  let value: unknown;
  try { value = JSON.parse(read.text); } catch { return null; }
  const parsed = traceSchema.safeParse(value);
  if (!parsed.success || Date.parse(parsed.data.finishedAt) < Date.parse(parsed.data.startedAt)) return null;
  const trace = parsed.data, links = trace.observation?.linkObservation;
  return { evidenceId: evidence.id, runId, action: trace.action, outcome: trace.outcome,
    fromUrl: trace.fromUrl, toUrl: trace.toUrl, httpStatus: trace.httpStatus,
    ...(links ? { domLinks: links.links, domLinksTruncated: links.truncated } : {}),
    ...(trace.filledField ? { filledField: trace.filledField } : {}),
  };
}

export const observationIndexLimit = 180000;
export function boundedObservationIndex(rows: readonly ReadObservation[]) {
  const unique = new Map<string, ReadObservation>();
  for (const row of rows) {
    const previous = unique.get(row.evidenceId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error('Conflicting read observation identity');
    unique.set(row.evidenceId, row);
  }
  const result = [...unique.values()];
  // Fail closed before the provider; never silently omit the tail of a run.
  if (JSON.stringify(result).length > observationIndexLimit) throw new Error('Read observation index exceeds bounded context budget');
  return result;
}

export const checkPartSchema = z.object({
  text: z.string().trim().min(1).max(240).describe('One original subclaim, retaining its material property or qualifier, and the cited basis for judging it. An evidence summary alone does not assess that property. Do not repeat the whole requirement.'),
  basis: z.enum(['state', 'action_attempt', 'performed_action', 'changed_destination', 'other']).describe('Cited observation form, not product outcome: state includes pixels/DOM/href or a direct open response. action_attempt requires an own non-open action trace, including action_failed. performed_action requires outcome observed. changed_destination additionally requires different observed from/to URLs. None implies the requirement passed. Other covers non-browser evidence.'),
  relation: z.enum(['supports', 'contradicts', 'unresolved']),
  evidenceIds: z.array(z.string().min(1).max(100)).max(30),
}).strict();
export const checkPartsSchema = z.object({
  coverage: z.enum(['complete', 'partial']).describe('Complete only when parts account for all claims made by the original requirement/status/actual. For a truthful mismatch assess the claimed deviation, not an invented claim that everything passed. Mark partial for omitted or unassessed claims.'),
  parts: z.array(checkPartSchema).min(1).max(8),
}).strict();
export type CheckParts = z.infer<typeof checkPartsSchema>;
export function partsRelation(row: CheckParts) {
  if (row.parts.some(part => part.relation === 'contradicts')) return 'contradicts' as const;
  if (row.coverage !== 'complete' || row.parts.some(part => part.relation === 'unresolved')) return 'unresolved' as const;
  return 'supports' as const;
}
export function partsProjection(row: CheckParts) {
  return { relation: partsRelation(row), text: row.parts.map(part => part.text).join(' '),
    evidenceIds: [...new Set(row.parts.flatMap(part => part.evidenceIds))] };
}
/** A mechanical floor for declared action claims, not a completeness or
 * semantic truth oracle. The model still chooses and judges the subclaims. */
export function partsEvidenceIssue(row: CheckParts, allowedIds: ReadonlySet<string>, independentIds: ReadonlySet<string>, observations: readonly ReadObservation[]) {
  if (new Set(row.parts.map(part => part.text)).size !== row.parts.length) return 'Duplicate subclaim';
  for (const part of row.parts) {
    if (new Set(part.evidenceIds).size !== part.evidenceIds.length || part.evidenceIds.some(id => !allowedIds.has(id))) return 'Subclaim cites unread or foreign evidence';
    if (part.relation === 'unresolved') continue;
    if (!part.evidenceIds.some(id => independentIds.has(id))) return 'Conclusive subclaim requires applicable independent evidence';
    // A contrary observation need not exhibit the claimed action or success:
    // action_failed or an unchanged destination can be its actual counterproof.
    if (part.relation === 'supports' && ['action_attempt', 'performed_action', 'changed_destination'].includes(part.basis)) {
      const observed = observations.filter(row => part.evidenceIds.includes(row.evidenceId) && independentIds.has(row.evidenceId)
        && (part.basis === 'action_attempt' || row.outcome === 'observed')
        && ['click', 'fill', 'press', 'select', 'scroll', 'back', 'forward'].includes(row.action));
      if (!observed.some(row => part.basis !== 'changed_destination' || row.fromUrl !== null && row.toUrl !== null && row.fromUrl !== row.toUrl)) return 'Declared action observation lacks a corresponding read action observation';
    }
  }
  return null;
}

export const checkPartsInstructions = `Redovisa korta citerade delpåståenden i parts för varje oförändrad kontrollpunkt. Behåll originalkravets betydelsebärande egenskaper och kvalificeringar i delpåståendet; ett bevisreferat ersätter inte bedömningen av egenskapen och tillför inget krav på en viss testmetod. Separera synligt tillstånd, varje påstådd interaktion och dess observerade utfall. coverage=complete betyder att alla påståenden i requirement/status/actual har bedömts; annars partial. En korrekt rapporterad mismatch bedöms mot den påstådda avvikelsen, utan påhittat krav att övriga delar godkänns. Varje del har egen relation och egna källreferenser. parts[].basis beskriver den citerade observationsformen, aldrig produktutfall: action_attempt kan belägga ett korrekt rapporterat misslyckat försök, performed_action en observerad handling, changed_destination ett observerat destinationsbyte genom handlingen. Ett direkt URL-open med svar bedöms som state och behöver inte ett klick. Om högst åtta korta delar inte räcker, ange partial och beskriv den olösta återstoden; kalla inte en utelämnad del complete. Olösta delar är unresolved. readObservations är ett begränsat index ur lästa spår från exakt samma körning, inte nya bevis: DOM-länk/href är inte en handling; action=click är inte ett lyckat produktutfall; from/to/httpStatus beskriver bara vad just den handlingen observerade. Klick utan ändrad destination belägger ingen navigation, open belägger inget länkklick. Andra körningars spår får inte lånas. Bedöm själva bilagorna och de oförändrade kraven. Systemet härleder helrelationen från delarna; välj ingen separat helrelation. Indexets frånvaro bevisar inte att en handling inte utfördes. Deluppdelningen är din bedömning, inte ett automatiskt fullständighetsbevis.`;
