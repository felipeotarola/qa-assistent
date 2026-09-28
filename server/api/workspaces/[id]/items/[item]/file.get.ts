import { get } from "@vercel/blob";
import { ownedItem, workspaceBlobToken } from "../../../../../utils/workspaces";
import { requireSessionUserId } from "../../../../../utils/session";
export default defineEventHandler(async (event) => {
  const item = await ownedItem(await requireSessionUserId(event), getRouterParam(event, "id")!, getRouterParam(event, "item")!);
  if (!item.blobPath) throw createError({ statusCode: 404 });
  const blob = await get(item.blobPath, { access: "private", token: workspaceBlobToken() });
  if (!blob || blob.statusCode !== 200) throw createError({ statusCode: 404 });
  const image = item.content.kind === "image";
  setResponseHeader(event, "Cache-Control", "private, no-store");
  setResponseHeader(event, "X-Content-Type-Options", "nosniff");
  setResponseHeader(event, "Content-Type", image && "mime" in item.content ? item.content.mime : "application/octet-stream");
  setResponseHeader(event, "Content-Disposition", `${image ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(item.title)}`);
  return sendStream(event, blob.stream);
});
