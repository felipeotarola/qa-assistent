import { z } from "zod";

export const suggestionsSchema = z.object({
  suggestions: z.array(z.object({
    label: z.string().trim().min(1).max(60),
    prompt: z.string().trim().min(1).max(600),
  })).max(4),
});
export type ChatSuggestion = z.infer<typeof suggestionsSchema>["suggestions"][number];
