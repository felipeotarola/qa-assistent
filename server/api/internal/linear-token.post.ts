import { z } from "zod";
import { requireInternalRequest } from "../../utils/internal-api";
import { linearToken } from "../../utils/linear-oauth";
export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const { userId } = await readValidatedBody(event, z.object({ userId: z.string().uuid() }).parse);
  setHeader(event, "Cache-Control", "no-store");
  return { token: await linearToken(userId) };
});
