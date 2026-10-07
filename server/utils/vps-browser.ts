import { browserLockSignal } from './browser-lock';

/** Server-only API. Viewer credentials cannot create sessions or access CDP. */
export async function vpsBrowserRequest<T>(path: string, method: 'POST' | 'DELETE' | 'GET', previewId?: string, body?: unknown) {
  const base = previewId ? process.env.REPO_RUNNER_URL : process.env.BROWSER_SERVICE_URL;
  const key = previewId ? process.env.REPO_RUNNER_KEY : process.env.BROWSER_SERVICE_KEY;
  if (!base || !key) throw createError({ statusCode: 503, statusMessage: 'VPS browser is not configured' });
  const lockSignal = browserLockSignal(), timeout = AbortSignal.timeout(25000);
  const response = await fetch(`${base.replace(/\/$/, '')}${previewId ? '/preview/' + previewId : ''}${path}`, {
    method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: lockSignal ? AbortSignal.any([lockSignal, timeout]) : timeout,
  });
  if (['DELETE', 'GET'].includes(method) && response.status === 404) return undefined as T;
  if (!response.ok) throw createError({ statusCode: response.status, statusMessage: response.status === 409 ? 'VPS browser capacity reached' : 'VPS browser service unavailable' });
  return await response.json() as T;
}

export interface VpsBrowserSession {
  sessionId: string;
  connectUrl: string;
  liveUrl: string;
  expiresAt: string;
  policyVersion?: number;
  policyDigest?: string;
}
