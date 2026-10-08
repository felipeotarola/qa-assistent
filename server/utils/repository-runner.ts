import { createError } from 'h3';

export async function callRepositoryRunner<T>(path: string, body?: unknown, timeoutMs = 10000) {
  const base = process.env.REPO_RUNNER_URL, key = process.env.REPO_RUNNER_KEY;
  if (!base || !key) throw createError({ statusCode: 503, statusMessage: 'Repository-testning är inte konfigurerad.' });
  let response: Response;
  try {
    response = await fetch(`${base.replace(/\/$/, '')}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    // A lost response is not proof a submitted operation failed. Never retry
    // writes here; their existing idempotent reconciliation owns recovery.
    throw createError({ statusCode: 503, statusMessage: 'Test service unavailable', message: 'Kunde inte nå testservern. Körstatus är okänd; inga nya försök har startats.' });
  }
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw createError({ statusCode: response.status === 400 ? 400 : 502, statusMessage: result.error?.slice(0, 200) || 'Testtjänsten är inte tillgänglig. Försök igen.' });
  }
  return await response.json() as T;
}
