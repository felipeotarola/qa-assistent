<script setup lang="ts">
const props = defineProps<{ docked: boolean; focusTarget?: string }>();
const open = defineModel<boolean>('open', { required: true });
const collapseButton = useTemplateRef('collapseButton');
const keepOpen = (event: Event) => event.preventDefault();
const savedWidth = useCookie<number>('agent-activity-width', { default: () => 360, sameSite: 'lax', maxAge: 31536000 });
const width = computed({ get: () => Number.isFinite(savedWidth.value) ? Math.max(280, Math.min(520, savedWidth.value)) : 360, set: value => { savedWidth.value = value; } });
const dragWidth = ref<number | null>(null);
const showPanel = computed(() => open.value || (dragWidth.value ?? 56) > 56);
const panelStyle = computed(() => ({ width: `${dragWidth.value ?? (props.docked && !open.value ? 56 : width.value)}px`, maxWidth: 'calc(100vw - 1rem)' }));
const dialogContent = computed(() => ({ onInteractOutside: keepOpen, style: panelStyle.value }));
function focusSection() {
  if (!open.value || !props.focusTarget) return;
  const element = document.getElementById(`activity-section-${props.focusTarget}`);
  element?.scrollIntoView({ block: 'start' });
  element?.focus({ preventScroll: true });
}
watch([open, () => props.focusTarget, () => props.docked], async () => { await nextTick(); focusSection(); });
watch([() => props.docked, open], async ([docked, opened]) => {
  if (docked && opened && !props.focusTarget) { await nextTick(); collapseButton.value?.$el?.focus(); }
});
</script>

<template>
  <aside v-if="docked" :aria-label="showPanel ? 'Pågående arbete' : 'Pågående arbete, hopfällt'" :style="panelStyle" class="relative flex h-full min-h-0 shrink-0 flex-col border-l border-default bg-default">
    <ActivityPanelResizeHandle v-model="width" :collapsed="!open" @preview="dragWidth = $event" @collapse="open = false" @expand="open = true" />
    <div v-show="!showPanel" class="h-full"><slot name="rail" /></div>
    <div v-show="showPanel" class="flex min-h-0 flex-1 flex-col overflow-hidden">
    <div class="flex min-h-0 min-w-[280px] flex-1 flex-col">
    <header class="flex h-(--ui-header-height) shrink-0 items-center justify-between gap-2 border-b border-default px-4">
      <h2 class="text-sm font-semibold">Pågående arbete</h2>
      <UButton ref="collapseButton" icon="i-lucide-panel-right-close" aria-label="Fäll ihop Pågående arbete" title="Fäll ihop till aktivitetsrad" color="neutral" variant="ghost" size="sm" class="shrink-0" @click="open = false" />
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto p-4"><slot /></div>
    </div>
    </div>
  </aside>
  <USlideover v-else v-model:open="open" title="Pågående arbete" description="Agenter, webbläsare och körningar i ditt workspace." :ui="{ content: 'max-w-none overflow-visible', header: 'h-(--ui-header-height) min-h-0 items-center px-4 py-0 sm:px-4', description: 'sr-only', title: 'text-sm', body: 'min-w-0 p-4', wrapper: 'min-w-0 flex-1', close: 'static shrink-0' }" :modal="false" :overlay="false" :content="dialogContent" @after:enter="focusSection">
    <template #close><UButton icon="i-lucide-panel-right-close" aria-label="Fäll ihop Pågående arbete" title="Fäll ihop till aktivitetsrad" color="neutral" variant="ghost" size="sm" class="shrink-0" /></template>
    <template #body><slot /></template>
  </USlideover>
</template>
