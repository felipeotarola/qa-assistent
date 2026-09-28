import { z } from "zod";

export const providerSchema = z.enum(["github", "linear"]);
export type ExternalProvider = z.infer<typeof providerSchema>;
export const destinationSchema = z.object({
  provider: providerSchema,
  targetId: z.string().min(1).max(200),
  projectId: z.string().max(200).optional(),
});
export type Destination = z.infer<typeof destinationSchema> & { label: string };
export interface DestinationOption { id: string; label: string }
export const externalInputSchema = z.object({
  evidenceItemIds: z.array(z.string().uuid()).max(20).optional(),
  action: z.enum(["destinations", "list", "read", "create", "update", "comment", "history"]),
  provider: providerSchema.optional(),
  issueId: z.string().min(1).max(100).optional(),
  title: z.string().min(1).max(250).optional(),
  body: z.string().max(50000).optional(),
  cursor: z.string().max(300).optional(),
});
export type ExternalInput = z.infer<typeof externalInputSchema>;
export interface ExternalIssue { id: string; title: string; body: string; url: string; state?: string }
