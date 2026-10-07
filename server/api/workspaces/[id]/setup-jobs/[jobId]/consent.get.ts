import { environmentConsentStatus } from '../../../../../utils/environment-consents';

export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store');
  return environmentConsentStatus(await requireSessionUserId(event), getRouterParam(event, 'id')!, getRouterParam(event, 'jobId')!);
});
