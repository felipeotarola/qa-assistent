import { requireInternalRequest } from '../../utils/internal-api';
import { releaseMissionEnvironment } from '../../utils/mission-environment';

export default defineEventHandler(async event => {
  requireInternalRequest(event);
  setHeader(event, 'Cache-Control', 'no-store');
  return releaseMissionEnvironment(await readBody(event));
});
