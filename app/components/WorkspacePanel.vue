<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui';
import type { WorkspaceItem } from "#shared/workspace";
import { imageReferences } from "#shared/workspace";
import { useThreadList } from "~/composables/chat/useThreads";
import WorkspaceOverview from './WorkspaceOverview.vue';
import WorkspaceTesting from './WorkspaceTesting.vue';
import { defaultQuality, type QualitySettings } from '#shared/quality';
const { activeId, allWorkspaces } = useWorkspaces();
const vault = useWorkspaceVault();
const route = useRoute();
const router = useRouter();
const connectionFetch = useRequestFetch();
const { data: connections } = await useAsyncData(() => `workspace-linear-destination-${activeId.value}`, async () => {
  if (!activeId.value) return { destinations: [] };
  return connectionFetch<{ destinations: import('#shared/external').Destination[] }>(`/api/workspaces/${activeId.value}/destinations`);
});
const views = computed(() => [
  { label: 'Översikt', value: 'overview', icon: 'i-lucide-house' },
  { label: 'Testning', value: 'testing', icon: 'i-lucide-list-checks' },
  { label: 'Material', value: 'material', icon: 'i-lucide-folder' },
  ...(connections.value?.destinations.some(d => d.provider === 'linear') ? [{ label: 'Linear', value: 'linear', icon: 'i-lucide-panels-top-left' }] : []),
]);
const view = computed({
  get: () => ['testing', 'material', 'linear'].includes(String(route.query.workspaceView)) ? String(route.query.workspaceView) : 'overview',
  set: value => { void router.replace({ query: { ...route.query, workspaceView: value === 'overview' ? undefined : value } }); },
});
const materialMode = useCookie<'cards' | 'table'>('material-view', { default: () => 'cards', sameSite: 'lax' });
const materialQuery = ref('');
const tableMaterials = computed(() => orderedCards.value.flatMap(card => card.item && card.item.content.kind !== 'test_plan' && matchesMaterial(card.item) ? [card.item] : []));
function matchesMaterial(item: WorkspaceItem) { return `${item.title} ${item.id}`.toLocaleLowerCase().includes(materialQuery.value.trim().toLocaleLowerCase()); }
const expandedItems = ref<Record<string, boolean>>({});
const plans = computed(() => items.value.filter(item => item.content.kind === 'test_plan'));
const materials = computed(() => items.value.filter(item => item.content.kind !== 'test_plan'));
function inView(item: WorkspaceItem | null) {
  return item ? (view.value === 'testing' ? item.content.kind === 'test_plan' && !!expandedItems.value[item.id] : view.value === 'material' && item.content.kind !== 'test_plan' && (!!expandedItems.value[item.id] || (materialMode.value !== 'table' && matchesMaterial(item)))) : view.value === 'material';
}
function openItem(item: WorkspaceItem) {
  view.value = item.content.kind === 'test_plan' ? 'testing' : 'material';
  if (item.content.kind === 'image') showLibrary.value = true;
  expandedItems.value[item.id] = true;
}
watch(activeId, () => { expandedItems.value = {}; browserPresent.value = false; });
const { threads } = useThreadList();
const threadId = computed(() => typeof route.params.id === "string" ? route.params.id : threads.value.find(t => t.workspaceId === activeId.value)?.id ?? null);
const items = ref<WorkspaceItem[]>([]);
const runs = ref<import('#shared/test-run').TestRun[]>([]);
const quality = ref<QualitySettings>(defaultQuality());
provide('workspace-quality', quality);
provide('workspace-test-runs', runs);
provide('workspace-items', items);
provide('workspace-open-item', (id: string) => { const item = items.value.find(i => i.id === id); if (item) openItem(item); });
const loaded = ref(false);
const activity = useAgentActivity();
watch([activity.requestedItem, items], ([request]) => {
  if (!request || request.workspaceId !== activeId.value) return;
  const item = items.value.find(item => item.id === request.itemId);
  if (item) { openItem(item); activity.requestedItem.value = null; }
});
const imageInsertion = ref<{ image: WorkspaceItem; targetId?: string }>();
function insertImage(imageId: string, targetId?: string) {
  const image = items.value.find(item => item.id === imageId && item.content.kind === "image");
  if (image) imageInsertion.value = { image, targetId };
}
watch(activeId, () => { imageInsertion.value = undefined; });
const order = ref<string[]>([]);
const ordering = ref(false);
let layoutRevision = 0;
const draggingCard = ref<string | null>(null);
const dropTarget = ref<string | null>(null);
const browserPresent = ref(false);
const browserWorking = ref(false);
const visibleCardIds = computed(() => orderedCards.value.filter(card => inView(card.item) && (card.item || browserPresent.value)).map(card => card.id));
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
const referencedImages = computed(() => new Set([...items.value.flatMap(item => imageReferences(item.content).map(ref => ref.itemId)), ...runs.value.flatMap(run => run.captures?.flatMap(c => c.itemId ? [c.itemId] : []) ?? [])]));
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
let refreshRequested = false;
async function refresh() {
  const id = activeId.value;
  const deleted = trash.value;
  const revision = layoutRevision;
  if (!id || disposed || ordering.value || draggingCard.value) return;
  if (fetching) { refreshRequested = true; return; }
  fetching = true;
  try {
    const [result, layout, runData, qualityData] = await Promise.all([
      $fetch<{ items: WorkspaceItem[] }>(`/api/workspaces/${id}/items`, { query: { trash: deleted } }),
      $fetch<{ order: string[] }>(`/api/workspaces/${id}/layout`),
      $fetch<import("#shared/test-run").TestRun[]>(`/api/workspaces/${id}/runs`),
      $fetch<QualitySettings>(`/api/workspaces/${id}/quality`),
    ]);
    if (!disposed && activeId.value === id && trash.value === deleted && revision === layoutRevision && !ordering.value && !draggingCard.value) { runs.value = JSON.stringify(runs.value) === JSON.stringify(runData) ? runs.value : runData;
      if (qualityData.revision >= quality.value.revision) quality.value = qualityData;
      const existing = new Map(items.value.map(item => [item.id, item]));
      items.value = result.items.map(item => JSON.stringify(existing.get(item.id)) === JSON.stringify(item) ? existing.get(item.id)! : item); order.value = layout.order; loaded.value = true; error.value = ''; }
  }
  catch { if (!disposed && activeId.value === id && trash.value === deleted) error.value = "Kunde inte läsa workspace."; }
  finally {
    fetching = false;
    if (refreshRequested && !disposed) { refreshRequested = false; void refresh(); }
  }
}
watch(activeId, () => { loaded.value = false; quality.value = defaultQuality(); runs.value = []; items.value = []; order.value = []; draggingCard.value = null; error.value = ""; void refresh(); });
watch(trash, () => { loaded.value = false; items.value = []; error.value = ""; void refresh(); });
async function poll() { await refresh(); if (!disposed) timer = setTimeout(poll, 3000); }
onMounted(() => { void poll(); });
onBeforeUnmount(() => { disposed = true; clearTimeout(timer); });
async function create(kind: "text" | "table" | "test_plan" | "diagram") {
  if (!activeId.value || busy.value) return;
  busy.value = true; error.value = "";
  try {
    await $fetch(`/api/workspaces/${activeId.value}/items`, { method: "POST", body: { title: kind === "diagram" ? "Nytt diagram" : kind === "test_plan" ? "Ny testplan" : kind === "text" ? "Nytt dokument" : "Ny tabell", content: kind === "diagram" ? { kind, summary: "", direction: "LR", nodes: [], edges: [], sources: [] } : kind === "test_plan" ? { kind, summary: "", cases: [], sources: [] } : kind === "text" ? { kind, text: "" } : { kind, columns: ["Namn", "Beskrivning"], rows: [["", ""]] } } });
    await refresh();
    view.value = kind === 'test_plan' ? 'testing' : 'material';
  }
  catch { error.value = "Kunde inte skapa objektet."; }
  finally { busy.value = false; }
}
const connectionsOpen = ref(false);
const workspaceName = computed(() => allWorkspaces.value.find(w => w.id === activeId.value)?.name || 'Workspace');
const workspaceActions = computed<DropdownMenuItem[][]>(() => {
  const groups: DropdownMenuItem[][] = [[{ label: workspaceName.value, type: 'label' }]];
  if (!trash.value && view.value === 'material') groups.push([
    { label: 'Nytt dokument', icon: 'i-lucide-file-plus', disabled: busy.value, onSelect: () => { void create('text'); } },
    { label: 'Ny tabell', icon: 'i-lucide-table-2', disabled: busy.value, onSelect: () => { void create('table'); } },
    { label: 'Nytt diagram', icon: 'i-lucide-workflow', disabled: busy.value, onSelect: () => { void create('diagram'); } },
    { label: 'Ladda upp fil', icon: 'i-lucide-upload', disabled: busy.value, onSelect: () => upload.value?.click() },
  ], [
    { label: 'Visa även använda bilder', icon: 'i-lucide-images', type: 'checkbox', checked: showLibrary.value, onUpdateChecked: checked => { showLibrary.value = checked; } },
  ]);
  if (!trash.value && view.value === 'testing') groups.push([
    { label: 'Ny testplan', icon: 'i-lucide-list-checks', disabled: busy.value, onSelect: () => { void create('test_plan'); } },
  ]);
  groups.push([
    { label: 'Kopplingar', icon: 'i-lucide-plug', onSelect: () => { connectionsOpen.value = true; } },
    { label: trash.value ? 'Tillbaka från papperskorgen' : 'Papperskorg', icon: trash.value ? 'i-lucide-arrow-left' : 'i-lucide-trash-2', onSelect: () => { trash.value = !trash.value; } },
  ]);
  return groups;
});
watch(activeId, () => { connectionsOpen.value = false; });
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
  <aside class="workspace-surface relative flex h-full min-h-0 flex-col overflow-hidden" aria-label="Workspace">
    <header class="flex min-h-(--ui-header-height) shrink-0 flex-wrap items-center gap-2 border-b border-default bg-default px-4 py-2">
      <UIcon name="i-lucide-layout-grid" class="size-4 text-dimmed" />
      <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ workspaceName }}</span>
      <UButton label="Vault" icon="i-lucide-key-round" aria-label="Öppna vault – API-nycklar och miljövariabler" variant="outline" size="sm" :disabled="!activeId" @click="activeId && vault.open(activeId)" />
      <UDropdownMenu :items="workspaceActions" :content="{ align: 'end' }" :ui="{ content: 'w-60' }">
        <UButton label="Verktyg" trailing-icon="i-lucide-chevron-down" color="neutral" variant="ghost" :disabled="!activeId" class="shrink-0" aria-label="Workspace-verktyg" />
      </UDropdownMenu>
      <WorkspaceDestinations v-if="activeId" :key="activeId" v-model:open="connectionsOpen" :workspace-id="activeId" />
      <input ref="upload" type="file" class="hidden" aria-label="Ladda upp fil" @change="uploadFile">
    </header>
    <UTabs v-show="!trash" v-model="view" :items="views" :content="false" variant="link" class="shrink-0 border-b border-default bg-default px-4" aria-label="Workspace-vyer">
      <template #trailing="{ item }">
        <span v-if="item.value === 'testing' && browserWorking" role="status" aria-label="Agenten arbetar i webbläsaren" class="inline-flex">
          <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin motion-reduce:animate-none text-primary" />
        </span>
      </template>
    </UTabs>
    <p v-if="error" role="alert" class="px-4 py-2 text-xs text-error">{{ error }}</p>
    <div class="qaa-workspace-content min-h-0 flex-1 overflow-auto">
      <p v-if="!loaded && !error" role="status" class="py-8 text-center text-sm text-muted">Hämtar workspace…</p>
      <div v-if="trash" class="space-y-2">
        <p class="mb-4 text-sm text-muted">Papperskorg — objekt och filer behålls tills vidare och kan återställas.</p>
        <div v-for="item in items" :key="item.id" class="flex items-center gap-3 rounded-lg border border-default bg-default p-3">
          <span class="min-w-0 flex-1 truncate text-sm">{{ item.title }}</span>
          <UButton label="Återställ" icon="i-lucide-undo-2" color="neutral" variant="soft" :disabled="busy" @click="restore(item)" />
        </div>
        <p v-if="loaded && !items.length" class="text-sm text-dimmed">Papperskorgen är tom.</p>
      </div>
      <WorkspaceOverview v-if="activeId && loaded && !trash && view === 'overview'" :workspace-id="activeId" :items="items" :browser-present="browserPresent" @open="openItem" @testing="view = 'testing'" @material="view = 'material'" />
      <WorkspaceLinear v-if="activeId && !trash && view === 'linear'" :key="activeId" :workspace-id="activeId" />
      <WorkspaceTesting v-if="activeId && loaded && !trash && view === 'testing'" :workspace-id="activeId" :items="plans" @open="openItem" />
      <WorkspacePageHeader v-if="!trash && view === 'material'" title="Material" description="Gemensamma dokument, tabeller, bilder och filer för alla chattar.">
        <template #title-action>
          <UButton
            :icon="materialMode === 'table' ? 'i-lucide-layout-grid' : 'i-lucide-table-2'"
            :aria-label="materialMode === 'table' ? 'Visa som kort' : 'Visa som tabell'"
            color="neutral"
            variant="outline"
            @click="materialMode = materialMode === 'table' ? 'cards' : 'table'"
          />
        </template>
        <UInput v-model="materialQuery" icon="i-lucide-search" aria-label="Sök material" placeholder="Sök namn eller ID" />
      </WorkspacePageHeader>
      <WorkspaceMaterialTable v-if="!trash && view === 'material' && materialMode === 'table'" :items="tableMaterials" @open="openItem" />
      <p v-if="loaded && !trash && view === 'material' && materialMode !== 'table' && materialQuery.trim() && !tableMaterials.length" role="status" class="rounded-xl border border-default bg-default p-6 text-sm text-muted">Inget material matchar sökningen.</p>
      <TransitionGroup v-show="!trash && view !== 'overview'" name="cards" tag="div" class="workspace-card-grid">
        <div
v-for="card in orderedCards" v-show="inView(card.item) && (card.item || browserPresent)" :key="card.id" class="min-w-0 rounded-2xl" :class="{ 'ring-2 ring-primary': dropTarget === card.id && draggingCard !== card.id, 'opacity-50': draggingCard === card.id, 'expanded-card-host': expandedItems[card.id] }"
          @dragover.prevent="dropTarget = card.id" @drop.prevent="dropCard(card.id)">
          <div v-show="!expandedItems[card.id]" class="mb-1 flex items-center justify-end gap-1">
            <UButton
icon="i-lucide-grip-vertical" color="neutral" variant="ghost" size="xs" class="cursor-grab active:cursor-grabbing" :draggable="!ordering" :disabled="ordering" :aria-label="`Dra ${card.item?.title || 'Webbläsare'} för att flytta`" title="Dra för att flytta"
              @dragstart="startCardDrag($event, card.id)" @dragend="draggingCard = null; dropTarget = null" />
            <UButton icon="i-lucide-arrow-left" color="neutral" variant="ghost" size="xs" aria-label="Flytta tidigare" title="Flytta tidigare" :disabled="ordering || !neighbor(card.id, -1)" @click="stepCard(card.id, -1)" />
            <UButton icon="i-lucide-arrow-right" color="neutral" variant="ghost" size="xs" aria-label="Flytta senare" title="Flytta senare" :disabled="ordering || !neighbor(card.id, 1)" @click="stepCard(card.id, 1)" />
          </div>
          <WorkspaceItemCard v-if="card.item" v-model:expanded="expandedItems[card.id]" :item="card.item" @saved="refresh" @insert-image="insertImage" />
          <BrowserWorkspace v-else-if="threadId && activeId" :key="activeId" :thread-id="threadId" embedded @presence="browserPresent = $event" @working="browserWorking = $event" @reveal="trash = false; view = 'material'" />
        </div>
      </TransitionGroup>
      <div v-if="loaded && !trash && ['testing', 'material'].includes(view) && !(view === 'testing' ? plans.length : materials.length)" class="mx-auto mt-12 max-w-64 text-center text-sm leading-relaxed text-dimmed">
        <UIcon name="i-lucide-sparkles" class="mb-3 size-6" />
        <p>{{ view === 'testing' ? 'Börja med det ni vill testa.' : 'Plats för ert gemensamma material.' }}</p>
        <p class="mt-2 text-xs">{{ view === 'testing' ? 'Be agenten skapa en testplan från ett krav eller välj Ny testplan. Befintliga dokument och tabeller finns under Material.' : 'Be agenten spara en text, tabell eller skärmbild — eller ladda upp en fil.' }}</p>
      </div>
    </div>
    <WorkspaceInsertImage v-if="imageInsertion" :image="imageInsertion.image" :items="items" :initial-target-id="imageInsertion.targetId" @close="imageInsertion = undefined" @saved="refresh" />
  </aside>
</template>
<style scoped>
.workspace-surface { container-type: inline-size; }
.workspace-card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr)); align-items: start; gap: 1rem; }
.expanded-card-host { transform: none !important; position: static; }
.cards-move { transition: transform 220ms ease; }
@media (prefers-reduced-motion: reduce) { .expanded-card-host { transform: none !important; position: static; }
.cards-move { transition: none; } }
</style>

