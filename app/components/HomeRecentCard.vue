<script setup lang="ts">
defineProps<{ title: string; description: string; icon: string; to?: string }>();
const emit = defineEmits<{ select: [] }>();
</script>
<template>
  <UButton :to="to" color="neutral" variant="outline" class="group min-h-18 w-full min-w-0 justify-start gap-3 rounded-xl bg-default px-4 py-3 text-left transition-colors hover:bg-elevated motion-reduce:transition-none" @click="emit('select')">
    <UIcon :name="icon" class="size-4 shrink-0 text-muted" />
    <span class="min-w-0 flex-1">
      <span class="block truncate text-sm font-medium text-highlighted" :title="title">{{ title }}</span>
      <span class="mt-1 block truncate text-xs font-normal text-muted">{{ description }}</span>
    </span>
    <UIcon name="i-lucide-arrow-up-right" class="size-3.5 shrink-0 text-dimmed group-hover:text-highlighted" />
  </UButton>
</template>
