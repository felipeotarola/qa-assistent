import { notifyReviewedResults } from '../../../utils/result-review-notifications';
import { requireInternalRequest } from '../../../utils/internal-api';
import { processReviewQueue } from '../../../utils/result-review-worker';
export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const result = await processReviewQueue();
  await notifyReviewedResults();
  return result;
});
