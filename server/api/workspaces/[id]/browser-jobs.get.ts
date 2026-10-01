import { listBrowserJobs } from '../../../utils/browser-jobs';
export default defineEventHandler(async event => ({ workspaceId: getRouterParam(event, 'id')!, jobs: await listBrowserJobs(await requireSessionUserId(event), getRouterParam(event, 'id')!) }));
