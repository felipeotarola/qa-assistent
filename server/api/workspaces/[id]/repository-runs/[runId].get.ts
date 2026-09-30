import { getRepositoryRun } from '../../../../utils/repositories';
import { requireSessionUserId } from '../../../../utils/session';
export default defineEventHandler(async event => getRepositoryRun(await requireSessionUserId(event), getRouterParam(event, 'id')!, getRouterParam(event, 'runId')!));
