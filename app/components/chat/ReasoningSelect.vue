<script setup lang="ts">
import { DEFAULT_REASONING, type ReasoningLevel } from "#shared/chat-models";

const model = defineModel<ReasoningLevel>({ default: DEFAULT_REASONING });
defineProps<{ disabled?: boolean }>();
const options = [
  { label: "Low", value: "low" },
  { label: "High", value: "high" },
  { label: "Max", value: "max" },
];
</script>

<template>
  <div class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted">
    <span class="composer-control-label">Reasoning</span>
    <UTooltip :text="`Resonemang: ${options.find(option => option.value === model)?.label}`">
    <USelect
      v-model="model"
      :items="options"
      :disabled="disabled"
      :aria-label="`Resonemang: ${options.find(option => option.value === model)?.label}`"
      size="xs"
      color="neutral"
      class="composer-reasoning w-20"
    >
      <template #default><UIcon name="i-lucide-brain" class="composer-compact-icon size-4 shrink-0" /><span class="composer-control-label">{{ options.find(option => option.value === model)?.label }}</span></template>
    </USelect>
    </UTooltip>
  </div>
</template>
