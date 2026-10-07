import type { Locator } from 'playwright-core';
import { sanitizeEvidenceUrl } from '../../shared/evidence-provenance';
import { redactReportText } from '../../shared/mission';
import type { BrowserExecution } from './browser-mission-guard';

export interface BrowserActionTrace {
  version: 1;
  browserJobId: string;
  callId: string;
  execution: BrowserExecution;
  action: string;
  startedAt: string;
  finishedAt: string;
  fromUrl: string | null;
  toUrl: string | null;
  httpStatus: number | null;
  outcome: 'observed' | 'action_failed';
  failedRequests: { url: string | null; method: string; reason: 'policy_blocked' | 'request_failed' }[];
  observation: { title: string; headings: string[]; text: string; truncated: boolean;
    linkObservation?: { method: 'dom-css-visible-anchors'; links: { label: string; href: string }[]; truncated: boolean; limitation: string };
  } | null;
  filledField?: Awaited<ReturnType<typeof traceFilledField>>;
  limitation: string;
}

/** Observe predicates in the browser, without returning the requested or actual
 * value. Privacy masks must not prevent verifying a normal field's behaviour.
 * This is DOM evidence, not pixel/OCR proof or a claim about submitted data. */
export async function traceFilledField(locator: Locator, requested: string) {
  const result = await locator.evaluate((element, expected) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return null;
    const style = getComputedStyle(element);
    const cssVisible = element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const security = style.getPropertyValue('-webkit-text-security');
    const masked = element instanceof HTMLInputElement && element.type === 'password' || !!security && security !== 'none';
    return {
      method: 'dom-value-and-css' as const,
      control: { tag: element.tagName.toLowerCase(), type: element instanceof HTMLInputElement ? element.type : 'textarea',
        label: element.getAttribute('aria-label') || Array.from(element.labels || []).map(label => label.innerText).join(' ') || element.getAttribute('placeholder') || '' },
      valueMatchesRequested: element.value === expected,
      nonEmpty: element.value.length > 0,
      cssVisible,
      masking: masked ? 'masked' as const : 'not-detected' as const,
      limitation: 'CSS visibility does not prove viewport position, occlusion or rendered text. Masking checks input type and text-security only.' as const,
    };
  }, requested);
  if (!result) return null;
  const label = requested ? result.control.label.split(requested).join('[REDACTED]') : result.control.label;
  return { ...result, control: { ...result.control, label: redactReportText(label).slice(0, 300) }, observedAt: new Date().toISOString() };
}

/** Query values and fragments can contain form input even without a secret key. */
export function traceUrl(value: string | null | undefined) {
  const sanitized = sanitizeEvidenceUrl(value);
  if (!sanitized) return null;
  const url = new URL(sanitized);
  for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[REDACTED]');
  url.hash = '';
  return url.href;
}

/** Minimal observation returned only beside the committed actionTrace receipt.
 * No requested/actual value, label, URL or arbitrary page-controlled field. */
export function savedFieldObservation(trace: BrowserActionTrace) {
  const field = trace.action === 'fill' && trace.outcome === 'observed' ? trace.filledField : null;
  if (!field) return null;
  return { method: field.method, valueMatchesRequested: field.valueMatchesRequested,
    nonEmpty: field.nonEmpty, cssVisible: field.cssVisible, masking: field.masking,
    observedAt: field.observedAt, limitation: field.limitation };
}

/** Navigation observed during this exact action, returned beside its committed
 * evidence. A missing response is unknown, never inferred from tool success. */
export function savedNavigationObservation(trace: BrowserActionTrace) {
  return { httpStatus: trace.httpStatus, fromUrl: traceUrl(trace.fromUrl), toUrl: traceUrl(trace.toUrl),
    outcome: trace.outcome, observedAt: trace.finishedAt,
    limitation: 'HTTP status is the observed main-frame navigation response for this action, when available. It does not alone prove the expected page or interaction. Null means no matching response was observed; do not infer a status or reuse another action.' };
}
