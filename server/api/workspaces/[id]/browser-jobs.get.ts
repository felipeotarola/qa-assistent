import { listBrowserJobs } from '../../../utils/browser-jobs';
export default defineEventHandler(async event => ({ jobs: await listBrowserJobs(await requireSessionUserId(event), getRouterParam(event, 'id')!) }));
