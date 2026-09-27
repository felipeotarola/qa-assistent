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
  <label class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted">
    <span>Reasoning</span>
    <USelect
      v-model="model"
      :items="options"
      :disabled="disabled"
      aria-label="Reasoning level"
      size="xs"
      color="neutral"
      class="w-20"
    />
  </label>
</template>
