import { z } from 'zod';

export const observationScopeSchema = z.object({
  kind: z.literal('observation'), id: z.string().uuid(), capturedAt: z.iso.datetime(),
}).strict();
export const testTargetSchema = z.object({
  environment: z.string().trim().max(200),
  url: z.string().trim().max(2000).refine(value => { if (!value) return true; try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }, 'Ange en http- eller https-adress utan inloggningsuppgifter'),
  revision: z.string().trim().max(200),
  scope: observationScopeSchema.optional(),
}).refine(target => !target.scope || !target.revision && !!target.environment && !!target.url, 'Ett observationsscope kräver miljö och adress, och är inte en releaseversion');
export type TestTarget = z.infer<typeof testTargetSchema>;

/** Observation identity is issued and checked by the server. It describes one
 * mission's observation, never a claim about an unknown deployed revision. */
export function hasTargetIdentity(target: TestTarget | null | undefined) {
  return !!target && testTargetSchema.safeParse(target).success && !!target.environment.trim() && (!!target.revision.trim() || !!target.scope);
}
export function sameTarget(a: TestTarget, b: TestTarget) {
  return a.environment === b.environment && a.url === b.url && a.revision === b.revision
    && a.scope?.kind === b.scope?.kind && a.scope?.id === b.scope?.id && a.scope?.capturedAt === b.scope?.capturedAt;
}
export function targetVersionLabel(target: TestTarget) {
  return target.scope ? `Observation ${target.scope.capturedAt} · releaseversion okänd` : target.revision || 'Okänd version';
}
