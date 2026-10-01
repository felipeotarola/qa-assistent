<script setup lang="ts">
import { agentIdentities } from '#shared/agent-identities';
import AgentAvatar from './AgentAvatar.vue';
import { assessmentLabels } from '#shared/result-assessment';
const props = defineProps<{ workspaceId: string; runId: string; requirements: { id: string; requirement: string }[] }>();
const { data, refresh, error: loadError } = useResultAssessments(false);
const requestFetch = useRequestFetch();
const detail = useAsyncData(() => `result-assessment-${props.workspaceId}-${props.runId}`, () => requestFetch<{ assessments: import('#shared/result-assessment').AssessmentView[] }>(`/api/workspaces/${props.workspaceId}/assessments`, { query: { runId: props.runId } }));
const current = computed(() => data.value?.workspaceId === props.workspaceId && data.value.assessments.some(a => a.runId === props.runId) ? data.value.assessments.find(a => a.runId === props.runId) : detail.data.value?.assessments[0]);
const busy = ref(false); const error = ref('');
async function request() {
  busy.value = true; error.value = '';
  try { await $fetch(`/api/workspaces/${props.workspaceId}/assessments`, { method: 'POST', body: { runId: props.runId } }); await Promise.all([refresh(), detail.refresh()]); }
  catch { error.value = 'Granskningen kunde inte beställas. Kontrollera status innan du försöker igen.'; }
  finally { busy.value = false; }
}
</script>
<template>
  <section class="space-y-2 rounded-lg border border-default bg-default p-3" aria-label="Resultatgranskarens bedömning">
    <p class="flex items-center gap-2 text-sm font-semibold"><AgentAvatar role="reviewer" class="size-9" />{{ agentIdentities.reviewer.name }} · Resultatgranskning</p>
    <p class="text-xs text-muted">Separat granskning av underlaget. Originalresultatet ändras inte.</p>
    <p v-if="loadError || detail.error.value || error" role="alert" class="text-sm text-error">{{ error || 'Granskningsstatus kunde inte hämtas.' }}</p>
    <template v-if="current">
      <p v-if="current.stale" class="text-sm text-warning">Underlaget har ändrats eller tagits bort sedan denna granskning beställdes.</p>
      <p v-if="['queued', 'running'].includes(current.status)" role="status" class="text-sm">{{ current.status === 'running' ? 'Granskar resultat…' : 'Granskning köad' }}</p>
      <p v-else-if="current.status === 'failed'" class="text-sm text-warning">{{ current.error }}</p>
      <template v-else-if="current.assessment">
        <UBadge :color="current.assessment.verdict === 'supported' ? 'success' : 'warning'" variant="subtle">{{ assessmentLabels[current.assessment.verdict] }}</UBadge>
        <p class="text-sm">{{ current.assessment.summary }}</p>
        <UCollapsible><UButton label="Visa bedömning per kontrollpunkt" variant="link" color="neutral" /><template #content>
          <ul class="space-y-3 pt-2 text-sm"><li v-for="finding in current.assessment.findings" :key="finding.requirementId" class="border-t border-default pt-2">
            <p class="font-medium">{{ props.requirements.find(r => r.id === finding.requirementId)?.requirement || finding.requirementId }}</p>
            <p class="text-xs text-muted">{{ assessmentLabels[finding.verdict] }}</p>
            <p>{{ finding.explanation }}</p>
            <p v-if="finding.suggestedNextStep" class="mt-1"><strong>Nästa steg:</strong> {{ finding.suggestedNextStep }}</p>
            <div v-if="finding.evidenceIds.length" class="mt-1 flex flex-wrap gap-1">
              <template v-for="id in finding.evidenceIds" :key="id">
                <UButton v-if="current.evidence.find(e => e.id === id)?.itemId" :to="`/api/workspaces/${workspaceId}/items/${current.evidence.find(e => e.id === id)!.itemId}/file`" target="_blank" color="neutral" variant="link" size="xs" icon="i-lucide-paperclip" :label="current.evidence.find(e => e.id === id)?.title || 'Visa underlag'" />
                <span v-else class="text-xs text-muted">{{ current.evidence.find(e => e.id === id)?.title || 'Sparad observation' }}</span>
              </template>
            </div>
          </li></ul>
          <p class="mt-2 text-xs text-muted">{{ current.model === 'deterministic-rules' ? 'Kodregler · ingen modellbedömning' : current.model }} · granskare v{{ current.reviewerVersion }} · {{ current.finishedAt ? new Date(current.finishedAt).toLocaleString('sv-SE') : '' }}</p>
        </template></UCollapsible>
      </template>
    </template>
    <UButton v-if="!current || current.stale || current.status === 'failed'" :label="current?.status === 'failed' && !current.stale ? 'Försök granska igen' : current ? 'Granska aktuellt underlag' : 'Granska resultat'" icon="i-lucide-scan-eye" variant="soft" :loading="busy" @click="request" />
  </section>
</template>
