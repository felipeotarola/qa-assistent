import { eq, desc } from 'drizzle-orm';
import { db, schema } from '@nuxthub/db';
import { repositoryRuns } from '../../../db/schema/repositories';
import { requireSessionUserId } from '../../../utils/session';
import { requireWorkspace } from '../../../utils/workspaces';
import { repositoryRunner } from '../../../utils/repositories';
import { repoTerminal } from '../../../../shared/repository';

export default defineEventHandler(async event => {
  const userId = await requireSessionUserId(event), workspaceId = getRouterParam(event, 'id')!;
  await requireWorkspace(userId, workspaceId);
  const origin = getRequestURL(event).origin;
  const runs = await db.select().from(repositoryRuns).where(eq(repositoryRuns.workspaceId, workspaceId)).orderBy(desc(repositoryRuns.createdAt)).limit(30);
  const browsers = await db.select().from(schema.browserAssignments).where(eq(schema.browserAssignments.workspaceId, workspaceId));
  const [legacy] = await db.select().from(schema.workspaceBrowsers).where(eq(schema.workspaceBrowsers.workspaceId, workspaceId));
  if (legacy) browsers.push({ ...legacy, id: workspaceId, threadId: '', agentId: 'main' });
  const streams: { kind: 'repository' | 'browser'; url: string; expiresAt: number }[] = [];
  const ids = runs.filter((run, index) => index === 0 || !run.job || !repoTerminal(run.job.status)).map(run => run.id);
  try {
    const { sessions } = await repositoryRunner<{ sessions: { id: string }[] }>(`/sandboxes?workspaceId=${encodeURIComponent(workspaceId)}`);
    ids.push(...sessions.map(session => session.id));
  } catch { /* Older workers have no sandbox endpoint. */ }
  if (ids.length && process.env.REPO_RUNNER_URL) {
    try {
      const grant = await repositoryRunner<{ token: string; expiresAt: number }>('/subscriptions', { ids: ids.slice(-30), origin });
      streams.push({ kind: 'repository', url: `${process.env.REPO_RUNNER_URL.replace(/\/$/, '')}/events?token=${encodeURIComponent(grant.token)}`, expiresAt: grant.expiresAt });
    } catch { /* Rollout / unavailable worker: shared polling remains active. */ }
  }
  const browserIds = browsers.filter(b => b.sessionId && (b.projectId === 'self-hosted-v1' || b.projectId?.startsWith('self-hosted-policy-v1:')) && b.expiresAt && b.expiresAt > new Date()).map(b => b.sessionId!);
  if (browserIds.length && process.env.BROWSER_SERVICE_URL && process.env.BROWSER_SERVICE_KEY) {
    try {
      const response = await fetch(`${process.env.BROWSER_SERVICE_URL.replace(/\/$/, '')}/subscriptions`, { method: 'POST', headers: { authorization: `Bearer ${process.env.BROWSER_SERVICE_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ ids: browserIds.slice(0, 30), origin }), signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const grant = await response.json() as { token: string; expiresAt: number };
        streams.push({ kind: 'browser', url: `${process.env.BROWSER_SERVICE_URL.replace(/\/$/, '')}/events?token=${encodeURIComponent(grant.token)}`, expiresAt: grant.expiresAt });
      }
    } catch { /* Existing browser view stays available. */ }
  }
  setHeader(event, 'Cache-Control', 'no-store');
  return { streams };
});
