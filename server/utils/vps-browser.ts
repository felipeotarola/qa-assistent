/** Server-only API. Viewer credentials cannot create sessions or access CDP. */
export async function vpsBrowserRequest<T>(path: string, method: 'POST' | 'DELETE' | 'GET', previewId?: string) {
  const base = previewId ? process.env.REPO_RUNNER_URL : process.env.BROWSER_SERVICE_URL;
  const key = previewId ? process.env.REPO_RUNNER_KEY : process.env.BROWSER_SERVICE_KEY;
  if (!base || !key) throw createError({ statusCode: 503, statusMessage: 'VPS browser is not configured' });
  const response = await fetch(`${base.replace(/\/$/, '')}${previewId ? '/preview/' + previewId : ''}${path}`, {
    method, headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(25000),
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
}
