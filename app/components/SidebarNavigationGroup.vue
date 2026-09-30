<script setup lang="ts">
const props = defineProps<{ name: string; label: string; summary?: string; collapsed?: boolean }>();
const expanded = useState<Record<string, boolean>>('sidebar-groups', () => ({}));
const open = computed({ get: () => expanded.value[props.name] ?? true, set: value => { expanded.value[props.name] = value; } });
</script>

<template>
  <section class="qaa-nav-group" :aria-label="label">
    <slot v-if="collapsed" />
    <UCollapsible v-else v-model:open="open">
      <UButton color="neutral" variant="ghost" class="qaa-nav-group-toggle w-full" :aria-label="label" :trailing-icon="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'">
        <span class="flex-1 text-left">{{ label }}</span>
        <UBadge v-if="summary" color="neutral" variant="soft" size="sm">{{ summary }}</UBadge>
      </UButton>
      <template #content><div class="pb-2"><slot /></div></template>
    </UCollapsible>
  </section>
</template>
