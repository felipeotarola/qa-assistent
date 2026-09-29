<script setup lang="ts">
import { materialKinds } from "#shared/workspace-presentation";
import type { WorkspaceItem } from '#shared/workspace';
defineProps<{ items: WorkspaceItem[] }>();
defineEmits<{ open: [item: WorkspaceItem] }>();
const columns = [{ accessorKey: 'title', header: 'Material' }, { id: 'kind', header: 'Typ' }, { accessorKey: 'version', header: 'Version' }, { accessorKey: 'updatedAt', header: 'Uppdaterat' }, { id: 'id', header: 'Material-ID' }];
</script>
<template>
  <UTable :data="items" :columns="columns" class="w-full rounded-xl border border-default bg-default" empty="Inget material matchar sökningen.">
    <template #title-cell="{ row }"><UButton :label="row.original.title" color="neutral" variant="link" class="whitespace-normal text-left font-medium" @click="$emit('open', row.original)" /></template>
    <template #kind-cell="{ row }"><UBadge color="neutral" variant="soft">{{ materialKinds[row.original.content.kind].label }}</UBadge></template>
    <template #version-cell="{ row }">v{{ row.original.version }}</template>
    <template #updatedAt-cell="{ row }"><time :datetime="row.original.updatedAt" class="whitespace-nowrap text-xs text-muted">{{ new Date(row.original.updatedAt).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' }) }}</time></template>
    <template #id-cell="{ row }"><MaterialId :id="row.original.id" /></template>
  </UTable>
</template>
