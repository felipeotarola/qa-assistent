import { z } from "zod";

export const contentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().max(200000) }),
  z.object({ kind: z.literal("table"), columns: z.array(z.string().max(200)).min(1).max(50), rows: z.array(z.array(z.string().max(5000)).max(50)).max(2000) }).refine(v => v.rows.every(r => r.length === v.columns.length), "Each row must match the columns"),
]);
export type ItemContent = z.infer<typeof contentSchema> | { kind: "image" | "file"; filename: string; mime: string; size: number };
export interface Workspace { id: string; name: string }
export interface WorkspaceItem { id: string; workspaceId: string; title: string; content: ItemContent; version: number; updatedAt: string }
export const itemWriteSchema = z.object({ title: z.string().trim().min(1).max(200), content: contentSchema });
