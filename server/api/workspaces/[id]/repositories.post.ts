import { repositoryAction } from '../../../utils/repositories';
import { requireSessionUserId } from '../../../utils/session';
export default defineEventHandler(async event => repositoryAction(await requireSessionUserId(event), getRouterParam(event, 'id')!, await readBody(event)));
