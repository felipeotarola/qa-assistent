/** Product identities stay independent of model providers and persisted tool IDs. */
export const agentIdentities = {
  main: { name: 'V', role: 'Huvudagent' },
  repository: { name: 'Axel', role: 'Repository & kodtester' },
  browser: { name: 'Iris', role: 'Webbläsartester' },
  vps: { name: 'Otto', role: 'VPS & arbetsmiljö' },
  reviewer: { name: 'Klara', role: 'Granskning & rapporter' },
} as const;
export type AgentRole = keyof typeof agentIdentities;
export function isAgentRole(id: string): id is AgentRole {
  return Object.hasOwn(agentIdentities, id);
}

/** Presentation only: retain original reports, logs and backend identifiers. */
export function vpsStatusMessage(message: string): string {
  return message.replace(/\bCodex\b/gi, agentIdentities.vps.name);
}
