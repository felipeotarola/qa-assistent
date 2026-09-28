import type { ExternalIssue } from "../../shared/external";
/** Only a confirmed provider response can become a published-issue link. */
export function confirmedEvidence(state: string, result: ExternalIssue | undefined, items: Array<{ id: string; version: number }>, context: { operationId: string; workspaceId: string; provider: string; threadId?: string }) {
  if (state !== "complete" || !result) return [];
  const url = new URL(result.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Provider returned an invalid issue URL");
  return items.map(item => ({ id: `${context.operationId}:${item.id}`, workspaceId: context.workspaceId, itemId: item.id, itemVersion: item.version, kind: "ticket", label: `${context.provider}: ${result.title}`, url: result.url, threadId: context.threadId }));
}
