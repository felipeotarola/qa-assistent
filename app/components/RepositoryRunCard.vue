<script setup lang="ts">
import { repoStatusLabels, repoTerminal, type RepositoryRun } from '#shared/repository';
const props = defineProps<{ run: RepositoryRun }>();
const emit = defineEmits<{ changed: []; saved: [] }>();
const { activeId } = useWorkspaces();
const busy = ref(false);
const error = ref('');
const saved = ref(false);
const job = computed(() => props.run.job);
const active = computed(() => !job.value || !repoTerminal(job.value.status));
const phases = ['queued', 'preparing', 'installing', 'running', 'cleaning'] as const;
async function stop() {
  busy.value = true; error.value = '';
  try { await $fetch(`/api/workspaces/${activeId.value}/repositories`, { method: 'POST', body: { action: 'cancel', runId: props.run.id } }); emit('changed'); }
  catch { error.value = 'Kunde inte stoppa körningen. Försök igen.'; }
  finally { busy.value = false; }
}
async function save() {
  if (!job.value || active.value) return;
  busy.value = true; error.value = '';
  try {
    await $fetch(`/api/workspaces/${activeId.value}/repository-material`, { method: 'POST', body: { runId: props.run.id } }); saved.value = true; emit('saved');
  } catch (cause: unknown) { error.value = (cause as { data?: { statusMessage?: string } }).data?.statusMessage || 'Kunde inte spara rapporten i Material.'; }
  finally { busy.value = false; }
}
</script>

<template>
  <article class="qaa-panel overflow-hidden border border-default" aria-label="VPS-körning">
    <header class="flex flex-wrap items-center justify-between gap-3 p-4">
      <div class="flex min-w-0 items-center gap-3">
        <UIcon :name="active ? 'i-lucide-loader-circle' : 'i-lucide-terminal'" class="size-5 shrink-0" :class="{ 'motion-safe:animate-spin': active }" />
        <div class="min-w-0"><h3 class="truncate font-semibold">{{ job?.url.split('/').slice(-2).join('/') || 'Repositorykörning' }}</h3><p class="text-xs text-muted">Isolerad miljö på VPS · {{ run.id.slice(0, 8) }}</p></div>
      </div>
      <UBadge :color="job?.status === 'failed' ? 'error' : job?.status === 'blocked' ? 'warning' : 'neutral'">{{ job ? repoStatusLabels[job.status] : 'Kontaktar testserver' }}</UBadge>
    </header>
    <div class="space-y-3 border-t border-default p-4">
      <ol v-if="active" aria-label="Körningssteg" class="flex flex-wrap gap-2 text-xs text-muted"><li v-for="phase in phases" :key="phase" :aria-current="job?.status === phase ? 'step' : undefined" :class="{ 'font-semibold text-highlighted': job?.status === phase }">{{ repoStatusLabels[phase] }}</li></ol>
      <p role="status" class="text-sm">{{ job?.message || 'Väntar på aktuell status från VPS:en.' }}</p>
      <p v-if="job?.commit" class="break-all font-mono text-xs text-muted">{{ job.commit }} · {{ job.script }} {{ job.args?.join(' ') }} · exit {{ job.testExitCode ?? '—' }}</p>
      <details :open="active"><summary class="cursor-pointer text-sm">Körlogg</summary><pre class="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-muted p-4 font-mono text-xs">{{ job?.logs || 'Ingen utdata ännu.' }}</pre><p class="mt-2 text-xs text-muted">Uppdateras var fjärde sekund. Visar de senaste 64 000 tecknen.</p></details>
      <div class="flex flex-wrap gap-2"><UButton v-if="active" label="Stoppa" icon="i-lucide-square" variant="outline" :loading="busy" @click="stop" /><UButton v-else :label="saved ? 'Sparat i Material' : 'Spara rapport i Material'" icon="i-lucide-file-plus" variant="outline" :disabled="saved" :loading="busy" @click="save" /></div>
      <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
    </div>
  </article>
</template>
