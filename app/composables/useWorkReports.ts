import type { WorkReport } from '#shared/work-report';
import { latestWorkReport } from '#shared/work-report';

export function useWorkReports() {
  const { activeId } = useWorkspaces();
  const reports = useState<{ workspaceId: string | null; items: WorkReport[] }>('work-reports', () => ({ workspaceId: null, items: [] }));
  const dismissed = useState<Record<string, string[]>>('work-reports-dismissed', () => ({}));
  const latest = computed(() => activeId.value && reports.value.workspaceId === activeId.value ? latestWorkReport(reports.value.items, dismissed.value[activeId.value] || []) : null);
  function dismiss() {
    if (!activeId.value || !latest.value) return;
    dismissed.value = { ...dismissed.value, [activeId.value]: [...(dismissed.value[activeId.value] || []), latest.value.id].slice(-100) };
  }
  return { reports, latest, dismiss };
}
