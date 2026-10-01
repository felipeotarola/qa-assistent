<script setup lang="ts">
const props = defineProps<{ workspaceId: string; jobs: { id: string; threadId: string; sessionId: string | null; task: string; status: string; report: string }[] }>();
const emit = defineEmits<{ refresh: [] }>();
const error = ref('');
const stopping = ref('');
async function stop(id: string) {
  stopping.value = id; error.value = '';
  try {
    const job = await $fetch(`/api/workspaces/${props.workspaceId}/browser-jobs`, { method: 'POST', body: { jobId: id } });
    if (job.status === 'dispatch_unknown') error.value = 'Stopp kunde inte bekräftas. Försök igen med samma uppdrag.';
    emit('refresh');
  }
  catch { error.value = 'Stopp kunde inte bekräftas. Kontrollera status innan du försöker igen.'; }
  finally { stopping.value = ''; }
}
const labels: Record<string, string> = { starting: 'Startar', running: 'Arbetar', completed: 'Avslutat', failed: 'Fel', cancelled: 'Stoppat', dispatch_unknown: 'Start behöver kontrolleras' };
</script>
<template>
  <section v-if="jobs.length" class="space-y-3" aria-label="Iris webbläsaruppdrag">
    <article v-for="job in jobs" :key="job.id" class="rounded-xl border border-default p-3 space-y-3">
      <div class="flex items-center gap-2"><UIcon name="i-lucide-scan-eye" class="size-5" /><h3 class="flex-1 text-sm font-semibold">Iris · Webbtester</h3><UBadge color="neutral" variant="soft">{{ labels[job.status] || job.status }}</UBadge></div>
      <p class="line-clamp-3 break-words text-xs text-muted">{{ job.task }}</p>
      <AgentWorkerActivity v-if="job.sessionId && ['starting', 'running'].includes(job.status)" :thread-id="job.threadId" :session-id="job.sessionId" name="Iris" />
      <details v-if="job.report"><summary class="cursor-pointer text-sm">Visa rapport</summary><div class="mt-3 max-h-96 overflow-auto break-words"><ChatComark :value="job.report" /></div></details>
      <UButton v-if="['starting', 'running', 'dispatch_unknown'].includes(job.status)" label="Stoppa Iris" icon="i-lucide-square" color="neutral" variant="outline" size="sm" :loading="stopping === job.id" @click="stop(job.id)" />
      <p class="text-xs text-muted">Körningsstatus är inte ett testgodkännande. Sparade testresultat finns under Testning.</p>
    </article>
    <p v-if="error" role="alert" class="text-xs text-error">{{ error }}</p>
  </section>
</template>
