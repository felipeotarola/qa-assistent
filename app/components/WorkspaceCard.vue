<script setup lang="ts">
defineProps<{ title: string; subtitle?: string; icon?: string }>();
const expanded = defineModel<boolean>("expanded", { default: false });
const toggle = useTemplateRef("toggle");

function collapse() {
  expanded.value = false;
  nextTick(() => toggle.value?.focus());
}
</script>

<template>
  <section
    class="workspace-card flex min-h-0 flex-col overflow-hidden border border-default bg-default"
    :class="expanded ? 'workspace-card-expanded absolute inset-3 z-10 sm:inset-5' : 'relative w-full min-w-0 hover:border-accented'"
    :aria-label="title"
    @keydown.esc.stop="collapse"
  >
    <header class="flex shrink-0 items-center gap-3 border-b border-default bg-muted/50 px-4 py-4">
      <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted">
        <UIcon :name="icon || 'i-lucide-panel-top'" class="size-4" />
      </div>
      <div class="min-w-0 flex-1">
        <h3 class="truncate text-sm font-semibold text-highlighted" :title="title">{{ title }}</h3>
        <p v-if="subtitle" class="truncate text-xs text-dimmed" :title="subtitle">{{ subtitle }}</p>
      </div>
      <slot name="actions" />
      <button
        ref="toggle" type="button"
        class="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        :aria-label="expanded ? 'Tillbaka till workspace' : 'Expandera ' + title"
        :title="expanded ? 'Tillbaka till workspace' : 'Expandera'"
        :aria-expanded="expanded"
        @click="expanded ? collapse() : expanded = true"
      >
        <UIcon :name="expanded ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'" class="size-4" />
      </button>
    </header>
    <div v-show="expanded" class="shrink-0"><slot name="toolbar" /></div>
    <div class="relative min-h-0 overflow-hidden" :class="expanded ? 'flex-1' : 'aspect-[1280/900]'">
      <slot :expanded="expanded" />
      <button
        v-if="!expanded" type="button"
        class="group absolute inset-0 z-10 flex items-end justify-center bg-transparent pb-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
        :aria-label="'Öppna ' + title" @click="expanded = true"
      >
        <span class="flex translate-y-1 items-center gap-2 rounded-full border border-white/15 bg-black/75 px-3 py-1.5 text-xs text-white opacity-0 shadow-lg backdrop-blur-sm transition-all group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100">
          <UIcon name="i-lucide-maximize-2" class="size-3" /> Öppna
        </span>
      </button>
    </div>
    <footer class="shrink-0 border-t border-default/70"><slot name="footer" :expanded="expanded" /></footer>
  </section>
</template>

<style scoped>
.workspace-card { transition: box-shadow 180ms ease, border-color 180ms ease; }
.workspace-card-expanded { animation: workspace-open 180ms ease-out; }
@keyframes workspace-open { from { opacity: 0.6; transform: translateY(6px) scale(0.985); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .workspace-card, .workspace-card * { animation: none; transition: none; }
}
</style>
