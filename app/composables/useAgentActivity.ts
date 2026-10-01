import type { ActivitySnapshot } from '#shared/agent-activity';

export function useAgentActivity() {
  const snapshot = useState<ActivitySnapshot | null>('agent-activity-snapshot', () => null);
  const open = useState('agent-activity-open', () => false);
  const collapsed = useCookie<boolean>('agent-activity-collapsed', { default: () => false, sameSite: 'lax' });
  const autoOpen = () => { if (!collapsed.value) open.value = true; };
  const requestedItem = useState<{ workspaceId: string; itemId: string } | null>('activity-open-item', () => null);
  const workers = useState<{ threadId: string; sessionId: string; name: string; callId: string }[]>('agent-activity-workers', () => []);
  return { snapshot, open, collapsed, autoOpen, requestedItem, workers };
}
