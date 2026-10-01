import { configureSetup } from '../../../../utils/setup-jobs';
export default defineEventHandler(async event=>{
  setHeader(event,'Cache-Control','no-store');
  return configureSetup(await requireSessionUserId(event),getRouterParam(event,'id')!,getRouterParam(event,'jobId')!,await readBody(event));
});
