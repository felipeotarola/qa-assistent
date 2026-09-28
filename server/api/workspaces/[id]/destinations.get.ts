import { destinations, operationHistory } from "../../../utils/external";
export default defineEventHandler(async event => {
  const userId = await requireSessionUserId(event);
  const id = getRouterParam(event, "id")!;
  return { destinations: await destinations(userId, id), operations: await operationHistory(userId, id) };
});
