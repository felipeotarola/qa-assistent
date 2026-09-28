<script setup lang="ts">
import type { WorkspaceItem } from "#shared/workspace";
import { imageReferences } from "#shared/workspace";
import { useThreadList } from "~/composables/chat/useThreads";
const { activeId, workspaces } = useWorkspaces();
const route = useRoute();
const { threads } = useThreadList();
const threadId = computed(() => typeof route.params.id === "string" ? route.params.id : threads.value.find(t => t.workspaceId === activeId.value)?.id ?? null);
const items = ref<WorkspaceItem[]>([]);
const order = ref<string[]>([]);
const ordering = ref(false);
let layoutRevision = 0;
const draggingCard = ref<string | null>(null);
const dropTarget = ref<string | null>(null);
const browserPresent = ref(false);
const visibleCardIds = computed(() => orderedCards.value.filter(card => card.item || browserPresent.value).map(card => card.id));
function neighbor(id: string, direction: number) { return visibleCardIds.value[visibleCardIds.value.indexOf(id) + direction]; }
function stepCard(id: string, direction: number) { const target = neighbor(id, direction); if (target) void moveCard(id, target); }
const orderedCards = computed(() => {
  const cards = [{ id: "browser", item: null as WorkspaceItem | null }, ...visibleItems.value.map(item => ({ id: item.id, item }))];
  const positions = new Map(order.value.map((id, index) => [id, index]));
  return cards.sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity));
});
async function moveCard(id: string, target: string) {
  const workspaceId = activeId.value;
  if (!workspaceId || ordering.value || id === target) return;
  const all = [...new Set([...order.value, ...orderedCards.value.map(card => card.id), ...items.value.map(item => item.id)])]
    .filter(key => key === "browser" || items.value.some(item => item.id === key));
  const from = all.indexOf(id), to = all.indexOf(target);
  if (from < 0 || to < 0) return;
  const previous = order.value;
  layoutRevision++;
  all.splice(from, 1); all.splice(to, 0, id);
  order.value = all; ordering.value = true; error.value = "";
  try { await $fetch(`/api/workspaces/${workspaceId}/layout`, { method: "PUT", body: { order: all } }); }
  catch { if (activeId.value === workspaceId) { order.value = previous; error.value = "Kunde inte spara ordningen. Försök igen."; } }
  finally { ordering.value = false; }
}
function dropCard(target: string) {
  const id = draggingCard.value;
  draggingCard.value = null; dropTarget.value = null;
  if (id) void moveCard(id, target);
}
function startCardDrag(event: DragEvent, id: string) {
  draggingCard.value = id;
  if (event.dataTransfer) { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", id); }
}
const showLibrary = ref(false);
const referencedImages = computed(() => new Set(items.value.flatMap(item => imageReferences(item.content).map(ref => ref.itemId))));
const visibleItems = computed(() => showLibrary.value ? items.value : items.value.filter(item => item.content.kind !== "image" || !referencedImages.value.has(item.id)));
const trash = ref(false);
async function restore(item: WorkspaceItem) {
  busy.value = true; error.value = "";
  try { await $fetch(`/api/workspaces/${item.workspaceId}/items/${item.id}/restore`, { method: "POST" }); await refresh(); }
  catch { error.value = "Kunde inte återställa objektet."; }
  finally { busy.value = false; }
}
const busy = ref(false);
const error = ref("");
const upload = useTemplateRef("upload");
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let fetching = false;
async function refresh() {
  const id = activeId.value;
  const deleted = trash.value;
  const revision = layoutRevision;
  if (!id || fetching || ordering.value || draggingCard.value) return;
  fetching = true;
  try {
    const [result, layout] = await Promise.all([
      $fetch<{ items: WorkspaceItem[] }>(`/api/workspaces/${id}/items`, { query: { trash: deleted } }),
      $fetch<{ order: string[] }>(`/api/workspaces/${id}/layout`),
    ]);
    if (!disposed && activeId.value === id && trash.value === deleted && revision === layoutRevision && !ordering.value && !draggingCard.value) { items.value = result.items; order.value = layout.order; }
  }
  catch { if (!disposed) error.value = "Kunde inte läsa workspace."; }
  finally { fetching = false; }
}
watch(activeId, () => { items.value = []; order.value = []; draggingCard.value = null; error.value = ""; void refresh(); });
watch(trash, () => { items.value = []; error.value = ""; void refresh(); });
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
      <WorkspaceDestinations v-if="activeId" :key="activeId" :workspace-id="activeId" />
      <UButton icon="i-lucide-trash-2" :label="trash ? 'Tillbaka' : undefined" aria-label="Papperskorg" title="Papperskorg" :aria-pressed="trash" color="neutral" :variant="trash ? 'soft' : 'ghost'" @click="trash = !trash" />
      <template v-if="!trash">
      <UButton icon="i-lucide-images" aria-label="Visa även använda bilder" title="Visa även använda bilder" :aria-pressed="showLibrary" color="neutral" :variant="showLibrary ? 'soft' : 'ghost'" @click="showLibrary = !showLibrary" />
      <UButton icon="i-lucide-file-plus" aria-label="Nytt dokument" title="Nytt dokument" color="neutral" variant="ghost" size="sm" :disabled="busy || !activeId" @click="create('text')" />
      <UButton icon="i-lucide-table-2" aria-label="Ny tabell" title="Ny tabell" color="neutral" variant="ghost" size="sm" :disabled="busy || !activeId" @click="create('table')" />
      <UButton icon="i-lucide-upload" label="Ladda upp" color="neutral" variant="soft" size="sm" :loading="busy" :disabled="!activeId" @click="upload?.click()" />
      <input ref="upload" type="file" class="hidden" aria-label="Ladda upp fil" @change="uploadFile">
      </template>
    </header>
    <p v-if="error" role="alert" class="px-4 py-2 text-xs text-error">{{ error }}</p>
    <div class="min-h-0 flex-1 overflow-auto p-4 sm:p-5">
      <div v-if="trash" class="space-y-2">
        <p class="mb-4 text-sm text-muted">Papperskorg — objekt och filer behålls tills vidare och kan återställas.</p>
        <div v-for="item in items" :key="item.id" class="flex items-center gap-3 rounded-lg border border-default bg-default p-3">
          <span class="min-w-0 flex-1 truncate text-sm">{{ item.title }}</span>
          <UButton label="Återställ" icon="i-lucide-undo-2" color="neutral" variant="soft" :disabled="busy" @click="restore(item)" />
        </div>
        <p v-if="!items.length" class="text-sm text-dimmed">Papperskorgen är tom.</p>
      </div>
      <TransitionGroup v-else name="cards" tag="div" class="flex flex-wrap items-start gap-4">
        <div
v-for="card in orderedCards" v-show="card.item || browserPresent" :key="card.id" class="w-full max-w-80 rounded-2xl" :class="{ 'ring-2 ring-primary': dropTarget === card.id && draggingCard !== card.id, 'opacity-50': draggingCard === card.id }"
          @dragover.prevent="dropTarget = card.id" @drop.prevent="dropCard(card.id)">
          <div class="mb-1 flex items-center justify-end gap-1">
            <UButton
icon="i-lucide-grip-vertical" color="neutral" variant="ghost" size="xs" class="cursor-grab active:cursor-grabbing" :draggable="!ordering" :disabled="ordering" :aria-label="`Dra ${card.item?.title || 'Webbläsare'} för att flytta`" title="Dra för att flytta"
              @dragstart="startCardDrag($event, card.id)" @dragend="draggingCard = null; dropTarget = null" />
            <UButton icon="i-lucide-arrow-left" color="neutral" variant="ghost" size="xs" aria-label="Flytta tidigare" title="Flytta tidigare" :disabled="ordering || !neighbor(card.id, -1)" @click="stepCard(card.id, -1)" />
            <UButton icon="i-lucide-arrow-right" color="neutral" variant="ghost" size="xs" aria-label="Flytta senare" title="Flytta senare" :disabled="ordering || !neighbor(card.id, 1)" @click="stepCard(card.id, 1)" />
          </div>
          <WorkspaceItemCard v-if="card.item" :item="card.item" @saved="refresh" />
          <BrowserWorkspace v-else-if="threadId && activeId" :key="activeId" :thread-id="threadId" embedded @presence="browserPresent = $event" />
        </div>
      </TransitionGroup>
      <div v-if="!trash && !items.length" class="mx-auto mt-12 max-w-64 text-center text-sm leading-relaxed text-dimmed">
        <UIcon name="i-lucide-sparkles" class="mb-3 size-6" />
        <p>Plats för det ni skapar tillsammans.</p>
        <p class="mt-2 text-xs">Be agenten spara en text, tabell eller skärmbild — eller ladda upp dina egna filer. Innehållet följer med mellan chattarna.</p>
      </div>
    </div>
  </aside>
</template>
<style scoped>
.workspace-surface { background-image: radial-gradient(color-mix(in oklab, var(--ui-text-dimmed) 16%, transparent) 0.7px, transparent 0.7px); background-size: 20px 20px; }
.cards-move { transition: transform 220ms ease; }
@media (prefers-reduced-motion: reduce) { .cards-move { transition: none; } }
</style>
