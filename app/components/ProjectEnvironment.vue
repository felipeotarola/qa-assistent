<script setup lang="ts">
import type { SetupView } from '#shared/project-environment';
const props = defineProps<{ workspaceId: string; job: SetupView }>();
const vault = useWorkspaceVault();
const plan = computed(() => props.job.result?.environment);
const busy = ref(false), error = ref(''), info = ref('');
async function retry() {
  busy.value = true; error.value = '';
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/setup-jobs/${props.job.id}/resume`, { method: 'POST', body: { revision: props.job.revision } });
    info.value = 'Fortsättningen har skickats med samma begäran.';
  } catch (cause) { error.value = (cause as { data?: { statusMessage?: string } }).data?.statusMessage || 'Fortsättningen kunde inte bekräftas.'; }
  finally { busy.value = false; }
}
</script>
<template>
  <article v-if="plan" class="space-y-2 rounded-xl border border-default p-3">
    <p class="text-sm font-semibold">{{ job.status === 'needs_configuration' ? 'Lägg till nycklar i Vault' : job.status === 'configuring' ? 'Kontrollerar appstart' : job.status === 'completed' ? 'Appstart kontrollerad' : 'Appstart behöver undersökas' }}</p>
    <p class="break-words text-xs text-muted">{{ plan.repoUrl.split('/').slice(-2).join('/') }} · Testmiljö · HTTP {{ plan.httpStatus ?? 'ej verifierat' }}</p>
    <p v-if="job.status === 'needs_configuration'" class="break-words text-xs">Saknas för uppgiften: {{ plan.variables.filter(v => v.required && !job.configuredNames.includes(v.name)).map(v => v.name).join(', ') || 'sparad konfiguration behöver tillämpas' }}.</p>
    <UButton label="Öppna Vault" icon="i-lucide-key-round" size="sm" @click="vault.open(workspaceId, job.id)" />
    <UButton v-if="['needs_configuration', 'failed'].includes(job.status) && job.revision > 0" label="Försök fortsätta igen" variant="ghost" size="sm" :loading="busy" @click="retry" />
    <p v-if="['unknown', 'failed', 'session_changed'].includes(job.notification)" class="text-xs text-warning">Återkopplingen till chatten kunde inte bekräftas. Resultatet finns kvar här; inget test körs om automatiskt.</p>
    <p v-if="info" role="status" class="text-xs">{{ info }}</p>
    <p v-if="error" role="alert" class="text-xs text-error">{{ error }}</p>
  </article>
</template>
