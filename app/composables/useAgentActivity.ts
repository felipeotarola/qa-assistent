import type { ActivitySnapshot } from '#shared/agent-activity';

export function useAgentActivity() {
  const snapshot = useState<ActivitySnapshot | null>('agent-activity-snapshot', () => null);
  const open = useState('agent-activity-open', () => false);
  const requestedItem = useState<{ workspaceId: string; itemId: string } | null>('activity-open-item', () => null);
  return { snapshot, open, requestedItem };
}
