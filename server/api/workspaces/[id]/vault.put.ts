import { saveVaultEntry } from '../../../utils/project-vault';
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store');
  return saveVaultEntry(await requireSessionUserId(event), getRouterParam(event, 'id')!, await readBody(event));
});
