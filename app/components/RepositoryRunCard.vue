<script setup lang="ts">
import { repoStatusLabels, repoTerminal, type RepositoryRun, type RepoJob } from '#shared/repository';
const props = defineProps<{ run: RepositoryRun }>();
const emit = defineEmits<{ changed: []; saved: [] }>();
const { activeId } = useWorkspaces();
const busy = ref(false);
const error = ref('');
const saved = ref(false);
const liveJobs = useState<Record<string, RepoJob>>('execution-jobs', () => ({}));
const connected = useState<Record<string, boolean>>('execution-connected', () => ({}));
const detail = shallowRef<RepoJob | null>(null);
const job = computed(() => [props.run.job, liveJobs.value[props.run.id], detail.value].filter((value): value is RepoJob => !!value).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.logs.length - a.logs.length)[0] ?? null);
async function loadLog(event: Event) {
  if (!(event.target as HTMLDetailsElement).open || job.value?.logs) return;
  try { detail.value = (await $fetch<RepositoryRun>(`/api/workspaces/${activeId.value}/repository-runs/${props.run.id}`)).job; }
  catch { error.value = 'Kunde inte läsa körloggen.'; }
}
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
      <p v-if="job?.telemetry?.queuePosition && job.status === 'queued'" class="text-xs text-muted">Köplats {{ job.telemetry.queuePosition }}</p>
      <details v-if="job?.plan"><summary class="cursor-pointer text-sm">Körningsplan · {{ job.plan.runtime }}</summary><dl class="mt-2 space-y-2 text-xs"><div><dt class="text-muted">Arbetskatalog</dt><dd class="font-mono">{{ job.plan.directory }}</dd></div><div><dt class="text-muted">Installation och kommando</dt><dd class="whitespace-pre-wrap break-all font-mono">{{ [...job.plan.install, job.plan.command].map(command => command.join(' ')).join('\n') }}</dd></div></dl></details>
      <p v-if="job?.commit" class="break-all font-mono text-xs text-muted">{{ job.commit }} · {{ job.selectedScript || job.script }} {{ job.args?.join(' ') }} · exit {{ job.testExitCode ?? '—' }}</p>
      <p v-if="job?.telemetry" class="text-xs text-muted">{{ job.telemetry.workerId }} · {{ job.telemetry.operationKind === 'static-check' ? 'Statisk kontroll' : job.telemetry.operationKind === 'inspect' ? 'Projektanalys' : 'Körning' }}<span v-if="job.telemetry.cancellationRequested"> · Stoppar…</span></p>
      <details :open="active" @toggle="loadLog"><summary class="cursor-pointer text-sm">Körlogg</summary><pre class="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-muted p-4 font-mono text-xs">{{ job?.logs || 'Ingen utdata ännu.' }}</pre><p class="mt-2 text-xs text-muted">{{ connected.repository ? 'Live från VPS' : active ? 'Återansluter · senast hämtade status' : 'Sparat resultat' }} · Visar de senaste 64 000 tecknen.</p></details>
      <div class="flex flex-wrap gap-2"><UButton v-if="active" label="Stoppa" icon="i-lucide-square" variant="outline" :loading="busy" @click="stop" /><UButton v-else :label="saved ? 'Sparat i Material' : 'Spara rapport i Material'" icon="i-lucide-file-plus" variant="outline" :disabled="saved" :loading="busy" @click="save" /></div>
      <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
    </div>
  </article>
</template>
