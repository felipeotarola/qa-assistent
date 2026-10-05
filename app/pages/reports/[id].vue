<script setup lang="ts">
import type { ReportDocument } from '#shared/mission-report';
definePageMeta({ layout: false });
const route = useRoute(), workspaceId = String(route.query.workspace ?? ''), reportId = String(route.params.id);
const { data, error } = await useFetch<{ document: ReportDocument | null; stale: boolean }>(`/api/workspaces/${workspaceId}/reports/${reportId}`);
const assets = computed(() => data.value?.document?.evidence.flatMap(e => e.itemId && e.kind === 'image' ? [{ id: e.id, url: `/api/workspaces/${workspaceId}/reports/${reportId}/asset?evidenceId=${encodeURIComponent(e.id)}` }] : []));
useHead({ title: 'Rapport', meta: [{ name: 'robots', content: 'noindex, nofollow' }, { name: 'referrer', content: 'no-referrer' }] });
function print() { window.print(); }
</script>
<template><main class="@container mx-auto max-w-5xl space-y-6 p-5 sm:p-10"><div class="print:hidden"><UButton label="Skriv ut eller spara PDF" icon="i-lucide-printer" @click="print" /></div><p v-if="error" role="alert">Rapporten är inte tillgänglig.</p><p v-if="data?.stale">Nya resultat har tillkommit. Detta är den sparade rapportversionen.</p><MissionReportDocument v-if="data?.document" :document="data.document" :assets="assets" /></main></template>
