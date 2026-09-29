<script setup lang="ts">
defineProps<{ url: string; sessionId: string }>();
defineEmits<{ open: [] }>();
const surface = useTemplateRef('surface');
const width = ref(320);
let observer: ResizeObserver | undefined;
watch(surface, element => {
  observer?.disconnect();
  if (!element) return;
  observer = new ResizeObserver(([entry]) => { if (entry) width.value = entry.contentRect.width; });
  observer.observe(element);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div ref="surface" class="relative aspect-[1280/900] overflow-hidden bg-white">
    <iframe :key="sessionId" :src="url" title="Webbläsarens liveförhandsvisning" class="pointer-events-none origin-top-left border-0" :style="{ width: '1280px', height: '900px', transform: `scale(${width / 1280})` }" tabindex="-1" inert sandbox="allow-same-origin allow-scripts" referrerpolicy="no-referrer" />
    <button type="button" aria-label="Öppna livewebbläsaren" class="absolute inset-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary" @click="$emit('open')" />
  </div>
</template>
