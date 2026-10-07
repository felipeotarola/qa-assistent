import { createHash } from 'node:crypto';

/** Set only by the authenticated application, before Chromium is started.
 * This policy belongs to the browser service so it survives app disconnects. */
export function parseBrowserPolicy(value, now = Date.now()) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['version', 'allowedOrigins', 'readOnly', 'deadlineAt'].includes(key))
    || value.version !== 1 || value.readOnly !== true
    || !Array.isArray(value.allowedOrigins) || value.allowedOrigins.length < 1 || value.allowedOrigins.length > 20
    || typeof value.deadlineAt !== 'string') throw new Error('Invalid browser policy');
  const deadline = Date.parse(value.deadlineAt);
  if (!Number.isFinite(deadline) || deadline <= now || deadline > now + 24 * 60 * 60 * 1000) throw new Error('Invalid browser policy deadline');
  const origins = value.allowedOrigins.map(origin => {
    if (typeof origin !== 'string' || origin.length > 2000) throw new Error('Invalid browser origin');
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password || url.hostname.includes('*')) throw new Error('Invalid browser origin');
    return origin;
  });
  if (new Set(origins).size !== origins.length) throw new Error('Duplicate browser origin');
  return { version: 1, allowedOrigins: origins.sort(), readOnly: true, deadlineAt: new Date(deadline).toISOString() };
}

export function browserPolicyDigest(policy) {
  return createHash('sha256').update(JSON.stringify({ version: policy.version, allowedOrigins: [...policy.allowedOrigins].sort(), readOnly: policy.readOnly, deadlineAt: new Date(policy.deadlineAt).toISOString() })).digest('hex');
}

/** Subresources can use public CDNs; all navigation stays in the mandate.
 * Only the service's authenticated human-control state can permit a login POST.
 * Never take `control` from page content, a request header or a model tool.
 * The caller must ALSO apply the existing destination/SSRF network policy. */
export function browserRequestAllowed(policy, request, now = Date.now(), control = 'agent') {
  if (!policy) return true;
  if (now >= Date.parse(policy.deadlineAt)) return false;
  try {
    const url = new URL(request.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      return control === 'human' && request.method === 'POST' && policy.allowedOrigins.includes(url.origin);
    }
    return !request.navigation || policy.allowedOrigins.includes(url.origin);
  } catch { return false; }
}

/** Recheck ownership after asynchronous DNS/destination admission. An earlier
 * human epoch cannot authorize a POST once control has returned to the agent.
 * This cannot recall an HTTP request already sent before the handoff. */
export async function admitBrowserRequest(policy, request, readControl, publicDestination, now = Date.now) {
  const initial = readControl();
  const active = state => state && !state.closing && now() < state.expiresAt;
  if (!active(initial) || !browserRequestAllowed(policy, request, now(), initial.control)) return false;
  if (!await publicDestination(request.url)) return false;
  const current = readControl();
  return !!(active(current) && current.controlEpoch === initial.controlEpoch && current.control === initial.control
    && browserRequestAllowed(policy, request, now(), current.control));
}

export function humanInputAllowed(session, epoch, now = Date.now()) {
  return !!session && !session.closing && session.control === 'human'
    && Number.isSafeInteger(epoch) && epoch === session.controlEpoch && now < session.expiresAt;
}
