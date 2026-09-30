<script setup lang="ts">
import { repoStatusLabels, repoTerminal, type RepositoryAction } from '#shared/repository';
const url = ref(''); const branch = ref(''); const script = ref('test'); const busy = ref(false); const message = ref('');
const { data, refresh, error, endpoint } = useRepositoryRuns();
async function act(input: RepositoryAction) {
  busy.value = true; message.value = '';
  try { await $fetch(endpoint.value, { method: 'POST', body: input }); await refresh(); }
  catch (error: unknown) { message.value = (error as { data?: { statusMessage?: string } }).data?.statusMessage || 'Kunde inte genomföra åtgärden.'; await refresh(); }
  finally { busy.value = false; }
}
function start(repositoryId: string, mode: 'inspect' | 'test') { return act({ action: 'start', repositoryId, requestId: crypto.randomUUID(), mode }); }
let timer: ReturnType<typeof setInterval> | undefined;
let polling = false;
onMounted(() => { timer = setInterval(async () => {
  if (polling || !data.value?.runs.some(run => !run.job || !repoTerminal(run.job.status))) return;
  polling = true; try { await refresh(); } finally { polling = false; }
}, 4000); });
onBeforeUnmount(() => clearInterval(timer));
</script>
<template>
  <section class="qaa-panel space-y-4 border border-default p-5" aria-label="Repositorytester">
    <div><h3 class="text-lg font-semibold">Testa ett repository</h3><p class="mt-1 text-sm text-muted">Koppla en publik GitHub-URL. Piloten kör npm- och pnpm-projekt i en separat testmiljö.</p></div>
    <form class="grid gap-3 sm:grid-cols-2" @submit.prevent="act({ action: 'connect', url, ref: branch, script })">
      <UFormField label="Repository-URL" class="sm:col-span-2"><UInput v-model="url" type="url" required placeholder="https://github.com/team/projekt" class="w-full" /></UFormField>
      <UFormField label="Branch eller tagg" help="Tomt använder standardbranchen"><UInput v-model="branch" class="w-full" /></UFormField>
      <UFormField label="Script" help="Exempel: test eller test:unit"><UInput v-model="script" required class="w-full" /></UFormField>
      <div><UButton type="submit" label="Koppla repository" icon="i-lucide-git-branch" :loading="busy" /></div>
    </form>
    <p v-if="message || error" role="alert" class="text-sm text-error">{{ message || 'Kunde inte hämta repositories.' }}</p>
    <p v-if="data && !data.available" class="text-sm text-warning">Testservern behöver anslutas innan du kan starta en körning. Repository kan sparas nu.</p>
    <p v-if="data?.syncError" role="status" class="text-sm text-warning">{{ data.syncError }}</p>
    <div v-for="repo in data?.repositories" :key="repo.id" class="rounded-lg border border-default p-3">
      <a :href="repo.url" target="_blank" rel="noopener noreferrer" class="break-all font-medium">{{ repo.url }}</a>
      <p class="mt-1 text-xs text-muted">{{ repo.ref || 'Standardbranch' }} · script: {{ repo.script }}</p>
      <div class="mt-3 flex flex-wrap gap-2">
        <UButton label="Analysera" color="neutral" variant="outline" :disabled="busy || !data?.available" @click="start(repo.id, 'inspect')" />
        <UButton label="Kör tester" icon="i-lucide-play" :disabled="busy || !data?.available" @click="start(repo.id, 'test')" />
      </div>
    </div>
    <p class="text-xs text-muted">Publika GitHub-repon körs i en isolerad miljö på VPS:en. Privata repos och installationsscript stöds ännu inte.</p>
    <div v-for="run in data?.runs" :key="run.id" class="space-y-3 rounded-lg border border-default p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <UBadge :color="run.job?.status === 'passed' ? 'success' : run.job?.status === 'failed' ? 'error' : run.job?.status === 'blocked' ? 'warning' : 'neutral'">{{ run.job ? repoStatusLabels[run.job.status] : 'Väntar på testserver' }}</UBadge>
        <UButton v-if="run.job && !repoTerminal(run.job.status)" label="Stoppa" color="neutral" variant="outline" :disabled="busy" @click="act({ action: 'cancel', runId: run.id })" />
      </div>
      <p class="text-sm">{{ run.job?.message || 'Status kunde inte hämtas. Kontrollera anslutningen till testservern.' }}</p>
      <p v-if="run.job?.commit" class="break-all font-mono text-xs text-muted">Commit: {{ run.job.commit }}</p>
      <p class="break-all text-xs text-muted">Körning: {{ run.id }}</p>
      <details v-if="run.job?.package"><summary class="cursor-pointer text-sm">Projekt och tillgängliga script</summary><p class="mt-2 text-sm">{{ run.job.package.name }}</p><ul class="mt-2 space-y-1"><li v-for="(command, name) in run.job.package.scripts" :key="name" class="break-all font-mono text-xs">{{ name }}: {{ command }}</li></ul></details>
      <details v-if="run.job?.logs"><summary class="cursor-pointer text-sm">Visa körlogg</summary><pre class="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{{ run.job.logs }}</pre></details>
    </div>
  </section>
</template>
