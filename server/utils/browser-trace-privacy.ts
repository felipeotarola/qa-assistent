import { z } from 'zod';
import type { Page } from 'playwright-core';
import { vpsBrowserRequest } from './vps-browser';
import { redactReportText } from '../../shared/mission';

const receiptSchema = z.object({ version: z.literal(1), policyDigest: z.string(), exactValues: z.literal(true), registeredCount: z.number().int().nonnegative(), limitation: z.string(), targetId: z.string().optional() });
const linkObservationSchema = z.object({
  method: z.literal('dom-css-visible-anchors'),
  links: z.array(z.object({ label: z.string().max(200), href: z.string().url().max(2048).refine(value => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }) }).strict()).max(40),
  truncated: z.boolean(), limitation: z.string().max(600),
}).strict();
const observationSchema = z.object({ title: z.string().max(300), headings: z.array(z.string().max(200)).max(12), text: z.string().max(2400), truncated: z.boolean(), linkObservation: linkObservationSchema.optional() }).strict();
function receipt(value: unknown, policyDigest: string, targetId?: string) {
  const result = receiptSchema.parse(value);
  if (result.policyDigest !== policyDigest || result.targetId !== targetId) throw new Error('Browser redaction receipt does not match the observation');
}

/** Only service-owned ephemeral memory gets these values; neither result nor
 * database contains the dictionary. A failed registration prevents the action. */
export async function registerBrowserTraceValues(sessionId: string, policyDigest: string, values: string[], previewId?: string) {
  const response = await vpsBrowserRequest<{ redaction: unknown }>(`/sessions/${sessionId}/redaction`, 'POST', previewId, { expectedPolicyDigest: policyDigest, values });
  receipt(response.redaction, policyDigest);
}

/** The exact CDP target binds this observation to the page used by the action
 * and screenshot. A foreground change cannot substitute a different page. */
export async function readBrowserTraceObservation(sessionId: string, policyDigest: string, page: Page, previewId?: string) {
  const cdp = await page.context().newCDPSession(page);
  let targetId: string;
  try { targetId = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; }
  finally { await cdp.detach(); }
  const response = await vpsBrowserRequest<{ redaction: unknown; observation: unknown }>(`/sessions/${sessionId}/observation`, 'POST', previewId, { expectedPolicyDigest: policyDigest, targetId });
  receipt(response.redaction, policyDigest, targetId);
  const observation = observationSchema.parse(response.observation);
  return { ...observation, title: redactReportText(observation.title), headings: observation.headings.map(value => redactReportText(value)), text: redactReportText(observation.text),
    ...(observation.linkObservation ? { linkObservation: { ...observation.linkObservation, links: observation.linkObservation.links.map(link => ({ label: redactReportText(link.label), href: redactReportText(link.href) })) } } : {}) };
}
