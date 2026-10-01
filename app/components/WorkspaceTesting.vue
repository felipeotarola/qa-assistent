<script setup lang="ts">
import WorkspaceRunSummary from './WorkspaceRunSummary.vue';
import type { WorkspaceItem } from '#shared/workspace';
import { caseReady } from '#shared/test-plan';
const props = defineProps<{ workspaceId: string; items: WorkspaceItem[] }>();
defineEmits<{ open: [item: WorkspaceItem] }>();
const query = ref('');
const plans = computed(() => props.items.filter(item => item.content.kind === 'test_plan').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
const filtered = computed(() => plans.value.filter(item => item.title.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())));
const cases = computed(() => plans.value.flatMap(item => item.content.kind === 'test_plan' ? item.content.cases : []));
</script>
<template>
  <section aria-label="Testplansbibliotek" class="space-y-6">
    <WorkspacePageHeader title="Era testplaner" description="Från krav och testidéer till tydliga testfall." />
    <WorkspaceQuality :key="workspaceId" :workspace-id="workspaceId" :items="items" @open="$emit('open', $event)" />
    <div class="qaa-metric-strip"><div><p>{{ plans.length }}</p><p class="text-xs text-muted">Testplaner</p></div><div><p>{{ cases.length }}</p><p class="text-xs text-muted">Testfall</p></div><div><p :class="cases.some(c => !caseReady(c)) ? 'text-warning' : ''">{{ cases.filter(c => !caseReady(c)).length }}</p><p class="text-xs text-muted">Behöver beskrivas</p></div></div>
    <UInput v-model="query" icon="i-lucide-search" placeholder="Hitta en testplan…" aria-label="Sök testplaner" class="w-full sm:max-w-sm" />
    <div class="space-y-3">
      <div v-for="item in filtered" :key="item.id" class="qaa-panel border border-default p-5">
        <template v-if="item.content.kind === 'test_plan'">
          <div class="flex flex-wrap items-start justify-between gap-3"><div class="min-w-0 flex-1"><p class="mb-2 text-xs text-muted">TESTPLAN · VERSION {{ item.version }}</p><h3 class="break-words text-base font-semibold">{{ item.title }}</h3></div><UButton label="Öppna plan" trailing-icon="i-lucide-arrow-right" color="neutral" :aria-label="`Öppna testplan: ${item.title}`" @click="$emit('open', item)" /></div>
          <WorkspaceRunSummary :item="item" compact /><div class="mt-4 flex flex-wrap gap-2"><UBadge color="neutral" variant="soft">{{ item.content.cases.length }} testfall</UBadge><UBadge color="neutral" variant="outline">{{ item.content.sources.length }} underlag</UBadge><UBadge v-if="item.content.cases.some(c => !caseReady(c))" color="warning" variant="soft">Behöver kompletteras</UBadge><UBadge v-else color="info" variant="soft">{{ item.content.cases.length ? 'Testfallen är beskrivna' : 'Utkast' }}</UBadge></div>
        </template>
      </div>
      <p v-if="!filtered.length && plans.length" role="status" class="p-6 text-center text-sm text-muted">Ingen testplan matchar sökningen.</p>
    </div>
  </section>
</template>
