<script setup lang="ts">
const props = defineProps<{ docked: boolean; canPin: boolean }>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ pin: [] }>();
const unpin = useTemplateRef('unpin');
const keepOpen = (event: Event) => event.preventDefault();
watch(() => props.docked, async docked => {
  if (docked) { await nextTick(); unpin.value?.$el?.focus(); }
});
</script>

<template>
  <aside v-if="docked" aria-label="Pågående arbete" class="flex h-full min-h-0 w-[20.025rem] 2xl:w-[23.4rem] shrink-0 flex-col border-l border-default bg-default">
    <header class="flex shrink-0 items-center justify-between gap-2 border-b border-default p-4">
      <h2 class="text-sm font-semibold">Pågående arbete</h2>
      <UButton ref="unpin" icon="i-lucide-pin-off" aria-label="Lossa aktivitetspanelen" title="Lossa aktivitetspanelen" color="neutral" variant="ghost" size="sm" @click="emit('pin')" />
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto p-4"><slot /></div>
  </aside>
  <USlideover v-else v-model:open="open" title="Pågående arbete" description="Agenter, webbläsare och körningar i ditt workspace." :ui="{ content: 'max-w-[23.4rem]', header: 'items-start', wrapper: 'min-w-0 flex-1', close: 'static shrink-0' }" :close="{ size: 'sm' }" :modal="false" :overlay="false" :content="{ onInteractOutside: keepOpen }">
    <template #actions>
      <UButton v-if="canPin" icon="i-lucide-pin" aria-label="Fäst aktivitetspanelen" title="Fäst aktivitetspanelen till höger" color="neutral" variant="ghost" size="sm" class="shrink-0" @click="emit('pin')" />
    </template>
    <template #body><slot /></template>
  </USlideover>
</template>
