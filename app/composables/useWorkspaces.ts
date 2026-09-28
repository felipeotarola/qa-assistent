import type { Workspace } from "#shared/workspace";
import { useThreadList } from "~/composables/chat/useThreads";

export function useWorkspaces() {
  const selected = useCookie<string | null>("pat_workspace", { default: () => null, sameSite: "lax", maxAge: 31536000 });
  const { data, refresh, pending, error } = useFetch<{ workspaces: Workspace[] }>("/api/workspaces", { key: "workspaces" });
  const route = useRoute();
  const bindings = useState<Record<string, string>>("thread-workspaces", () => ({}));
  const { threads } = useThreadList();
  const workspaces = computed(() => data.value?.workspaces ?? []);
  const activeId = computed(() => {
    if (route.path === "/" && route.query.view === "workspaces") return null;
    if (route.path === "/" && typeof route.query.workspace === "string" && workspaces.value.some(w => w.id === route.query.workspace)) return route.query.workspace;
    const threadId = typeof route.params.id === "string" ? route.params.id : "";
    const bound = bindings.value[threadId] ?? threads.value.find(t => t.id === threadId)?.workspaceId;
    return bound || (workspaces.value.some(w => w.id === selected.value) ? selected.value : workspaces.value[0]?.id) || null;
  });
  watch(activeId, (id) => { if (id) selected.value = id; }, { immediate: true });
  return { workspaces, activeId, selected, refresh, pending, error, bindings };
}
