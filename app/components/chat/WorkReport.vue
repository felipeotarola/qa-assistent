<script setup lang="ts">
defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ suggestion: [prompt: string] }>();
const { latest, dismiss } = useWorkReports();
const { open } = useAgentActivity();
const expanded = ref(false);
watch(() => latest.value?.id, () => { expanded.value = false; });
const route = useRoute();
const canReview = computed(() => !!latest.value?.prompt && (!latest.value.threadId || latest.value.threadId === route.params.id));
</script>
<template>
  <section v-if="latest" class="composer-report mb-3 space-y-2 rounded-xl border border-default bg-default p-3" :class="{ 'is-expanded': expanded }" aria-label="Senaste avslutade arbete i workspacet">
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1" role="status" aria-live="polite" aria-atomic="true">
        <p class="text-xs text-muted"><span class="composer-report-context">Resultat i detta workspace · </span>{{ latest.actor }}</p>
        <p class="composer-report-title text-sm font-semibold">{{ latest.title }}</p>
      </div>
      <UButton icon="i-lucide-x" aria-label="Dölj denna resultatsammanfattning" variant="ghost" size="xs" @click="dismiss" />
    </div>
    <div class="composer-report-body space-y-2">
      <p class="text-xs text-muted">{{ latest.result }}</p>
      <p class="text-xs"><strong>Nästa steg:</strong> {{ latest.next }}</p>
    </div>
    <div class="flex flex-wrap gap-2">
      <UTooltip v-if="canReview" text="Granska resultatet"><UButton class="composer-icon-control" icon="i-lucide-scan-eye" aria-label="Granska resultatet" size="xs" variant="soft" :disabled="disabled" @click="emit('suggestion', latest.prompt)"><span class="composer-control-label">Granska resultatet</span></UButton></UTooltip>
      <UTooltip text="Visa detaljer i Pågående arbete"><UButton class="composer-icon-control" icon="i-lucide-panel-right-open" aria-label="Visa detaljer i Pågående arbete" size="xs" variant="ghost" @click="open = true"><span class="composer-control-label">Visa detaljer</span></UButton></UTooltip>
      <UTooltip :text="expanded ? 'Dölj sammanfattning' : 'Visa sammanfattning'"><UButton class="composer-compact-icon" :icon="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" :aria-label="expanded ? 'Dölj sammanfattning' : 'Visa sammanfattning'" :aria-expanded="expanded" size="xs" variant="ghost" @click="expanded = !expanded" /></UTooltip>
    </div>
  </section>
</template>
