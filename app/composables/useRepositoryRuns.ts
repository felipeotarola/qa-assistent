import type { RepositoryState } from '#shared/repository';
export function useRepositoryRuns() {
  const { activeId } = useWorkspaces();
  const endpoint = computed(() => `/api/workspaces/${activeId.value}/repositories`);
  const state = useFetch<RepositoryState>(endpoint, { key: computed(() => `repositories:${activeId.value}`), immediate: !!activeId.value });
  return { ...state, endpoint, activeId };
}
