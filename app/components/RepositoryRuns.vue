<script setup lang="ts">
import { repoTerminal } from '#shared/repository';
const emit = defineEmits<{ saved: [] }>();
const { data, refresh, activeId } = useRepositoryRuns();
const history = ref(false);
const runs = computed(() => history.value ? data.value?.runs : data.value?.runs.filter((run, index) => index === 0 || !run.job || !repoTerminal(run.job.status)));
let timer: ReturnType<typeof setInterval> | undefined;
let polling = false;
onMounted(() => { timer = setInterval(async () => {
  if (!activeId.value || polling || document.hidden) return;
  polling = true;
  try { await refresh(); } finally { polling = false; }
}, 4000); });
onBeforeUnmount(() => clearInterval(timer));
</script>
<template>
  <section v-if="data?.runs.length" class="mb-6 space-y-3" aria-label="Körningar på VPS">
    <div class="flex items-center justify-between gap-3"><h2 class="font-semibold">Körningar på VPS</h2><UButton v-if="data.runs.length > 1" :label="history ? 'Visa senaste' : `Historik (${data.runs.length})`" variant="ghost" @click="history = !history" /></div>
    <p v-if="data.syncError" role="status" class="text-sm text-warning">{{ data.syncError }}</p>
    <RepositoryRunCard v-for="run in runs" :key="run.id" :run="run" @changed="refresh()" @saved="emit('saved')" />
  </section>
</template>
