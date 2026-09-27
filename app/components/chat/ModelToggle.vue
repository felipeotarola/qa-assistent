<script setup lang="ts">
import { CHAT_MODELS, DEFAULT_CHAT_MODEL, type ChatModelId } from "#shared/chat-models";

const model = defineModel<ChatModelId>({ default: DEFAULT_CHAT_MODEL });
defineProps<{ disabled?: boolean }>();
</script>

<template>
  <div class="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-elevated p-0.5" role="group" aria-label="Chat model">
    <UButton
      v-for="option in CHAT_MODELS"
      :key="option.id"
      :label="option.label"
      :icon="option.id === 'glm-5.3-flash' ? 'i-lucide-zap' : 'i-lucide-sparkles'"
      :variant="model === option.id ? 'solid' : 'ghost'"
      :aria-pressed="model === option.id"
      :aria-label="option.id === 'glm-5.3-flash' ? 'GLM 5.3 Flash' : option.label"
      :disabled="disabled"
      color="neutral"
      size="xs"
      @click="model = option.id"
    />
  </div>
</template>
