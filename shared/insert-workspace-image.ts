import type { EditableContent, ImageReference } from "./workspace";
export const WORKSPACE_IMAGE_MIME = "application/x-pat-workspace-image";
export type ImagePlacement = { kind: "document"; index: number } | { kind: "cell"; blockIndex?: number; row: number; column: number };
export function insertWorkspaceImage(content: EditableContent, image: ImageReference, placement: ImagePlacement, replace = false): EditableContent {
  // Content is JSON data; this also accepts Vue's reactive proxies.
  const copy: EditableContent = JSON.parse(JSON.stringify(content));
  if (placement.kind === "document") {
    if (copy.kind !== "text") throw new Error("Choose a document");
    copy.blocks ??= [{ kind: "text", text: copy.text }];
    if (!Number.isInteger(placement.index) || placement.index < 0 || placement.index > copy.blocks.length) throw new Error("Invalid position");
    copy.blocks.splice(placement.index, 0, image);
    return copy;
  }
  const table = copy.kind === "table" ? copy : copy.blocks?.[placement.blockIndex ?? -1];
  if (table?.kind !== "table" || !Number.isInteger(placement.row) || !Number.isInteger(placement.column) || placement.row < 0 || placement.column < 0 || !table.rows[placement.row] || placement.column >= table.columns.length) throw new Error("Choose an existing cell");
  const current = table.rows[placement.row]![placement.column];
  if (current !== "" && !replace) throw new Error("Cell is occupied");
  table.rows[placement.row]![placement.column] = image;
  return copy;
}
