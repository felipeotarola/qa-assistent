<script setup lang="ts">
import { repoStatusLabels, repoTerminal } from '#shared/repository';
const { data } = useRepositoryRuns();
const running = computed(() => data.value?.runs.filter(run => !run.job || !repoTerminal(run.job.status)) ?? []);
</script>
<template>
  <div v-if="running.length" class="mb-4 space-y-2 rounded-lg border border-default p-3" role="status">
    <p class="font-semibold">Repositorykörningar</p>
    <p v-for="run in running" :key="run.id" class="text-sm"><UIcon name="i-lucide-loader-circle" class="mr-2 motion-safe:animate-spin" />{{ run.job ? repoStatusLabels[run.job.status] : 'Väntar på testserver' }} · {{ run.job?.url.split('/').at(-1) }}</p>
    <p class="text-xs text-muted">Loggar, stoppknapp och sparade resultat finns i workspace under Körningar på VPS.</p>
  </div>
</template>
