<template>
  <aside class="workspace-panel flex h-full min-h-0 flex-col" aria-label="Workspace">
    <div class="workspace-canvas relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-8">
      <div class="relative flex max-w-xs flex-col items-center text-center">
        <div class="relative mb-9 h-28 w-36" aria-hidden="true">
          <div class="absolute inset-x-4 inset-y-2 -rotate-12 rounded-xl border border-default bg-muted shadow-sm" />
          <div class="absolute inset-x-3 inset-y-1 rotate-6 rounded-xl border border-default bg-elevated shadow-sm" />
          <div class="absolute inset-0 flex flex-col gap-3 rounded-xl border border-default bg-default p-4 shadow-lg shadow-black/5">
            <div class="flex items-center gap-1">
              <span class="size-1 rounded-full bg-accented" />
              <span class="size-1 rounded-full bg-accented" />
              <span class="size-1 rounded-full bg-accented" />
            </div>
            <div class="flex flex-1 items-center justify-center rounded-md border border-dashed border-default">
              <UIcon name="i-lucide-sparkles" class="size-5 text-dimmed" />
            </div>
          </div>
        </div>
        <p class="mb-3 text-[10px] font-medium uppercase tracking-[0.2em] text-dimmed">A little room to create</p>
        <h3 class="text-xl font-medium tracking-tight text-highlighted">Space for what comes next.</h3>
        <p class="mt-3 max-w-60 text-sm leading-relaxed text-muted">
          Your conversation on the left.<br>
          A place to bring ideas to life, here.
        </p>
        <span class="mt-7 inline-flex items-center gap-2 rounded-full border border-default bg-default/80 px-3 py-1.5 text-xs text-dimmed">
          <span class="size-1.5 rounded-full bg-accented" />
          Nothing here yet
        </span>
      </div>
    </div>

    <footer class="flex h-10 shrink-0 items-center justify-between border-t border-default/60 px-5 text-[10px] text-dimmed lg:px-6">
      <span class="flex items-center gap-1.5"><UIcon name="i-lucide-layout-panel-left" class="size-3" /> Your workspace</span>
      <span>A fresh canvas</span>
    </footer>
  </aside>
</template>

<style scoped>
.workspace-panel {
  background: var(--ui-bg);
}

.workspace-canvas {
  background-image:
    radial-gradient(ellipse at center, var(--ui-bg) 15%, transparent 75%),
    radial-gradient(color-mix(in oklab, var(--ui-text-dimmed) 20%, transparent) 0.7px, transparent 0.7px);
  background-size: 100% 100%, 20px 20px;
}
</style>
