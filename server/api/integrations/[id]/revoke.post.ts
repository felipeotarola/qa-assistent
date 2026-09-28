import { getConnector } from "~~/server/connectors";
import { connectorIdParamsSchema } from "~~/server/schemas/integrations";
import { probeStatus, revokeConnection } from "~~/server/utils/connect";
import { throwConnectError } from "~~/server/utils/errors";
import { requireSessionUserId } from "~~/server/utils/session";
import { getRequestOrigin } from "~~/server/utils/h3-node";

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, connectorIdParamsSchema.parse);

  const connector = getConnector(id);
  const userId = await requireSessionUserId(event);
  if (getHeader(event, "origin") && getHeader(event, "origin") !== getRequestOrigin(event)) throw createError({ statusCode: 403 });
  const status = await probeStatus(connector, userId);
  const installationId = status.state === "connected" ? status.installationId : undefined;

  try {
    await revokeConnection(connector, userId, installationId);
    return { ok: true };
  }
  catch (error) {
    throwConnectError(error);
  }
});
