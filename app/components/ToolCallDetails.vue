<script setup lang="ts">
import type { ToolDetail } from '#shared/tool-details';
defineProps<{ input: ToolDetail[]; output: ToolDetail[] }>();
</script>
<template>
  <div class="min-w-0 space-y-4 py-3">
    <section v-for="group in [{ title: 'Anrop', rows: input }, { title: 'Svar', rows: output }]" :key="group.title">
      <template v-if="group.rows.length">
        <h4 class="mb-2 text-xs font-semibold text-muted">{{ group.title }}</h4>
        <dl class="space-y-3">
          <div v-for="(row, index) in group.rows" :key="index" class="min-w-0">
            <dt class="mb-1 text-xs text-muted">{{ row.label }}</dt>
            <dd :class="row.code ? 'font-mono bg-muted rounded-lg p-3' : ''" class="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed [overflow-wrap:anywhere]">{{ row.text }}</dd>
          </div>
        </dl>
      </template>
    </section>
    <p v-if="!input.length && !output.length" class="text-xs text-muted">Inga visningsbara detaljer för detta anrop.</p>
  </div>
</template>
