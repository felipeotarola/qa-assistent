import { defineTool } from "eve/tools";
import { suggestionsSchema } from "../../shared/chat-suggestions";

export default defineTool({
  description: "Display next-step buttons below your final answer in the web chat. Call this whenever you offer follow-up work or ask how to continue, including after drafting a test plan, investigating a repo or saving a report. After reading actual results, provide 1–3 useful choices, recommended action first: short labels and complete user requests in the user's language. Clicking fills the user's draft; it does not execute actions or grant approval. Do not propose completed actions, invent capabilities, include secrets or add generic filler to simple answers. An empty list clears suggestions. Then give your normal final answer.",
  inputSchema: suggestionsSchema,
  outputSchema: suggestionsSchema,
  execute(input) { return input; },
});
