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
  <aside v-if="docked" aria-label="Pågående arbete" class="flex h-full min-h-0 w-80 2xl:w-96 shrink-0 flex-col border-l border-default bg-default">
    <header class="flex shrink-0 items-center justify-between gap-2 border-b border-default p-4">
      <h2 class="text-sm font-semibold">Pågående arbete</h2>
      <UButton ref="unpin" icon="i-lucide-pin-off" aria-label="Lossa aktivitetspanelen" title="Lossa aktivitetspanelen" color="neutral" variant="ghost" size="sm" @click="emit('pin')" />
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto p-4"><slot /></div>
  </aside>
  <USlideover v-else v-model:open="open" title="Pågående arbete" description="Aktivitet och resultat från den öppna chatten." :modal="false" :overlay="false" :content="{ onInteractOutside: keepOpen }">
    <template #actions>
      <UButton v-if="canPin" icon="i-lucide-pin" aria-label="Fäst aktivitetspanelen" title="Fäst aktivitetspanelen till höger" color="neutral" variant="ghost" size="sm" @click="emit('pin')" />
    </template>
    <template #body><slot /></template>
  </USlideover>
</template>
