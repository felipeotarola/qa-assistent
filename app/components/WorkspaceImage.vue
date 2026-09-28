<script setup lang="ts">
import type { ImageReference } from "#shared/workspace";
const props = defineProps<{ workspaceId: string; image: ImageReference; thumbnail?: boolean }>();
const failed = ref(false);
watch(() => props.image.itemId, () => { failed.value = false; });
</script>
<template>
  <figure class="min-w-0">
    <p v-if="failed" class="rounded-lg bg-muted p-3 text-xs text-dimmed">Bilden är inte tillgänglig. Kontrollera papperskorgen.</p>
    <img v-else :src="`/api/workspaces/${workspaceId}/items/${image.itemId}/file`" :alt="image.caption || 'Bild i workspace'" loading="lazy" class="rounded-lg border border-default object-contain" :class="thumbnail ? 'h-12 w-16 object-cover' : 'max-h-[60vh] w-full'" @error="failed = true">
    <figcaption v-if="image.caption && !thumbnail" class="mt-2 text-xs text-muted">{{ image.caption }}</figcaption>
  </figure>
</template>
