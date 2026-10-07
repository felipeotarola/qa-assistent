import { z } from "zod";
import { requireSessionUserId } from "../../../../../utils/session";
import { ownedItem, publicItem, saveItem } from "../../../../../utils/workspaces";
import { testPlanFromItem } from "../../../../../../shared/test-plan-conversion";

export default defineEventHandler(async event => {
  const userId = await requireSessionUserId(event);
  const workspaceId = getRouterParam(event, "id")!;
  const source = await ownedItem(userId, workspaceId, getRouterParam(event, "item")!);
  const { expectedVersion } = await readValidatedBody(event, z.object({ expectedVersion: z.number().int().positive() }).parse);
  if (source.version !== expectedVersion) throw createError({ statusCode: 409, statusMessage: "Source changed. Reload before creating a plan." });
  if (source.content.kind !== "text" && source.content.kind !== "table") throw createError({ statusCode: 400, statusMessage: "Choose a document or table" });
  return { item: await saveItem(userId, workspaceId, { title: `Testplan – ${source.title}`.slice(0, 200), content: testPlanFromItem(publicItem(source)) }, undefined, { provenance: { version: 1, origin: 'user', producer: 'user-authored', observedAt: null } }) };
});
