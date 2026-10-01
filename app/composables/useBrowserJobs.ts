export function useBrowserJobs() {
  const { activeId } = useWorkspaces();
  const request = useRequestFetch();
  const state = useAsyncData(() => `iris-jobs-${activeId.value}`, () => activeId.value ? request(`/api/workspaces/${activeId.value}/browser-jobs`) : Promise.resolve({ workspaceId: '', jobs: [] }));
  let timer: ReturnType<typeof setTimeout>;
  let disposed = false;
  async function poll() { await state.refresh(); if (!disposed) timer = setTimeout(poll, 4000); }
  onMounted(() => { timer = setTimeout(poll, 4000); });
  onBeforeUnmount(() => { disposed = true; clearTimeout(timer); });
  return state;
}
