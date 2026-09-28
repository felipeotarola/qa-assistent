<script setup lang="ts">
import type { EditableContent, WorkspaceItem } from "#shared/workspace";
const props = defineProps<{ workspaceId: string }>();
const model = defineModel<EditableContent>({ required: true });
const { data } = useFetch<{ items: WorkspaceItem[] }>(() => `/api/workspaces/${props.workspaceId}/items`);
const images = computed(() => (data.value?.items ?? []).filter(i => i.content.kind === "image").map(i => ({ label: i.title, value: i.id })));
const selected = ref<string>();
function insertImage() {
  if (!selected.value || model.value.kind !== "text") return;
  model.value.blocks ??= [{ kind: "text", text: model.value.text }];
  model.value.blocks.push({ kind: "image", itemId: selected.value, caption: "" });
}
function move(index: number, delta: number) {
  if (model.value.kind !== "text" || !model.value.blocks) return;
  const blocks = model.value.blocks;
  const target = index + delta;
  if (target < 0 || target >= blocks.length) return;
  [blocks[index], blocks[target]] = [blocks[target]!, blocks[index]!];
}
</script>
<template>
  <div v-if="model.kind === 'text'" class="space-y-4">
    <div v-for="(block, index) in model.blocks" :key="index" class="space-y-2 rounded-lg border border-default p-3">
      <div class="flex items-center gap-1">
        <span class="flex-1 text-xs text-muted">{{ block.kind === 'image' ? 'Bild' : block.kind === 'heading' ? 'Rubrik' : 'Text' }}</span>
        <UButton icon="i-lucide-arrow-up" aria-label="Flytta upp block" variant="ghost" color="neutral" :disabled="index === 0" @click="move(index, -1)" />
        <UButton icon="i-lucide-arrow-down" aria-label="Flytta ner block" variant="ghost" color="neutral" :disabled="index === model.blocks!.length - 1" @click="move(index, 1)" />
        <UButton icon="i-lucide-x" aria-label="Ta bort block ur dokumentet" variant="ghost" color="neutral" @click="model.blocks!.splice(index, 1)" />
      </div>
      <template v-if="block.kind === 'image'">
        <WorkspaceImage :workspace-id="workspaceId" :image="block" />
        <UInput v-model="block.caption" aria-label="Bildtext" placeholder="Bildtext" class="w-full" />
      </template>
      <UInput v-else-if="block.kind === 'heading'" v-model="block.text" aria-label="Rubrik" class="w-full" />
      <UTextarea v-else v-model="block.text" aria-label="Dokumenttext" autoresize :rows="4" class="w-full" />
    </div>
    <div class="flex flex-wrap gap-2">
      <UButton label="Text" icon="i-lucide-plus" variant="soft" color="neutral" @click="model.blocks!.push({ kind: 'text', text: '' })" />
      <UButton label="Rubrik" variant="soft" color="neutral" @click="model.blocks!.push({ kind: 'heading', text: '' })" />
      <USelect v-model="selected" :items="images" placeholder="Välj bild…" aria-label="Bild från workspace" />
      <UButton label="Infoga bild" variant="soft" color="neutral" :disabled="!selected" @click="insertImage" />
    </div>
    <p class="text-xs text-dimmed">Bilder återanvänds från workspace. Att ta bort ett bildblock raderar inte bildfilen.</p>
  </div>
  <div v-else class="space-y-3 overflow-auto">
    <table class="w-full border-collapse">
      <thead><tr><th v-for="(_, c) in model.columns" :key="c" class="border border-default p-2"><UInput v-model="model.columns[c]" :aria-label="`Kolumn ${c + 1}`" /></th></tr></thead>
      <tbody><tr v-for="(row, r) in model.rows" :key="r"><td v-for="(cell, c) in row" :key="c" class="min-w-40 space-y-2 border border-default p-2 align-top">
        <UInput v-if="typeof cell === 'string'" :model-value="cell" :aria-label="`Rad ${r + 1}, kolumn ${c + 1}`" @update:model-value="row[c] = $event" />
        <template v-else><WorkspaceImage :workspace-id="workspaceId" :image="cell" thumbnail /><UInput v-model="cell.caption" aria-label="Bildtext" /><UButton label="Ta bort bild" variant="ghost" color="neutral" @click="row[c] = ''" /></template>
        <USelect :items="images" placeholder="Infoga bild…" :aria-label="`Bild i rad ${r + 1}, kolumn ${c + 1}`" @update:model-value="row[c] = { kind: 'image', itemId: $event as string, caption: '' }" />
      </td></tr></tbody>
    </table>
    <div class="flex gap-2"><UButton label="Lägg till rad" variant="soft" @click="model.rows.push(model.columns.map(() => ''))" /><UButton label="Lägg till kolumn" variant="soft" @click="model.columns.push('Ny kolumn'); model.rows.forEach(row => row.push(''))" /></div>
  </div>
</template>
