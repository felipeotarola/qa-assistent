/** Server-only API. Viewer credentials cannot create sessions or access CDP. */
export async function vpsBrowserRequest<T>(path: string, method: 'POST' | 'DELETE') {
  const base = process.env.BROWSER_SERVICE_URL;
  const key = process.env.BROWSER_SERVICE_KEY;
  if (!base || !key) throw createError({ statusCode: 503, statusMessage: 'VPS browser is not configured' });
  const response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    method, headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(25000),
  });
  if (method === 'DELETE' && response.status === 404) return undefined as T;
  if (!response.ok) throw createError({ statusCode: response.status, statusMessage: response.status === 409 ? 'VPS browser is occupied' : 'VPS browser service unavailable' });
  return await response.json() as T;
}

export interface VpsBrowserSession {
  sessionId: string;
  connectUrl: string;
  liveUrl: string;
  expiresAt: string;
}
