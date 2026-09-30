import { requireInternalRequest } from '../../utils/internal-api';
export default defineEventHandler(event => {
  requireInternalRequest(event); setHeader(event, 'Cache-Control', 'no-store');
  return { protocol: 1, repositoryPlans: true, sandboxes: true };
});
