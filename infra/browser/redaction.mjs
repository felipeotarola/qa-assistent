import { browserPolicyDigest } from './policy.mjs';

export const REDACTION_LIMITS = Object.freeze({ values: 64, valueLength: 10000, bytes: 128 * 1024, observationLength: 1024 * 1024, fields: 512, linkNodes: 512, links: 40, linkLabel: 200, linkHref: 2048 });
const linkLimitation = 'DOM anchors passing CSS visibility and nonempty layout checks at observation time. No viewport, occlusion, rendered text, click or HTTP-response proof. Query, fragment and URL credentials omitted; known exact field values redacted. Bounded list, not proof of absence.';
const limitation = 'Exact known field values only; transformed or partial echoes are not covered. This is not general DLP or screenshot redaction.';
export class RedactionError extends Error {
  constructor(code, status = 413) { super(code); this.code = code; this.status = status; }
}

/** This state belongs only to the existing physical browser session. Private
 * fields deliberately do not serialize into snapshots, events or log output. */
export class SessionRedaction {
  #values = new Set();
  clear() { this.#values.clear(); }
  register(values) {
    if (!Array.isArray(values) || values.length > REDACTION_LIMITS.fields
      || values.some(value => typeof value !== 'string' || value.length > REDACTION_LIMITS.valueLength)) throw new RedactionError('Invalid redaction values');
    const next = new Set([...this.#values, ...values.filter(Boolean)]);
    if (next.size > REDACTION_LIMITS.values || [...next].reduce((sum, value) => sum + Buffer.byteLength(value, 'utf8'), 0) > REDACTION_LIMITS.bytes) throw new RedactionError('Redaction capacity reached');
    // Never evict an earlier value: a navigation or worker restart can expose it again.
    this.#values = next;
  }
  receipt(policyDigest) { return { version: 1, policyDigest, exactValues: true, registeredCount: this.#values.size, limitation }; }
  observation(raw) {
    if (!raw || raw.tooLarge || typeof raw.title !== 'string' || typeof raw.text !== 'string' || !Array.isArray(raw.headings)
      || raw.headings.length > 12 || raw.headings.some(value => typeof value !== 'string')
      || [raw.title, raw.text, ...raw.headings].some(value => value.length > REDACTION_LIMITS.observationLength)
      || !Array.isArray(raw.links) || raw.links.length > REDACTION_LIMITS.links || typeof raw.linksTruncated !== 'boolean'
      || raw.links.some(link => !link || typeof link.label !== 'string' || typeof link.href !== 'string'
        || link.label.length > REDACTION_LIMITS.observationLength || link.href.length > REDACTION_LIMITS.observationLength)) throw new RedactionError('Observation exceeds redaction limits');
    // Current fields are also registered before any text leaves the service.
    this.register(raw.fields);
    const ordered = [...this.#values].sort((a, b) => b.length - a.length);
    const pattern = ordered.length ? new RegExp(ordered.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gu') : null;
    const clean = (value, limit) => {
      // One pass: a later field must not match/re-expand the replacement marker.
      if (pattern) value = value.replace(pattern, '[REDACTED]');
      return { value: value.slice(0, limit), truncated: value.length > limit };
    };
    const text = clean(raw.text, 2400);
    // URL serialisation can percent-encode an exact field value. Redact those
    // exact encodings too, without decoding a path and changing its semantics.
    const urlValues = [...new Set(ordered.flatMap(value => [value, encodeURI(value.toWellFormed()), encodeURIComponent(value.toWellFormed())]))].sort((a, b) => b.length - a.length);
    const urlPattern = urlValues.length ? new RegExp(urlValues.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/%([0-9a-f]{2})/gi, (_match, hex) => '%' + [...hex].map(char => /[a-f]/i.test(char) ? `[${char.toLowerCase()}${char.toUpperCase()}]` : char).join(''))).join('|'), 'gu') : null;
    let linksTruncated = raw.linksTruncated;
    const links = [];
    for (const link of raw.links) {
      const label = clean(link.label, REDACTION_LIMITS.linkLabel);
      try {
        const url = new URL(link.href);
        if (!['http:', 'https:'].includes(url.protocol)) { linksTruncated = true; continue; }
        url.username = ''; url.password = ''; url.search = ''; url.hash = '';
        const href = urlPattern ? url.href.replace(urlPattern, '[REDACTED]') : url.href;
        // Never return a clipped/invalid destination as if it were the href.
        if (href.length > REDACTION_LIMITS.linkHref || !['http:', 'https:'].includes(new URL(href).protocol)) { linksTruncated = true; continue; }
        links.push({ label: label.value, href }); linksTruncated ||= label.truncated;
      } catch { linksTruncated = true; }
    }
    return { title: clean(raw.title, 300).value, headings: raw.headings.map(value => clean(value, 200).value), text: text.value,
      truncated: text.truncated || raw.text.length > 2400,
      linkObservation: { method: 'dom-css-visible-anchors', links, truncated: linksTruncated, limitation: linkLimitation } };
  }
}

/** A viewer credential is never accepted here; the HTTP caller already passed
 * the service bearer check. Recheck after awaits to fence control handoffs. */
export function requireRedactionSession(session, expectedPolicyDigest, epoch = session?.controlEpoch, now = Date.now()) {
  if (!session || session.closing || !session.policy || session.control !== 'agent' || session.controlEpoch !== epoch
    || session.expiresAt <= now || Date.parse(session.policy.deadlineAt) <= now
    || typeof expectedPolicyDigest !== 'string' || expectedPolicyDigest !== browserPolicyDigest(session.policy)) {
    throw new RedactionError('Redaction session unavailable', 409);
  }
  return expectedPolicyDigest;
}

/** Gather untruncated strings inside the service, then sanitize in service-owned
 * memory. Never inject the historical dictionary into the target page. Oversize
 * observations fail closed rather than returning a possibly unredacted prefix. */
export async function readRedactionObservation(page) {
  return page.locator('body').evaluate((body, limits) => {
    const nodes = body.querySelectorAll('input,textarea,[contenteditable=true]');
    if (nodes.length > limits.fields) return { tooLarge: true };
    const fields = Array.from(nodes).map(node => 'value' in node ? String(node.value) : node.textContent || '');
    const title = document.title, text = body.innerText;
    const headings = Array.from(body.querySelectorAll('h1,h2,h3')).slice(0, 12).map(node => node.textContent || '');
    if (fields.some(value => value.length > limits.valueLength) || [title, text, ...headings].some(value => value.length > limits.observationLength)) return { tooLarge: true };
    const anchors = body.querySelectorAll('a[href]'), links = [];
    let linksTruncated = anchors.length > limits.linkNodes;
    for (let i = 0; i < Math.min(anchors.length, limits.linkNodes); i++) {
      const node = anchors[i];
      if (!node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        || !Array.from(node.getClientRects()).some(rect => rect.width > 0 && rect.height > 0)) continue;
      if (links.length >= limits.links) { linksTruncated = true; break; }
      const label = node.innerText.trim(), href = node.href;
      // Do not truncate before registering/redacting exact historical values.
      if (label.length > limits.observationLength || href.length > limits.observationLength) return { tooLarge: true };
      links.push({ label, href });
    }
    return { title, text, headings, fields, links, linksTruncated };
  }, REDACTION_LIMITS);
}

/** Resolve the exact action page; another foreground tab is never a substitute. */
export async function redactionPage(context, targetId) {
  if (typeof targetId !== 'string' || !/^[\w-]{1,200}$/.test(targetId)) throw new RedactionError('Invalid observation target', 400);
  for (const page of context.pages()) {
    let session;
    try {
      session = await context.newCDPSession(page);
      const { targetInfo } = await session.send('Target.getTargetInfo');
      if (targetInfo.targetId === targetId) return page;
    } catch { /* Closed pages cannot provide an observation. */ }
    finally { await session?.detach().catch(() => {}); }
  }
  throw new RedactionError('Observation target not found', 404);
}
