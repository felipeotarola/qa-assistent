import { revokeEnvironmentConsent } from '../../../../../utils/environment-consents';

export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store');
  return revokeEnvironmentConsent(await requireSessionUserId(event), getRouterParam(event, 'id')!, getRouterParam(event, 'consentId')!, await readBody(event));
});
