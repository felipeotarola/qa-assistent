<script setup lang="ts">
import type { WorkspaceItem, ItemContent } from "#shared/workspace";
const props = defineProps<{ item: WorkspaceItem }>();
const emit = defineEmits<{ saved: [] }>();
const expanded = ref(false);
const editing = ref(false);
const busy = ref(false);
const error = ref("");
const title = ref("");
const text = ref("");
const columns = ref<string[]>([]);
const rows = ref<string[][]>([]);
const editVersion = ref(0);
const versions = ref<Array<{ version: number; title: string; content: ItemContent }>>([]);
const base = computed(() => `/api/workspaces/${props.item.workspaceId}/items/${props.item.id}`);
const isEditable = computed(() => ["text", "table"].includes(props.item.content.kind));
function edit(content = props.item.content, name = props.item.title) {
  title.value = name; editVersion.value = props.item.version;
  text.value = content.kind === "text" ? content.text : "";
  columns.value = content.kind === "table" ? [...content.columns] : [];
  rows.value = content.kind === "table" ? content.rows.map(r => [...r]) : [];
  editing.value = true;
}
async function save() {
  busy.value = true; error.value = "";
  try {
    await $fetch(base.value, { method: "PATCH", body: { title: title.value, expectedVersion: editVersion.value, content: props.item.content.kind === "table" ? { kind: "table", columns: columns.value, rows: rows.value } : { kind: "text", text: text.value } } });
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
  <WorkspaceCard v-model:expanded="expanded" :title="item.title" :subtitle="`${item.content.kind === 'text' ? 'Dokument' : item.content.kind === 'table' ? 'Tabell' : item.content.kind === 'image' ? 'Bild' : 'Fil'} · version ${item.version}`" :icon="item.content.kind === 'table' ? 'i-lucide-table-2' : item.content.kind === 'image' ? 'i-lucide-image' : 'i-lucide-file-text'">
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
        <textarea v-if="item.content.kind === 'text'" v-model="text" aria-label="Dokumenttext" class="min-h-80 w-full resize-y rounded-lg border border-default bg-default p-3 leading-relaxed outline-primary" />
        <template v-else>
          <table class="w-full border-collapse"><thead><tr><th v-for="(_, c) in columns" :key="c" class="border border-default p-1"><input v-model="columns[c]" :aria-label="`Kolumn ${c + 1}`" class="w-full min-w-24 bg-transparent p-2"></th></tr></thead><tbody><tr v-for="(row, r) in rows" :key="r"><td v-for="(_, c) in columns" :key="c" class="border border-default p-1"><input v-model="row[c]" :aria-label="`Rad ${r + 1}, kolumn ${c + 1}`" class="w-full min-w-24 bg-transparent p-2"></td></tr></tbody></table>
          <div class="mt-3 flex gap-2"><UButton label="Lägg till rad" variant="soft" @click="rows.push(columns.map(() => ''))" /><UButton label="Lägg till kolumn" variant="soft" @click="columns.push('Ny kolumn'); rows.forEach(row => row.push(''))" /></div>
        </template>
      </template>
      <p v-else-if="item.content.kind === 'text'" class="whitespace-pre-wrap leading-relaxed">{{ expanded ? item.content.text : item.content.text.slice(0, 500) }}</p>
      <table v-else-if="item.content.kind === 'table'" class="w-full border-collapse text-left"><thead><tr><th v-for="(column, c) in item.content.columns" :key="c" class="border border-default bg-muted p-2 font-medium">{{ column }}</th></tr></thead><tbody><tr v-for="(row, r) in (expanded ? item.content.rows : item.content.rows.slice(0, 4))" :key="r"><td v-for="(cell, c) in row" :key="c" class="border border-default p-2">{{ cell }}</td></tr></tbody></table>
      <img v-else-if="item.content.kind === 'image'" :src="`${base}/file`" :alt="item.title" class="h-full w-full object-contain">
      <div v-else class="flex h-full flex-col items-center justify-center gap-3 text-muted"><UIcon name="i-lucide-file" class="size-10" /><span>{{ item.content.filename }}</span><span>{{ Math.ceil(item.content.size / 1024) }} KB</span></div>
    </div>
    <template #footer><div class="px-4 py-2 text-[10px] text-dimmed">{{ editing ? 'Ändringarna sparas som en ny version' : 'Sparat i workspace' }}</div><p v-if="error" role="alert" class="px-4 pb-3 text-xs text-error">{{ error }}</p></template>
  </WorkspaceCard>
</template>
