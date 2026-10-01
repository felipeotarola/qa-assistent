import { saveQuality } from '../../../utils/quality';
import { requireSessionUserId } from '../../../utils/session';
export default defineEventHandler(async event => saveQuality(await requireSessionUserId(event), getRouterParam(event, 'id')!, await readBody(event)));
