import type { MissionConfig } from '#shared/mission';
export type MissionView = { id: string; threadId: string; controllerVersion: number | null; config: MissionConfig; revision: number; status: string; updatedAt: string; reports: { id: string; status: string; phase: string; error: string | null; itemId: string | null; createdAt: string; revision: number; deleted: boolean }[] };
export function useMissions(polling = false) {
  const { activeId } = useWorkspaces(); const request = useRequestFetch();
  const state = useAsyncData(() => `missions-${activeId.value}`, () => activeId.value ? request<{ missions: MissionView[] }>(`/api/workspaces/${activeId.value}/missions`) : Promise.resolve({ missions: [] }));
  let timer: ReturnType<typeof setTimeout>; let disposed = false;
  async function poll() { try { if (document.visibilityState === 'visible') await state.refresh(); } finally { if (!disposed) timer = setTimeout(poll, 7000); } }
  onMounted(() => { if (polling) timer = setTimeout(poll, 7000); });
  onBeforeUnmount(() => { disposed = true; clearTimeout(timer); });
  return state;
}
