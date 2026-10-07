import { requireInternalRequest } from '../../../utils/internal-api';
import { reconcileClosedMissionResources, runMissionController } from '../../../utils/mission-controller';
export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const deadline = Date.now() + 170_000;
  await reconcileClosedMissionResources();
  let processed = 0;
  while (processed < 8 && Date.now() < deadline) {
    const result = await runMissionController();
    if (!result.processed) break;
    processed++;
  }
  return { ok: true, processed };
});
