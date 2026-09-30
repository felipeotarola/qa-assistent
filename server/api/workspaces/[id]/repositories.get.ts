import { listRepositories } from '../../../utils/repositories';
import { requireSessionUserId } from '../../../utils/session';
export default defineEventHandler(async event => listRepositories(await requireSessionUserId(event), getRouterParam(event, 'id')!));
