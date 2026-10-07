import { requireInternalRequest } from '../../../../utils/internal-api';
import { admitMissionExecutor } from '../../../../utils/mission-executor-admission';

export default defineEventHandler(async event => {
  requireInternalRequest(event);
  setHeader(event, 'Cache-Control', 'no-store');
  return admitMissionExecutor(await readBody(event));
});
