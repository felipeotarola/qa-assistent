import { z } from "zod";
export const sourceUrlSchema = z.string().url().max(2000).refine(value => { try { const u = new URL(value); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password; } catch { return false; } }, "HTTP(S) URL without credentials required");
export const evidenceInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source"), url: sourceUrlSchema, label: z.string().max(200), observedAt: z.string().datetime().optional() }),
  z.object({ kind: z.literal("item"), targetItemId: z.string().uuid(), label: z.string().max(200) }),
]);
export type EvidenceInput = z.infer<typeof evidenceInputSchema>;
export interface EvidenceLink { id: string; itemVersion: number; kind: string; label: string; url: string | null; targetItemId: string | null; targetVersion: number | null; threadId: string | null; observedAt: string | null; createdAt: string; }

