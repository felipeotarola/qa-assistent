<script setup lang="ts">
defineProps<{ text: string; streaming: boolean }>();
</script>
<template>
  <UCollapsible class="my-2" :unmount-on-hide="true">
    <UButton :label="streaming ? 'Analyserar…' : 'Visa analys'" :icon="streaming ? 'i-lucide-loader-circle' : 'i-lucide-brain'" color="neutral" variant="ghost" size="xs" trailing-icon="i-lucide-chevron-down" />
    <template #content><div class="max-h-64 overflow-auto py-2 text-sm text-muted"><ChatComark :value="text" :streaming="streaming" /></div></template>
  </UCollapsible>
</template>
