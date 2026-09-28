import { z } from "zod";

export const imageReferenceSchema = z.object({ kind: z.literal("image"), itemId: z.string().uuid(), caption: z.string().max(1000).default("") });
export const documentBlockSchema = z.union([
  z.object({ kind: z.literal("text"), text: z.string().max(200000) }),
  z.object({ kind: z.literal("heading"), text: z.string().max(500) }),
  imageReferenceSchema,
]);
export const contentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().max(200000), blocks: z.array(documentBlockSchema).max(200).optional() }),
  z.object({ kind: z.literal("table"), columns: z.array(z.string().max(200)).min(1).max(50), rows: z.array(z.array(z.union([z.string().max(5000), imageReferenceSchema])).max(50)).max(2000) }).refine(v => v.rows.every(r => r.length === v.columns.length), "Each row must match the columns"),
]);
export type DocumentBlock = z.infer<typeof documentBlockSchema>;
export type EditableContent = z.infer<typeof contentSchema>;
export type ImageReference = z.infer<typeof imageReferenceSchema>;
export function imageReferences(content: ItemContent): ImageReference[] {
  const entries = content.kind === "text" ? content.blocks ?? [] : content.kind === "table" ? content.rows.flat() : [];
  return entries.filter((entry): entry is ImageReference => typeof entry === "object" && entry.kind === "image");
}
export type ItemContent = z.infer<typeof contentSchema> | { kind: "image" | "file"; filename: string; mime: string; size: number };
export interface Workspace { id: string; name: string }
export interface WorkspaceItem { id: string; workspaceId: string; title: string; content: ItemContent; version: number; updatedAt: string }
export const itemWriteSchema = z.object({ title: z.string().trim().min(1).max(200), content: contentSchema });
