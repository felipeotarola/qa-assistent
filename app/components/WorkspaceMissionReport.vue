<script setup lang="ts">
import type { ReportDocument } from '#shared/mission-report';
import { reportText } from '#shared/mission-report';
const props = defineProps<{ workspaceId: string; reportId: string }>();
const { data, error } = await useAsyncData(() => `mission-report-${props.reportId}`, () => useRequestFetch()<{ document: ReportDocument | null; stale: boolean; error: string | null; status: string }>(`/api/workspaces/${props.workspaceId}/reports/${props.reportId}`));
const assets = computed(() => data.value?.document?.evidence.flatMap(e => e.itemId && e.kind === 'image' ? [{ id: e.id, url: `/api/workspaces/${props.workspaceId}/reports/${props.reportId}/asset?evidenceId=${encodeURIComponent(e.id)}` }] : []));
const { requestedItem } = useAgentActivity();
function openEvidence(itemId: string) { requestedItem.value = { workspaceId: props.workspaceId, itemId }; }
const copying = ref(false), copyError = ref('');
async function copy() {
  if (!data.value?.document) return;
  copying.value = true;
  try { await $fetch(`/api/workspaces/${props.workspaceId}/items`, { method: 'POST', body: { title: `${data.value.document.title} · redigerbar kopia`, content: { kind: 'text', text: `Redigerbar kopia av Klaras rapport. Ändringar här är inte Klaras oförändrade bedömning.\n\n${reportText(data.value.document)}` } } }); useToast().add({ title: 'Kopian finns i Material' }); } catch { copyError.value = 'Kunde inte skapa kopian.'; } finally { copying.value = false; }
}
function print() { window.open(`/reports/${props.reportId}?workspace=${props.workspaceId}`, '_blank', 'noopener,noreferrer'); }
</script>
<template>
  <div class="@container space-y-4">
    <p v-if="error || data?.error" role="alert" class="text-error">{{ data?.error || 'Rapporten kunde inte hämtas.' }}</p>
    <template v-if="data?.document"><div class="flex flex-wrap items-center gap-2 print:hidden"><ReportSharing :workspace-id="workspaceId" :report-id="reportId" :document="data.document" /><ReportComparison :workspace-id="workspaceId" :report-id="reportId" :document="data.document" /><UButton label="Redigerbar kopia" icon="i-lucide-copy" variant="ghost" color="neutral" :loading="copying" @click="copy" /><UButton label="Skriv ut eller spara PDF" icon="i-lucide-printer" variant="ghost" color="neutral" @click="print" /></div><p v-if="copyError" role="alert" class="text-error">{{ copyError }}</p><p v-if="data.stale" class="text-warning">Nya resultat har tillkommit. Den här rapporten gäller lägesbilden vid angiven tidpunkt.</p><MissionReportDocument :document="data.document" :assets="assets" can-open-evidence @open-evidence="openEvidence" /></template>
  </div>
</template>
