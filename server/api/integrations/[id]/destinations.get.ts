import { z } from "zod";
import { providerSchema } from "../../../../shared/external";
import { externalAdapter } from "../../../utils/external";
export default defineEventHandler(async event => {
  const userId = await requireSessionUserId(event);
  const provider = providerSchema.parse(getRouterParam(event, "id"));
  const query = await getValidatedQuery(event, z.object({ teamId: z.string().max(200).optional(), cursor: z.string().max(300).optional() }).parse);
  const adapter = await externalAdapter(provider, userId);
  try { return query.teamId ? await adapter.projects(query.teamId, query.cursor) : await adapter.destinations(query.cursor); }
  finally { await adapter.close().catch(() => undefined); }
});
