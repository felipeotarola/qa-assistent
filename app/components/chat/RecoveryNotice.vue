<script setup lang="ts">
defineProps<{ message: string; savedText?: string; busy?: boolean }>();
const emit = defineEmits<{ reconnect: []; restore: []; dismiss: [] }>();
</script>

<template>
  <UAlert color="warning" variant="subtle" icon="i-lucide-wifi-off" title="Chatten behöver din uppmärksamhet" :description="message" role="status" aria-live="polite">
    <template #actions>
      <UButton label="Hämta senaste status" icon="i-lucide-refresh-cw" color="neutral" variant="soft" :loading="busy" @click="emit('reconnect')" />
      <UButton v-if="savedText" label="Öppna text som utkast" color="neutral" variant="ghost" :disabled="busy" @click="emit('restore')" />
      <UButton v-if="savedText" label="Avfärda sparad text" color="neutral" variant="ghost" :disabled="busy" @click="emit('dismiss')" />
    </template>
  </UAlert>
</template>
