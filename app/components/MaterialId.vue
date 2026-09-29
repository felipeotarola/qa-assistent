<script setup lang="ts">
const props = defineProps<{ id: string; compact?: boolean }>();
const toast = useToast();
async function copy() {
  try { await navigator.clipboard.writeText(props.id); toast.add({ title: 'Material-ID kopierat', icon: 'i-lucide-check', color: 'success' }); }
  catch { toast.add({ title: 'Kunde inte kopiera ID', description: props.id, color: 'error' }); }
}
</script>
<template>
  <UButton icon="i-lucide-copy" :label="compact ? undefined : id" :title="id" aria-label="Kopiera material-ID" color="neutral" variant="ghost" :class="compact ? '' : 'font-mono text-xs'" @click.stop="copy" />
</template>
