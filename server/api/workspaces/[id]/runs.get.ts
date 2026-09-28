import { requireSessionUserId } from '../../../utils/session';
import { listTestRuns } from '../../../utils/test-runs';
export default defineEventHandler(async event => listTestRuns(await requireSessionUserId(event), getRouterParam(event, 'id')!));
