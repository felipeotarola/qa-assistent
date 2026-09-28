import type { WorkspaceItem } from "./workspace";
export function cardTaskPrompt(item: Pick<WorkspaceItem, "id" | "workspaceId" | "title" | "version">, text: string) {
  return `Uppgift för valt workspace-objekt: ${JSON.stringify({ itemId: item.id, workspaceId: item.workspaceId, title: item.title, displayedVersion: item.version })}\n\n${text.trim()}\n\nLäs objektets aktuella innehåll med workspace-verktyget innan du ändrar det. Arbeta med detta objekt och behåll övrigt innehåll om uppgiften inte säger annat. Spara med den version du just läste som expectedVersion. Bekräfta kort i chatten vad som faktiskt sparades. Om något är oklart, fråga innan du gissar.`;
}
