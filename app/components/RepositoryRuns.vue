<script setup lang="ts">
import { repoTerminal } from '#shared/repository';
const emit = defineEmits<{ saved: [] }>();
const { data, refresh } = useRepositoryRuns();
const history = ref(false);
const minimized = ref(false);
const latestId = computed(() => data.value?.runs[0]?.id);
const working = computed(() => data.value?.runs.some(run => !run.job || !repoTerminal(run.job.status)));
watch(latestId, (id, previous) => { if (id && id !== previous) minimized.value = false; });
const runs = computed(() => history.value ? data.value?.runs : data.value?.runs.filter((run, index) => index === 0 || !run.job || !repoTerminal(run.job.status)));
</script>
<template>

    <section v-if="data?.runs.length" class="min-w-0 overflow-hidden rounded-xl border border-default bg-default" aria-label="Körningar på VPS" @keydown.esc="minimized = true">
      <header class="flex items-center gap-2 px-3 py-2">
        <UIcon :name="working ? 'i-lucide-loader-circle' : 'i-lucide-terminal'" class="size-4 shrink-0" :class="{ 'motion-safe:animate-spin': working }" />
        <div class="min-w-0 flex-1"><h2 class="text-sm font-semibold">{{ working ? 'Arbetar på VPS' : 'VPS-körningar' }}</h2><p class="truncate text-xs text-muted">{{ data.runs[0]?.job?.url.split('/').slice(-2).join('/') }}</p></div>
        <UButton :icon="minimized ? 'i-lucide-chevron-up' : 'i-lucide-minus'" :aria-label="minimized ? 'Visa VPS-körningar' : 'Minimera VPS-körningar'" :aria-expanded="!minimized" color="neutral" variant="ghost" size="xs" @click="minimized = !minimized" />
      </header>
      <div v-show="!minimized" class="space-y-3 border-t border-default p-3">
        <UButton v-if="data.runs.length > 1" :label="history ? 'Visa senaste' : `Historik (${data.runs.length})`" variant="ghost" size="sm" @click="history = !history" />
        <p v-if="data.syncError" role="status" class="text-sm text-warning">{{ data.syncError }}</p>
        <RepositoryRunCard v-for="run in runs" :key="run.id" :run="run" @changed="refresh()" @saved="emit('saved')" />
      </div>
    </section>

</template>
