import { requireSessionUserId } from '../../../utils/session';
import { reviewTestRun } from '../../../utils/test-runs';
export default defineEventHandler(async event => reviewTestRun(await requireSessionUserId(event), getRouterParam(event, 'id')!, await readBody(event)));
