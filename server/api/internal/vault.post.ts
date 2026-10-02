import { z } from 'zod';
import { requireInternalRequest } from '../../utils/internal-api';
import { getThreadForUser } from '../../utils/threads';
import { listVaultEntries } from '../../utils/project-vault';

export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const { userId, threadId } = z.object({ userId: z.string().uuid(), threadId: z.string().uuid() }).parse(await readBody(event));
  const thread = await getThreadForUser(userId, threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: 'Workspace not found' });
  setHeader(event, 'Cache-Control', 'no-store');
  return { entries: await listVaultEntries(userId, thread.workspaceId), note: 'Names only. Saved keys are not necessarily applied to this sandbox. Report the verified environment plan and use Vault to confirm application; never ask to re-enter saved keys.' };
});
