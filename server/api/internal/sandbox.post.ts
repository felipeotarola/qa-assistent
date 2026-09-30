import { createHmac, createHash } from 'node:crypto';
import { z } from 'zod';
import { requireInternalRequest } from '../../utils/internal-api';
import { getThreadForUser } from '../../utils/threads';
import { repositoryRunner } from '../../utils/repositories';
import { assignPreviewBrowser, browserAction } from '../../utils/browser';
import type { VpsBrowserSession } from '../../utils/vps-browser';

export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const body = z.object({ userId: z.string().uuid(), threadId: z.string().uuid(), sessionKey: z.string().min(1).max(300), agentId: z.string().min(1).max(200).default('main'), input: z.record(z.string(), z.unknown()) }).parse(await readBody(event));
  const thread = await getThreadForUser(body.userId, body.threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: 'Workspace not found' });
  const scope = `${body.userId}:${body.threadId}:${body.sessionKey}`;
  const hex = createHash('sha256').update(scope).digest('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const owner = createHmac('sha256', process.env.INTERNAL_API_SECRET!).update(scope).digest('hex');
  if (body.input.action === 'preview') {
    const port = z.number().int().min(1024).max(65535).parse(body.input.port);
    const session = await repositoryRunner<VpsBrowserSession & { sandboxId: string; previewUrl: string }>('/preview', { id, owner, workspaceId: thread.workspaceId, port }, 40000);
    await assignPreviewBrowser(body.userId, body.threadId, body.agentId, session);
    return browserAction(body.userId, body.threadId, { action: 'open', url: session.previewUrl }, body.agentId);
  }
  // Scope comes from authenticated Eve context and the application's thread record.
  // Model-controlled input can never override ownership.
  return repositoryRunner('/sandbox', { ...body.input, id, owner, workspaceId: thread.workspaceId });
});
