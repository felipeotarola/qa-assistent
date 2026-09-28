<script setup lang="ts">
import type { ChatSuggestion } from "#shared/chat-suggestions";
defineProps<{ suggestions: ChatSuggestion[]; disabled?: boolean }>();
const emit = defineEmits<{ select: [prompt: string] }>();
</script>

<template>
  <div v-if="suggestions.length" class="mt-5 space-y-2.5" role="group" aria-label="Förslag på nästa steg">
    <p class="flex items-center gap-1.5 text-xs font-medium text-muted">
      <UIcon name="i-lucide-sparkles" class="size-3.5" aria-hidden="true" />
      Fortsätt med
    </p>
    <div class="flex flex-wrap gap-2.5">
      <UButton
        v-for="suggestion in suggestions" :key="suggestion.prompt"
        :label="suggestion.label" :title="suggestion.prompt"
        type="button" color="neutral" variant="outline" size="lg"
        trailing-icon="i-lucide-arrow-up-right"
        class="min-h-11 max-w-full rounded-full bg-default px-4 py-2.5 text-left text-sm font-medium text-highlighted shadow-sm ring-accented transition-colors duration-150 hover:bg-elevated hover:ring-inverted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary motion-reduce:transition-none disabled:shadow-none"
        :ui="{ label: 'whitespace-normal break-words', trailingIcon: 'size-4 shrink-0 text-muted' }"
        :disabled="disabled" @click="emit('select', suggestion.prompt)"
      />
    </div>
  </div>
</template>
