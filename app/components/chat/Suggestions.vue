<script setup lang="ts">
import type { ChatSuggestion } from "#shared/chat-suggestions";
defineProps<{ suggestions: ChatSuggestion[]; disabled?: boolean }>();
const emit = defineEmits<{ select: [prompt: string] }>();
</script>

<template>
  <div v-if="suggestions.length" class="mt-4 flex flex-wrap gap-2" role="group" aria-label="Förslag på nästa steg">
    <UButton
      v-for="suggestion in suggestions" :key="suggestion.prompt"
      :label="suggestion.label" :title="suggestion.prompt"
      color="neutral" variant="outline" size="sm"
      class="max-w-full whitespace-normal text-left"
      :disabled="disabled" @click="emit('select', suggestion.prompt)"
    />
  </div>
</template>
