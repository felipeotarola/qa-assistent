import { z } from 'zod';
import { requireInternalRequest } from '../../utils/internal-api';
import { getThreadForUser } from '../../utils/threads';
import { repositoryRunner } from '../../utils/repositories';
import { assignPreviewBrowser, browserAction } from '../../utils/browser';
import type { VpsBrowserSession } from '../../utils/vps-browser';
import { sandboxScope } from '../../utils/sandbox-scope';

export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const body = z.object({ userId: z.string().uuid(), threadId: z.string().uuid(), sessionKey: z.string().min(1).max(300), agentId: z.string().min(1).max(200).default('main'), input: z.record(z.string(), z.unknown()) }).parse(await readBody(event));
  const thread = await getThreadForUser(body.userId, body.threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: 'Workspace not found' });
  const { id, owner } = sandboxScope(body.userId, body.threadId, body.sessionKey);
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
