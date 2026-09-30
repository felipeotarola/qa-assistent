import { requireSessionUserId } from '../../../utils/session';
import { requireWorkspace } from '../../../utils/workspaces';
import { repositoryRunner } from '../../../utils/repositories';
import type { SandboxState } from '../../../../shared/sandbox';
export default defineEventHandler(async event => {
  const workspaceId = getRouterParam(event, 'id')!;
  await requireWorkspace(await requireSessionUserId(event), workspaceId);
  setHeader(event, 'Cache-Control', 'no-store');
  return repositoryRunner<{ sessions: SandboxState[] }>(`/sandboxes?workspaceId=${encodeURIComponent(workspaceId)}`);
});
