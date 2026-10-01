import type { AssessmentView } from '#shared/result-assessment';
export function useResultAssessments(polling = true) {
  const { activeId } = useWorkspaces();
  const request = useRequestFetch();
  const state = useAsyncData(() => `result-assessments-${activeId.value}`, () => activeId.value ? request<{ workspaceId: string; autoEnabled: boolean; assessments: AssessmentView[] }>(`/api/workspaces/${activeId.value}/assessments`) : Promise.resolve({ workspaceId: '', autoEnabled: false, assessments: [] }));
  let timer: ReturnType<typeof setTimeout>; let disposed = false;
  async function poll() { try { await state.refresh(); } finally { if (!disposed) timer = setTimeout(poll, 5000); } }
  onMounted(() => { if (!polling) return; timer = setTimeout(poll, 5000); });
  onBeforeUnmount(() => { disposed = true; clearTimeout(timer); });
  return state;
}
