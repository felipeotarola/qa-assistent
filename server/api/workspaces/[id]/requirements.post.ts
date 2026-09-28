import { requirementAction, publishRequirement } from '../../../utils/test-requirements';
import { requirementPublishSchema } from '../../../../shared/test-requirement';
import { requireSessionUserId } from '../../../utils/session';
export default defineEventHandler(async event => {
  const userId = await requireSessionUserId(event);
  const workspaceId = getRouterParam(event, 'id')!;
  const input = await readBody(event);
  if (input?.action === 'publish') {
    const parsed = requirementPublishSchema.safeParse(input);
    if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Ogiltigt förslag eller planversion.' });
    return publishRequirement(userId, workspaceId, parsed.data.id, parsed.data.expectedVersion);
  }
  return requirementAction(userId, workspaceId, input);
});
