<script setup lang="ts">
import type { WorkspaceItem, EditableContent } from "#shared/workspace";
import { insertWorkspaceImage, type ImagePlacement } from "#shared/insert-workspace-image";
const props = defineProps<{ image: WorkspaceItem; items: WorkspaceItem[]; initialTargetId?: string }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const open = ref(true);
watch(open, value => { if (!value) emit("close"); });
const targetId = ref(props.initialTargetId);
const target = ref<WorkspaceItem>();
const location = ref("document");
const position = ref(0);
const row = ref(0);
const column = ref(0);
const replace = ref(false);
const busy = ref(false);
const error = ref("");
const targets = computed(() => props.items.filter(item => item.content.kind === "text" || item.content.kind === "table").map(item => ({ label: item.title, value: item.id })));
function loadTarget() {
  const item = props.items.find(item => item.id === targetId.value);
  target.value = item ? JSON.parse(JSON.stringify(item)) : undefined;
  location.value = item?.content.kind === "table" ? "table" : "document";
  position.value = item?.content.kind === "text" ? (item.content.blocks?.length ?? 1) : 0;
  row.value = 0; column.value = 0; replace.value = false; error.value = "";
}
watch(targetId, loadTarget, { immediate: true });
const blocks = computed(() => target.value?.content.kind === "text" ? target.value.content.blocks ?? [{ kind: "text" as const, text: target.value.content.text }] : []);
const locations = computed(() => [{ label: "Mellan dokumentets block", value: "document" }, ...blocks.value.flatMap((block, index) => block.kind === "table" ? [{ label: `Tabell i block ${index + 1}`, value: String(index) }] : [])]);
const positions = computed(() => Array.from({ length: blocks.value.length + 1 }, (_, index) => ({ label: index === 0 ? "Först i dokumentet" : index === blocks.value.length ? "Sist i dokumentet" : `Efter block ${index}: ${blocks.value[index - 1]!.kind === 'text' || blocks.value[index - 1]!.kind === 'heading' ? 'text / rubrik' : blocks.value[index - 1]!.kind}`, value: index })));
const table = computed(() => {
  const content = target.value?.content;
  if (content?.kind === "table") return content;
  const block = blocks.value[Number(location.value)];
  return location.value !== "document" && block?.kind === "table" ? block : undefined;
});
const cell = computed(() => table.value?.rows[row.value]?.[column.value]);
const occupied = computed(() => table.value && cell.value !== undefined && cell.value !== "");
watch([location, row, column], () => { replace.value = false; });
watch(location, () => { row.value = 0; column.value = 0; });
const canSave = computed(() => target.value && (location.value === "document" || (cell.value !== undefined && (!occupied.value || replace.value))));
async function save() {
  if (!canSave.value || busy.value || !target.value) return;
  busy.value = true; error.value = "";
  try {
    const placement: ImagePlacement = location.value === "document" ? { kind: "document", index: position.value } : { kind: "cell", row: row.value, column: column.value, ...(target.value.content.kind === "text" ? { blockIndex: Number(location.value) } : {}) };
    const content = insertWorkspaceImage(target.value.content as EditableContent, { kind: "image", itemId: props.image.id, caption: props.image.title }, placement, replace.value);
    await $fetch(`/api/workspaces/${props.image.workspaceId}/items/${target.value.id}`, { method: "PATCH", body: { title: target.value.title, content, expectedVersion: target.value.version } });
    emit("saved"); open.value = false;
  } catch (cause) { error.value = (cause as { statusCode?: number }).statusCode === 409 ? "Innehållet har ändrats. Stäng och öppna dialogen igen för att välja plats i den senaste versionen." : "Kunde inte infoga bilden. Kontrollera innehållet innan du försöker igen."; }
  finally { busy.value = false; }
}
</script>
<template>
  <UModal v-model:open="open" title="Infoga bild" :description="image.title" :dismissible="!busy">
    <template #body>
      <div class="space-y-4">
        <img :src="`/api/workspaces/${image.workspaceId}/items/${image.id}/file`" :alt="image.title" class="max-h-32 rounded-lg object-contain">
        <UFormField label="Dokument eller tabell"><USelect v-model="targetId" :items="targets" placeholder="Välj mål…" class="w-full" :disabled="busy" /></UFormField>
        <p v-if="!targets.length" class="text-sm text-muted">Skapa ett dokument eller en tabell först.</p>
        <template v-if="target">
          <UFormField v-if="target.content.kind === 'text'" label="Placering"><USelect v-model="location" :items="locations" class="w-full" :disabled="busy" /></UFormField>
          <UFormField v-if="location === 'document'" label="Infoga bilden"><USelect v-model="position" :items="positions" class="w-full" :disabled="busy" /></UFormField>
          <template v-else-if="table">
            <UFormField label="Rad"><USelect v-model="row" :items="table.rows.map((r, index) => ({ label: `Rad ${index + 1}: ${typeof r[0] === 'string' ? r[0].slice(0, 60) : 'Bild'}`, value: index }))" class="w-full" :disabled="busy" /></UFormField>
            <UFormField label="Kolumn"><USelect v-model="column" :items="table.columns.map((name, index) => ({ label: name || `Kolumn ${index + 1}`, value: index }))" class="w-full" :disabled="busy" /></UFormField>
            <p v-if="!table.rows.length" class="text-sm text-muted">Tabellen behöver minst en rad. Lägg till en rad i redigeraren först.</p>
            <div v-if="occupied" class="space-y-2 rounded-lg border border-default p-3">
              <p class="text-sm">Cellen innehåller redan: {{ typeof cell === 'string' ? cell : 'en bild' }}</p>
              <UCheckbox v-model="replace" label="Ersätt cellens innehåll med bilden" :disabled="busy" />
            </div>
          </template>
        </template>
        <p class="text-xs text-muted">Bilden återanvänds och göms från kortöversikten när den används. Den finns kvar under ”Visa även använda bilder”.</p>
        <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
      </div>
    </template>
    <template #footer><UButton label="Infoga bild" :disabled="!canSave || busy" :loading="busy" @click="save" /><UButton label="Avbryt" color="neutral" variant="ghost" :disabled="busy" @click="open = false" /></template>
  </UModal>
</template>
