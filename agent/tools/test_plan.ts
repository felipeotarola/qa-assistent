import { defineTool } from "eve/tools";
import { z } from "zod";
import { appOrigin, internalHeaders } from "../lib/internal-api";
export default defineTool({
  description: "Check a test plan's Linear publication status or publish its current version to the workspace's configured Linear destination. Use workspace to create/edit/read test_plan objects. Publish ONLY when the user requests saving/updating the plan in Linear. Reads and preserves unrelated issue content, creates once and updates the same linked issue on subsequent versions. Requires itemId and expectedVersion from the latest workspace read. Do not separately create an issue with external for the same plan. On uncertain outcomes inspect status; never create a fallback duplicate. Does not execute tests or publish screenshots as attachments. Returns the real saved issue URL after confirmation.",
  inputSchema: z.object({ action: z.enum(["status", "publish"]), itemId: z.string().uuid(), expectedVersion: z.number().int().positive().optional() }),
  async execute(input, ctx) {
    const auth = ctx.session.auth.current;
    const threadId = auth?.attributes.browserThreadId;
    if (auth?.authenticator !== "app" || typeof threadId !== "string") return { error: "Requires a web chat" };
    const response = await fetch(`${appOrigin()}/api/internal/test-plan`, { method: "POST", headers: internalHeaders(), signal: ctx.abortSignal, body: JSON.stringify({ userId: auth.principalId, threadId, ...input }) });
    if (!response.ok) { const detail = await response.json().catch(() => ({})); return { error: detail.statusMessage || "Test plan publication failed. Do not claim success.", status: response.status }; }
    return response.json();
  },
});
