<script setup lang="ts">
defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ suggestion: [prompt: string] }>();
const { latest, dismiss } = useWorkReports();
const { open } = useAgentActivity();
const route = useRoute();
const canReview = computed(() => !!latest.value?.prompt && (!latest.value.threadId || latest.value.threadId === route.params.id));
</script>
<template>
  <section v-if="latest" class="mb-3 space-y-2 rounded-xl border border-default bg-default p-3" aria-label="Senaste avslutade arbete i workspacet">
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1" role="status" aria-live="polite" aria-atomic="true">
        <p class="text-xs text-muted">Resultat i detta workspace · {{ latest.actor }}</p>
        <p class="text-sm font-semibold">{{ latest.title }}</p>
      </div>
      <UButton icon="i-lucide-x" aria-label="Dölj denna resultatsammanfattning" variant="ghost" size="xs" @click="dismiss" />
    </div>
    <p class="text-xs text-muted">{{ latest.result }}</p>
    <p class="text-xs"><strong>Nästa steg:</strong> {{ latest.next }}</p>
    <div class="flex flex-wrap gap-2">
      <UButton v-if="canReview" label="Granska resultatet" size="xs" variant="soft" :disabled="disabled" @click="emit('suggestion', latest.prompt)" />
      <UButton label="Visa detaljer" size="xs" variant="ghost" @click="open = true" />
    </div>
  </section>
</template>
