<script setup lang="ts">
import type { WorkspaceItem } from "#shared/workspace";
import { useThreadList } from "~/composables/chat/useThreads";
const { activeId, workspaces } = useWorkspaces();
const route = useRoute();
const { threads } = useThreadList();
const threadId = computed(() => typeof route.params.id === "string" ? route.params.id : threads.value.find(t => t.workspaceId === activeId.value)?.id ?? null);
const items = ref<WorkspaceItem[]>([]);
const busy = ref(false);
const error = ref("");
const upload = useTemplateRef("upload");
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let fetching = false;
async function refresh() {
  const id = activeId.value;
  if (!id || fetching) return;
  fetching = true;
  try {
    const result = await $fetch<{ items: WorkspaceItem[] }>(`/api/workspaces/${id}/items`);
    if (!disposed && activeId.value === id) items.value = result.items;
  }
  catch { if (!disposed) error.value = "Kunde inte läsa workspace."; }
  finally { fetching = false; }
}
watch(activeId, () => { items.value = []; error.value = ""; void refresh(); });
async function poll() { await refresh(); if (!disposed) timer = setTimeout(poll, 3000); }
onMounted(() => { void poll(); });
onBeforeUnmount(() => { disposed = true; clearTimeout(timer); });
async function create(kind: "text" | "table") {
  if (!activeId.value) return;
  busy.value = true; error.value = "";
  try {
    await $fetch(`/api/workspaces/${activeId.value}/items`, { method: "POST", body: { title: kind === "text" ? "Nytt dokument" : "Ny tabell", content: kind === "text" ? { kind, text: "" } : { kind, columns: ["Namn", "Beskrivning"], rows: [["", ""]] } } });
    await refresh();
  }
  catch { error.value = "Kunde inte skapa objektet."; }
  finally { busy.value = false; }
}
async function uploadFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !activeId.value) return;
  if (file.size > 4 * 1024 * 1024) { error.value = "Filen får vara högst 4 MB."; input.value = ""; return; }
  busy.value = true; error.value = "";
  try {
    const form = new FormData(); form.append("file", file);
    await $fetch(`/api/workspaces/${activeId.value}/upload`, { method: "POST", body: form });
    await refresh();
  }
  catch (cause) {
    error.value = (cause as { statusCode?: number }).statusCode === 503
      ? "Privat fillagring behöver konfigureras innan du kan ladda upp filer."
      : "Uppladdningen misslyckades. Försök igen.";
  }
  finally { busy.value = false; input.value = ""; }
}
</script>
<template>
  <aside class="workspace-surface relative flex h-full min-h-0 flex-col overflow-hidden bg-default" aria-label="Workspace">
    <header class="flex shrink-0 flex-wrap items-center gap-2 border-b border-default/60 px-4 py-3">
      <UIcon name="i-lucide-layout-grid" class="size-4 text-dimmed" />
      <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ workspaces.find(w => w.id === activeId)?.name || 'Workspace' }}</span>
      <UButton icon="i-lucide-file-plus" aria-label="Nytt dokument" title="Nytt dokument" color="neutral" variant="ghost" size="sm" :disabled="busy || !activeId" @click="create('text')" />
      <UButton icon="i-lucide-table-2" aria-label="Ny tabell" title="Ny tabell" color="neutral" variant="ghost" size="sm" :disabled="busy || !activeId" @click="create('table')" />
      <UButton icon="i-lucide-upload" label="Ladda upp" color="neutral" variant="soft" size="sm" :loading="busy" :disabled="!activeId" @click="upload?.click()" />
      <input ref="upload" type="file" class="hidden" aria-label="Ladda upp fil" @change="uploadFile">
    </header>
    <p v-if="error" role="alert" class="px-4 py-2 text-xs text-error">{{ error }}</p>
    <div class="min-h-0 flex-1 overflow-auto p-4 sm:p-5">
      <div class="flex flex-wrap items-start gap-4">
        <BrowserWorkspace v-if="threadId && activeId" :key="activeId" :thread-id="threadId" embedded />
        <WorkspaceItemCard v-for="item in items" :key="item.id" :item="item" @saved="refresh" />
      </div>
      <div v-if="!items.length" class="mx-auto mt-12 max-w-64 text-center text-sm leading-relaxed text-dimmed">
        <UIcon name="i-lucide-sparkles" class="mb-3 size-6" />
        <p>Plats för det ni skapar tillsammans.</p>
        <p class="mt-2 text-xs">Be agenten spara en text, tabell eller skärmbild — eller ladda upp dina egna filer. Innehållet följer med mellan chattarna.</p>
      </div>
    </div>
  </aside>
</template>
<style scoped>
.workspace-surface { background-image: radial-gradient(color-mix(in oklab, var(--ui-text-dimmed) 16%, transparent) 0.7px, transparent 0.7px); background-size: 20px 20px; }
</style>
