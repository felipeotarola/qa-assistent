import { z } from "zod";
import { testPlanSchema } from "./test-plan.ts";
import { diagramSchema } from './diagram.ts';

export const imageReferenceSchema = z.object({ kind: z.literal("image"), itemId: z.string().uuid(), caption: z.string().max(1000).default("") });
export const tableBlockSchema = z.object({ kind: z.literal("table"), columns: z.array(z.string().max(200)).min(1).max(50), rows: z.array(z.array(z.union([z.string().max(5000), imageReferenceSchema])).max(50)).max(2000) }).refine(v => v.rows.every(r => r.length === v.columns.length), "Each row must match the columns");
export const chartBlockSchema = z.object({ kind: z.literal("chart"), chartType: z.literal("bar"), title: z.string().max(200), data: z.array(z.object({ label: z.string().max(200), value: z.number().min(0).max(1e12) })).min(1).max(100) });
export const documentBlockSchema = z.union([
  z.object({ kind: z.literal("text"), text: z.string().max(200000) }),
  z.object({ kind: z.literal("heading"), text: z.string().max(500) }),
  imageReferenceSchema,
  tableBlockSchema,
  chartBlockSchema,
]);
export const contentSchema = z.discriminatedUnion("kind", [
  testPlanSchema,
  diagramSchema,
  z.object({ kind: z.literal("text"), text: z.string().max(200000), blocks: z.array(documentBlockSchema).max(200).optional() }),
  tableBlockSchema,
]);
export type DocumentBlock = z.infer<typeof documentBlockSchema>;
export type EditableContent = z.infer<typeof contentSchema>;
export type ImageReference = z.infer<typeof imageReferenceSchema>;
export function imageReferences(content: ItemContent): ImageReference[] {
  const entries = content.kind === "text" ? (content.blocks ?? []).flatMap<string | DocumentBlock>(block => block.kind === "table" ? block.rows.flat() : [block]) : content.kind === "table" ? content.rows.flat() : [];
  return entries.filter((entry): entry is ImageReference => typeof entry === "object" && entry.kind === "image");
}
export function documentText(blocks: DocumentBlock[]) {
  return blocks.map(block => {
    if (block.kind === "text" || block.kind === "heading") return block.text;
    if (block.kind === "image") return block.caption;
    if (block.kind === "chart") return `${block.title}\n${block.data.map(point => `${point.label}: ${point.value}`).join("\n")}`;
    const cell = (value: string | ImageReference) => (typeof value === "string" ? value : value.caption).replaceAll("|", "\\|").replaceAll("\n", " ");
    return [block.columns.map(cell).join(" | "), block.columns.map(() => "---").join(" | "), ...block.rows.map(row => row.map(cell).join(" | "))].join("\n");
  }).join("\n\n");
}
export type ItemContent = z.infer<typeof contentSchema> | { kind: "image" | "file"; filename: string; mime: string; size: number };
export interface Workspace { id: string; name: string }
export interface WorkspaceItem { id: string; workspaceId: string; title: string; content: ItemContent; version: number; updatedAt: string; evidenceSummary?: { sources: number; tickets: number; related: number } }
export const itemWriteSchema = z.object({ title: z.string().trim().min(1).max(200), content: contentSchema });
