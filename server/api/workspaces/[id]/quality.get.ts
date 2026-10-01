import { getQuality } from '../../../utils/quality';
import { requireSessionUserId } from '../../../utils/session';
export default defineEventHandler(async event => getQuality(await requireSessionUserId(event), getRouterParam(event, 'id')!));
