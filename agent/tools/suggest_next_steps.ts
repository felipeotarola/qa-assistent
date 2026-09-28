import { defineTool } from "eve/tools";
import { suggestionsSchema } from "../../shared/chat-suggestions";

export default defineTool({
  description: "Offer contextual next-step buttons in the web chat. Before your final answer, after finishing work and reading tool results, provide 2–4 useful alternatives when the user faces a choice or you offer follow-up work. Each label is short; prompt is the full user request, specific to the current topic and in the user's language. This only displays suggestions, never executes them or requests approval. Do not propose already completed actions, invent capabilities, include secrets, or use generic filler. Use an empty list to clear suggestions if no useful next step remains. Then give your normal final answer.",
  inputSchema: suggestionsSchema,
  outputSchema: suggestionsSchema,
  execute(input) { return input; },
});
