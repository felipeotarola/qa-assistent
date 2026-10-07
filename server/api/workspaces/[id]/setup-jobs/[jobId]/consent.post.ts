import { grantEnvironmentConsent } from '../../../../../utils/environment-consents';

export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store');
  return grantEnvironmentConsent(await requireSessionUserId(event), getRouterParam(event, 'id')!, getRouterParam(event, 'jobId')!, await readBody(event));
});
