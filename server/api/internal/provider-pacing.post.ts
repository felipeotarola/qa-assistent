import { providerPacingRequestSchema } from '../../../shared/provider-pacing';
import { requireInternalRequest } from '../../utils/internal-api';
import { paceProviderRequest } from '../../utils/provider-pacing';

export default defineEventHandler(async event => {
  requireInternalRequest(event);
  setHeader(event, 'cache-control', 'no-store');
  return paceProviderRequest(await readValidatedBody(event, providerPacingRequestSchema.parse));
});
