import { z } from 'zod';
import { requireSessionUserId } from '../../../utils/session';
import { requireWorkspace } from '../../../utils/workspaces';
import { repositoryRunner } from '../../../utils/repositories';
export default defineEventHandler(async event => {
  const workspaceId = getRouterParam(event, 'id')!;
  await requireWorkspace(await requireSessionUserId(event), workspaceId);
  const input = z.object({ id: z.string().uuid(), action: z.enum(['stop', 'delete']) }).parse(await readBody(event));
  return repositoryRunner('/sandbox-control', { ...input, workspaceId });
});
