import { destinationSchema } from "../../../../shared/external";
import { saveDestination } from "../../../utils/external";
export default defineEventHandler(async event => {
  const userId = await requireSessionUserId(event);
  const input = await readValidatedBody(event, destinationSchema.parse);
  return { destination: await saveDestination(userId, getRouterParam(event, "id")!, input) };
});
