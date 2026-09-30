<script setup lang="ts">
defineProps<{ title: string; description: string }>();
</script>

<template>
  <header class="qaa-page-header">
    <div :class="{ 'w-full': $slots['title-action'] }">
      <div class="flex items-start justify-between gap-4">
        <h2>{{ title }}</h2>
        <div v-if="$slots['title-action']" class="shrink-0"><slot name="title-action" /></div>
      </div>
      <p>{{ description }}</p>
    </div>
    <div v-if="$slots.default" class="qaa-page-actions"><slot /></div>
  </header>
</template>
