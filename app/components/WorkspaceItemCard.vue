<script setup lang="ts">
import type { WorkspaceItem, ItemContent, EditableContent } from "#shared/workspace";
import WorkspaceTestPlanPublication from "./WorkspaceTestPlanPublication.vue";
import WorkspaceTestPlanSources from "./WorkspaceTestPlanSources.vue";
import { imageReferences } from "#shared/workspace";
import { WORKSPACE_IMAGE_MIME } from "#shared/insert-workspace-image";
const props = defineProps<{ item: WorkspaceItem }>();
const emit = defineEmits<{ saved: []; insertImage: [imageId: string, targetId?: string] }>();
const imageOver = ref(false);
function imageDrag(event: DragEvent) {
  if (!event.dataTransfer) return;
  event.stopPropagation();
  event.dataTransfer.effectAllowed = "link";
  event.dataTransfer.setData(WORKSPACE_IMAGE_MIME, JSON.stringify({ itemId: props.item.id, workspaceId: props.item.workspaceId }));
}
function imageDragOver(event: DragEvent) {
  if (!["text", "table"].includes(props.item.content.kind) || editing.value || !event.dataTransfer?.types.includes(WORKSPACE_IMAGE_MIME)) return;
  event.preventDefault(); event.stopPropagation(); imageOver.value = true;
  event.dataTransfer.dropEffect = "link";
}
function imageDrop(event: DragEvent) {
  imageOver.value = false;
  if (!event.dataTransfer?.types.includes(WORKSPACE_IMAGE_MIME)) return;
  event.preventDefault(); event.stopPropagation();
  if (!["text", "table"].includes(props.item.content.kind) || editing.value) return;
  try {
    const data = JSON.parse(event.dataTransfer.getData(WORKSPACE_IMAGE_MIME));
    if (data.workspaceId === props.item.workspaceId && typeof data.itemId === "string") emit("insertImage", data.itemId, props.item.id);
  } catch { /* Ignore unrelated drag payloads. */ }
}
async function createTestPlan() {
  busy.value = true; error.value = "";
  try {
    await $fetch(`${base.value}/test-plan`, { method: "POST", body: { expectedVersion: props.item.version } });
    emit("saved");
    toast.add({ title: "Testplansutkast skapat", description: "Originalet finns kvar under Material. Öppna Testning för att komplettera testplanen." });
  } catch { error.value = "Kunde inte skapa testplan. Uppdatera källan och försök igen."; }
  finally { busy.value = false; }
}
const expanded = defineModel<boolean>('expanded', { default: false });
const editing = ref(false);
const busy = ref(false);
const error = ref("");
const toast = useToast();
async function remove() {
  const endpoint = base.value;
  busy.value = true; error.value = "";
  try {
    await $fetch(endpoint, { method: "DELETE" });
    emit("saved");
    toast.add({ title: "Flyttat till papperskorgen", description: props.item.title, actions: [{ label: "Ångra", onClick: async () => {
      try { await $fetch(`${endpoint}/restore`, { method: "POST" }); emit("saved"); }
      catch { toast.add({ title: "Kunde inte återställa. Försök via papperskorgen.", color: "error" }); }
    } }] });
  }
  catch (cause) { error.value = (cause as { statusCode?: number }).statusCode === 409 ? "Bilden används i ett dokument eller en tabell. Ta bort bildreferensen där först." : "Kunde inte ta bort objektet. Försök igen."; }
  finally { busy.value = false; }
}
const title = ref("");
const draft = ref<EditableContent>({ kind: "text", text: "", blocks: [] });
const images = computed(() => imageReferences(props.item.content));
const editVersion = ref(0);
const versions = ref<Array<{ version: number; title: string; content: ItemContent }>>([]);
const base = computed(() => `/api/workspaces/${props.item.workspaceId}/items/${props.item.id}`);
const isEditable = computed(() => ["text", "table", "test_plan", "diagram"].includes(props.item.content.kind));
function edit(content = props.item.content, name = props.item.title) {
  title.value = name; editVersion.value = props.item.version;
  if (content.kind !== "text" && content.kind !== "table" && content.kind !== "test_plan" && content.kind !== "diagram") return;
  draft.value = JSON.parse(JSON.stringify(content));
  if (draft.value.kind === "text") draft.value.blocks ??= [{ kind: "text", text: draft.value.text }];
  editing.value = true;
}
async function save() {
  busy.value = true; error.value = "";
  try {
    await $fetch(base.value, { method: "PATCH", body: { title: title.value, expectedVersion: editVersion.value, content: draft.value } });
    editing.value = false; versions.value = []; emit("saved");
  }
  catch { error.value = "Kunde inte spara. Om objektet ändrats, avbryt och öppna redigeringen igen."; }
  finally { busy.value = false; }
}
async function history() {
  try { versions.value = (await $fetch<{ versions: typeof versions.value }>(`${base.value}/versions`)).versions; }
  catch { error.value = "Kunde inte hämta historiken."; }
}
</script>
<template>
  <WorkspaceCard v-model:expanded="expanded" :draggable="item.content.kind === 'image'" :class="imageOver ? 'ring-2 ring-primary' : ''" :title="item.title" :subtitle="`${item.content.kind === 'diagram' ? 'Diagram' : item.content.kind === 'test_plan' ? 'Testplan' : item.content.kind === 'text' ? 'Dokument' : item.content.kind === 'table' ? 'Tabell' : item.content.kind === 'image' ? 'Bild' : 'Fil'} · version ${item.version}`" :icon="item.content.kind === 'diagram' ? 'i-lucide-workflow' : item.content.kind === 'test_plan' ? 'i-lucide-list-checks' : item.content.kind === 'table' ? 'i-lucide-table-2' : item.content.kind === 'image' ? 'i-lucide-image' : 'i-lucide-file-text'" @dragstart="item.content.kind === 'image' && imageDrag($event)" @dragover="imageDragOver" @dragleave="imageOver = false" @drop="imageDrop">
    <template #actions>
      <UButton v-if="item.content.kind === 'image'" icon="i-lucide-image-plus" color="neutral" variant="ghost" aria-label="Infoga bilden i dokument eller tabell" title="Dra till ett dokument eller en tabell, eller klicka för att välja" draggable="true" @dragstart="imageDrag" @click="emit('insertImage', item.id)" />
      <UDropdownMenu :items="[...(['text', 'table'].includes(item.content.kind) ? [{ label: 'Skapa testplan', icon: 'i-lucide-list-checks', disabled: busy || editing, onSelect: createTestPlan }] : []), ...(item.content.kind === 'image' ? [{ label: 'Infoga i…', icon: 'i-lucide-image-plus', onSelect: () => emit('insertImage', item.id) }] : []), { label: 'Ta bort', icon: 'i-lucide-trash-2', color: 'error', disabled: busy || editing, onSelect: remove }]">
        <UButton icon="i-lucide-ellipsis" :aria-label="`Åtgärder för ${item.title}`" color="neutral" variant="ghost" :disabled="busy" />
      </UDropdownMenu>
    </template>
    <template #toolbar>
      <div class="flex flex-wrap gap-2 border-b border-default p-3">
        <template v-if="isEditable">
          <UButton v-if="!editing" label="Redigera" variant="soft" color="neutral" @click="edit()" />
          <template v-else><UButton label="Spara" :loading="busy" @click="save" /><UButton label="Avbryt" variant="ghost" color="neutral" @click="editing = false" /></template>
          <UButton label="Historik" icon="i-lucide-history" variant="ghost" color="neutral" @click="history" />
          <USelect v-if="versions.length" placeholder="Återställ version…" :items="versions.map(v => ({ label: `Version ${v.version}`, value: v.version }))" aria-label="Återställ version" @update:model-value="value => { const v = versions.find(v => v.version === value); if (v) edit(v.content, v.title); }" />
        </template>
        <a v-else :href="`${base}/file`" target="_blank" rel="noopener" class="text-sm underline">{{ item.content.kind === 'image' ? 'Öppna bild' : 'Ladda ner fil' }}</a>
      </div>
    </template>
    <div class="h-full overflow-auto p-4" :class="expanded ? 'text-sm' : 'text-xs'">
      <template v-if="expanded && editing">
        <UInput v-model="title" aria-label="Titel" class="mb-4 w-full" />
        <WorkspaceContentEditor v-model="draft" :workspace-id="item.workspaceId" />
      </template>
      <WorkspaceContent v-else-if="item.content.kind === 'text' || item.content.kind === 'table' || item.content.kind === 'test_plan' || item.content.kind === 'diagram'" :content="item.content" :item="item" :workspace-id="item.workspaceId" :preview="!expanded" />
      <img v-else-if="item.content.kind === 'image'" :src="`${base}/file`" :alt="item.title" class="h-full w-full object-contain">
      <div v-else class="flex h-full flex-col items-center justify-center gap-3 text-muted"><UIcon name="i-lucide-file" class="size-10" /><span>{{ item.content.filename }}</span><span>{{ Math.ceil(item.content.size / 1024) }} KB</span></div>
    </div>
    <template #footer><WorkspaceTestPlanSources v-if="item.content.kind === 'diagram'" :plan="item.content" :workspace-id="item.workspaceId" /><UCollapsible v-if="item.content.kind === 'test_plan'" class="border-b border-default"><UButton label="Underlag & Linear" icon="i-lucide-link" trailing-icon="i-lucide-chevron-down" color="neutral" variant="ghost" class="m-2" /><template #content><WorkspaceTestPlanSources v-if="item.content.kind === 'test_plan'" :plan="item.content" :workspace-id="item.workspaceId" /><WorkspaceTestPlanPublication v-if="item.content.kind === 'test_plan'" :item="item" :disabled="editing || busy" @saved="emit('saved')" /><WorkspaceEvidence :item="item" /></template></UCollapsible><WorkspaceQuickTask v-if="isEditable" :item="item" :disabled="editing || busy" /><WorkspaceEvidence v-if="item.content.kind !== 'test_plan'" :item="item" /><div v-if="images.length" class="flex items-center gap-2 border-b border-default px-4 py-2"><WorkspaceImage v-for="(image, i) in images.slice(0, 3)" :key="i" :workspace-id="item.workspaceId" :image="image" thumbnail /><span class="text-xs text-muted">{{ images.length }} bilder</span></div><div class="px-4 py-2 text-[10px] text-dimmed">{{ editing ? 'Ändringarna sparas som en ny version' : 'Sparat i workspace' }}</div><p v-if="error" role="alert" class="px-4 pb-3 text-xs text-error">{{ error }}</p></template>
  </WorkspaceCard>
</template>
