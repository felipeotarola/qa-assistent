import { saveFile, requireWorkspace } from "../../../utils/workspaces";
import { requireSessionUserId } from "../../../utils/session";
export default defineEventHandler(async (event) => {
  const userId = await requireSessionUserId(event);
  const id = getRouterParam(event, "id")!;
  await requireWorkspace(userId, id);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of event.node.req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 4 * 1024 * 1024 + 65536) throw createError({ statusCode: 413, statusMessage: "Maximum file size is 4 MB" });
    chunks.push(bytes);
  }
  const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": getRequestHeader(event, "content-type") || "" } }).formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw createError({ statusCode: 400, statusMessage: "File required" });
  return { item: await saveFile(userId, id, file.name, file.type || "application/octet-stream", Buffer.from(await file.arrayBuffer())) };
});
