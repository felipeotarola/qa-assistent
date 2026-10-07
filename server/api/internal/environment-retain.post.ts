import { requireInternalRequest } from '../../utils/internal-api';
import { authorizeMissionEnvironmentRetention } from '../../utils/mission-environment';

export default defineEventHandler(async event => {
  requireInternalRequest(event);
  setHeader(event, 'cache-control', 'no-store');
  return authorizeMissionEnvironmentRetention(await readBody(event));
});
