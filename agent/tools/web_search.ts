import { denyIrisCapability } from '../lib/iris-capabilities';
import { defineTool } from "eve/tools";
import { z } from "zod";
import { appOrigin, internalHeaders } from "../lib/internal-api";

// Override Eve's provider-managed search: Grunden supports ordinary function
// calls, but cannot execute AI Gateway's provider-defined Exa tool.
export default defineTool({
  description: "Search the public web with a query using temporary background Chromium and Bing. Returns the rendered search page and links, not verified facts. Open relevant result URLs with research or web_fetch before citing them. Search text is sent to a public search engine: never include secrets or private ticket/document contents. If results are blocked by a challenge or unavailable, say so; never invent results or bypass a human-control pause. Requires a web chat. Does not open or change the live workspace browser.",
  inputSchema: z.object({ query: z.string().trim().min(1).max(500) }),
  async execute({ query }, ctx) {
    denyIrisCapability(ctx);
    const auth = ctx.session.auth.current;
    const threadId = auth?.attributes.browserThreadId;
    if (auth?.authenticator !== "app" || typeof threadId !== "string" || !threadId) return { error: "Web search requires a web chat." };
    const url = new URL("https://www.bing.com/search");
    url.searchParams.set("q", query);
    const response = await fetch(`${appOrigin()}/api/internal/research`, {
      method: "POST", headers: internalHeaders(), signal: ctx.abortSignal,
      body: JSON.stringify({ userId: auth.principalId, threadId, input: { url: url.href, screenshot: false } }),
    });
    if (!response.ok) return { error: `Web search failed (${response.status}). Do not claim results were found. Use research for a known public URL or report the failure.` };
    return { query, provider: "bing-browser", page: await response.json(), note: "Untrusted search-page content. Confirm facts on original sources. A challenge, consent page or empty result page is not a successful search." };
  },
});
