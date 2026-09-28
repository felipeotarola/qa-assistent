<script setup lang="ts">
import type { DocumentBlock } from "#shared/workspace";
const props = defineProps<{ chart: Extract<DocumentBlock, { kind: "chart" }>; preview?: boolean }>();
const maximum = computed(() => Math.max(1, ...props.chart.data.map(point => point.value)));
</script>
<template>
  <figure class="space-y-3 rounded-lg border border-default p-4">
    <figcaption class="font-medium text-highlighted">{{ chart.title }}</figcaption>
    <div v-for="(point, index) in (preview ? chart.data.slice(0, 5) : chart.data)" :key="index" class="space-y-1">
      <div class="flex justify-between gap-3 text-xs"><span class="break-words">{{ point.label }}</span><span class="shrink-0 tabular-nums">{{ point.value }}</span></div>
      <div class="h-3 overflow-hidden rounded bg-muted" aria-hidden="true"><div class="h-full rounded bg-primary" :style="{ width: `${point.value / maximum * 100}%` }" /></div>
    </div>
    <p v-if="preview && chart.data.length > 5" class="text-xs text-muted">+ {{ chart.data.length - 5 }} värden</p>
  </figure>
</template>
