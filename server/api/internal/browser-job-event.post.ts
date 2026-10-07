import { requireInternalRequest } from '../../utils/internal-api';
import { recordBrowserJobEvent } from '../../utils/browser-jobs';
import { irisEventSchema } from '../../../shared/browser-job';
export default defineEventHandler(async event => {
  requireInternalRequest(event);
  return recordBrowserJobEvent(await readValidatedBody(event, irisEventSchema.parse));
});
