import { listSetupJobs } from '../../../utils/setup-jobs';
export default defineEventHandler(async event=>{
  setHeader(event,'Cache-Control','no-store');
  const workspaceId=getRouterParam(event,'id')!;
  return {workspaceId,jobs:await listSetupJobs(await requireSessionUserId(event),workspaceId)};
});
