import { providerSchema } from "../../../../shared/external";
import { removeDestination } from "../../../utils/external";
export default defineEventHandler(async event => {
  const userId = await requireSessionUserId(event);
  const provider = providerSchema.parse(getQuery(event).provider);
  await removeDestination(userId, getRouterParam(event, "id")!, provider);
  return { removed: true };
});
