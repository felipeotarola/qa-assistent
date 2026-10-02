import { listVaultEntries } from '../../../utils/project-vault';
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store');
  return { entries: await listVaultEntries(await requireSessionUserId(event), getRouterParam(event, 'id')!) };
});
