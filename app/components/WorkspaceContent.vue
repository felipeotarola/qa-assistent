<script setup lang="ts">
import type { EditableContent } from "#shared/workspace";
defineProps<{ content: EditableContent; workspaceId: string; preview?: boolean }>();
</script>
<template>
  <div v-if="content.kind === 'text'" class="space-y-4">
    <template v-for="(block, index) in (content.blocks ?? [{ kind: 'text' as const, text: content.text }])" :key="index">
      <WorkspaceImage v-if="block.kind === 'image'" :workspace-id="workspaceId" :image="block" />
      <h3 v-else-if="block.kind === 'heading'" class="text-lg font-semibold text-highlighted">{{ block.text }}</h3>
      <p v-else class="whitespace-pre-wrap leading-relaxed">{{ preview ? block.text.slice(0, 500) : block.text }}</p>
    </template>
  </div>
  <table v-else class="w-full border-collapse text-left">
    <thead><tr><th v-for="(column, c) in content.columns" :key="c" class="border border-default bg-muted p-2 font-medium">{{ column }}</th></tr></thead>
    <tbody><tr v-for="(row, r) in (preview ? content.rows.slice(0, 4) : content.rows)" :key="r"><td v-for="(cell, c) in row" :key="c" class="border border-default p-2 align-top">
      <span v-if="typeof cell === 'string'">{{ cell }}</span>
      <WorkspaceImage v-else :workspace-id="workspaceId" :image="cell" :thumbnail="preview" />
    </td></tr></tbody>
  </table>
</template>
