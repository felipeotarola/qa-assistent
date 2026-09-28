import { completeLinearOAuth } from "../../../utils/linear-oauth";
export default defineEventHandler(async event => {
  if (getRouterParam(event, "id") !== "linear") throw createError({ statusCode: 404 });
  return completeLinearOAuth(event);
});
