import { z } from "zod";
import { getToolName, isToolUIPart, type UIMessage } from 'ai';

export const suggestionsSchema = z.object({
  suggestions: z.array(z.object({
    label: z.string().trim().min(1).max(60),
    prompt: z.string().trim().min(1).max(600),
  })).max(4),
});
export type ChatSuggestion = z.infer<typeof suggestionsSchema>["suggestions"][number];

/** A turn can contain a tool message followed by a separate final answer. */
export function latestChatSuggestions(messages: readonly Pick<UIMessage, 'role' | 'parts'>[], status: string): ChatSuggestion[] {
  if (status !== 'ready' || messages.at(-1)?.role !== 'assistant') return [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === 'user') break;
    if (message.role !== 'assistant') continue;
    for (const part of [...message.parts].reverse()) {
      if (!isToolUIPart(part) || getToolName(part) !== 'suggest_next_steps') continue;
      // The latest call can explicitly clear or fail; never revive older choices.
      if (part.state !== 'output-available') return [];
      const result = suggestionsSchema.safeParse(part.output);
      return result.success ? [...new Map(result.data.suggestions.map(item => [item.prompt, item])).values()] : [];
    }
  }
  return [];
}
