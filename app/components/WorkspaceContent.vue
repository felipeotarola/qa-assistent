<script setup lang="ts">
import type { EditableContent } from "#shared/workspace";
import { documentMarkdown } from "#shared/document-markdown";
import WorkspaceTestPlan from "./WorkspaceTestPlan.vue";
defineProps<{ content: EditableContent; workspaceId: string; preview?: boolean; item?: import("#shared/workspace").WorkspaceItem }>();
</script>
<template>
  <div v-if="content.kind === 'text'" class="space-y-4">
    <template v-for="(block, index) in (content.blocks ?? [{ kind: 'text' as const, text: content.text }])" :key="index">
      <WorkspaceImage v-if="block.kind === 'image'" :workspace-id="workspaceId" :image="block" />
      <h3 v-else-if="block.kind === 'heading'" class="text-lg font-semibold text-highlighted">{{ block.text }}</h3>
      <div v-else-if="block.kind === 'table'" class="overflow-x-auto"><WorkspaceContent :content="block" :workspace-id="workspaceId" :preview="preview" /></div>
      <WorkspaceChart v-else-if="block.kind === 'chart'" :chart="block" :preview="preview" />
      <div v-else class="document-markdown min-w-0 overflow-x-auto leading-relaxed"><ChatComark :value="documentMarkdown(preview ? block.text.slice(0, 6000) : block.text)" /></div>
    </template>
  </div>
  <WorkspaceTestPlan v-else-if="content.kind === 'test_plan'" :plan="content" :item="item" :preview="preview" />
  <WorkspaceDiagram v-else-if="content.kind === 'diagram'" :diagram="content" :preview="preview" />
  <table v-else class="w-full border-collapse text-left">
    <thead><tr><th v-for="(column, c) in content.columns" :key="c" class="border border-default bg-muted p-2 font-medium">{{ column }}</th></tr></thead>
    <tbody><tr v-for="(row, r) in (preview ? content.rows.slice(0, 4) : content.rows)" :key="r"><td v-for="(cell, c) in row" :key="c" class="border border-default p-2 align-top">
      <span v-if="typeof cell === 'string'">{{ cell }}</span>
      <WorkspaceImage v-else :workspace-id="workspaceId" :image="cell" :thumbnail="preview" />
    </td></tr></tbody>
  </table>
</template>
<style scoped>
.document-markdown :deep(table) { width: 100%; border-collapse: collapse; font-size: inherit; }
.document-markdown :deep(th), .document-markdown :deep(td) { border: 1px solid var(--ui-border); padding: 0.65rem; vertical-align: top; min-width: 7rem; }
.document-markdown :deep(th) { background: var(--ui-bg-muted); text-align: left; }
</style>
