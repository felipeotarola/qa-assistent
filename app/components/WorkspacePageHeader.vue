<script setup lang="ts">
defineProps<{ title: string; description: string }>();
</script>

<template>
  <header class="qaa-page-header">
    <div><h2>{{ title }}</h2><p>{{ description }}</p></div>
    <div v-if="$slots.default" class="qaa-page-actions"><slot /></div>
  </header>
</template>
