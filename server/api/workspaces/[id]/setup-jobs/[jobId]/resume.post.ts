import { z } from 'zod';
import { resumeSetup } from '../../../../../utils/setup-jobs';
export default defineEventHandler(async event=>{
  const {revision}=await readValidatedBody(event,z.object({revision:z.number().int().positive()}).parse);
  return resumeSetup(await requireSessionUserId(event),getRouterParam(event,'id')!,getRouterParam(event,'jobId')!,revision);
});
