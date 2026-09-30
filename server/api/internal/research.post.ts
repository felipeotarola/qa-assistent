import { z } from "zod";
import { researchSchema } from "../../../shared/research";
import { requireInternalRequest } from "../../utils/internal-api";
import { researchPage } from "../../utils/research";
export default defineEventHandler(async event => {
  requireInternalRequest(event);
  const { userId, threadId, input } = await readValidatedBody(event, z.object({ userId: z.string().uuid(), threadId: z.string().uuid(), input: researchSchema }).parse);
  try { return await researchPage(userId, threadId, input); }
  catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    throw createError({ statusCode: status && [400, 404, 409, 503].includes(status) ? status : 502, statusMessage: status === 409
      ? 'Research browser capacity is full. Wait for a session to finish; do not close another workspace browser.'
      : 'Research failed. Check the public URL, configured browser service and private file storage. No result should be assumed.' });
  }
});
