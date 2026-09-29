<script setup lang="ts">
import WorkspaceRunSummary from './WorkspaceRunSummary.vue';
import WorkspaceRunStatus from './WorkspaceRunStatus.vue';
import WorkspaceRunHistory from './WorkspaceRunHistory.vue';
import WorkspaceTestRequirements from './WorkspaceTestRequirements.vue';
import type { TableColumn, TableRow } from '@nuxt/ui';
import type { TestPlan, TestCase } from '#shared/test-plan';
import { caseReady } from '#shared/test-plan';
const props = defineProps<{ plan: TestPlan; preview?: boolean; item?: import("#shared/workspace").WorkspaceItem }>();
const selectedId = ref<string>();
const open = ref(false);
const query = ref('');
const filter = ref('all');
const selected = computed(() => props.plan.cases.find(test => test.id === selectedId.value));
const complete = computed(() => props.plan.cases.filter(caseReady).length);
const types = { browser: 'Webbläsare', api: 'API', manual: 'Manuellt' };
const icons = { browser: 'i-lucide-globe', api: 'i-lucide-braces', manual: 'i-lucide-hand' };
const filtered = computed(() => props.plan.cases.filter(test =>
  (filter.value === 'all' || (filter.value === 'incomplete' ? !caseReady(test) : test.type === filter.value))
  && `${test.title} ${test.id}`.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())));
const columns: TableColumn<TestCase>[] = [
  { accessorKey: 'title', header: 'Testfall' },
  { id: 'result', header: 'Resultat & körningar' },
];
function show(test: TestCase) { selectedId.value = test.id; open.value = true; }
function select(_event: Event, row: TableRow<TestCase>) { show(row.original); }
watch(selected, value => { if (!value) open.value = false; });
</script>
<template>
  <div class="space-y-6">
    <template v-if="preview">
      <UBadge color="neutral" variant="soft">{{ plan.cases.length }} testfall</UBadge>
      <p v-if="plan.summary" class="line-clamp-2 text-muted">{{ plan.summary }}</p>
      <p class="text-muted">{{ complete }} färdigbeskrivna · {{ plan.sources.length }} underlag</p>
    </template>
    <template v-else>
      <WorkspaceRunSummary v-if="item" :item="item" />
      <section aria-label="Planöversikt" class="rounded-xl border border-default bg-muted/40 p-5">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div><p class="text-xs font-medium uppercase tracking-wider text-muted">Planöversikt</p><h4 class="mt-2 text-xl font-semibold text-highlighted">{{ plan.cases.length ? 'Vad ska vi verifiera?' : 'Börja med ert första testfall' }}</h4><p class="mt-2 text-sm text-muted">{{ plan.cases.length ? 'Öppna ett testfall för att se förutsättningar, steg och förväntat resultat.' : 'Välj Redigera eller be agenten skapa testfall från ert underlag.' }}</p></div>
          <UBadge :color="complete < plan.cases.length ? 'warning' : 'info'" variant="soft">{{ complete < plan.cases.length ? 'Behöver kompletteras' : plan.cases.length ? 'Testfallen är beskrivna' : 'Utkast' }}</UBadge>
        </div>
        <div class="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div class="rounded-lg border border-default bg-default p-3"><UIcon name="i-lucide-list-checks" class="size-4 text-muted" /><p class="mt-2 text-2xl font-semibold">{{ plan.cases.length }}</p><p class="text-xs text-muted">Testfall i planen</p></div>
          <div class="rounded-lg border border-default bg-default p-3"><UIcon name="i-lucide-file-check-2" class="size-4 text-info" /><p class="mt-2 text-2xl font-semibold">{{ complete }}</p><p class="text-xs text-muted">Färdigbeskrivna</p></div>
          <div class="rounded-lg border border-default bg-default p-3"><UIcon name="i-lucide-pencil-line" class="size-4 text-warning" /><p class="mt-2 text-2xl font-semibold">{{ plan.cases.length - complete }}</p><p class="text-xs text-muted">Behöver kompletteras</p></div>
          <div class="rounded-lg border border-default bg-default p-3"><UIcon name="i-lucide-link" class="size-4 text-muted" /><p class="mt-2 text-2xl font-semibold">{{ plan.sources.length }}</p><p class="text-xs text-muted">Kopplade underlag</p></div>
        </div>
      </section>
      <UCollapsible v-if="plan.summary" class="rounded-xl border border-default">
        <UButton label="Syfte & anteckningar" icon="i-lucide-align-left" trailing-icon="i-lucide-chevron-down" color="neutral" variant="ghost" class="w-full justify-between p-4" />
        <template #content><p class="whitespace-pre-wrap break-words px-4 pb-4 text-sm leading-relaxed text-muted">{{ plan.summary }}</p></template>
      </UCollapsible>
      <section class="space-y-4" aria-label="Testfall i planen">
        <div class="flex flex-wrap items-center justify-between gap-3"><h4 class="text-base font-semibold">Testfall <span class="ml-2 text-sm font-normal text-muted">{{ filtered.length }} av {{ plan.cases.length }}</span></h4><div class="flex flex-wrap gap-2"><UInput v-model="query" icon="i-lucide-search" placeholder="Sök testfall…" aria-label="Sök testfall" /><USelect v-model="filter" aria-label="Filtrera testfall" :items="[{label:'Alla testfall',value:'all'},{label:'Behöver kompletteras',value:'incomplete'},{label:'Webbläsare',value:'browser'},{label:'API',value:'api'},{label:'Manuellt',value:'manual'}]" class="min-w-40" /></div></div>
        <UTable :data="filtered" :columns="columns" :get-row-id="row => row.id" class="test-case-table rounded-xl border border-default" :ui="{ base: 'w-full table-fixed', th: 'whitespace-normal', td: 'whitespace-normal align-top' }" empty="Inga testfall att visa. Ändra filtret eller lägg till ett testfall." @select="select">
          <template #title-cell="{ row }"><div class="min-w-0 space-y-2 py-1"><p class="font-mono text-[10px] text-dimmed">{{ row.original.id.slice(0,8).toUpperCase() }}</p><UButton :label="row.original.title || 'Namnlöst test'" color="neutral" variant="link" class="max-w-full whitespace-normal break-words p-0 text-left font-medium" @click.stop="show(row.original)" /><div class="flex flex-wrap items-center gap-2"><span class="flex items-center gap-1 text-xs text-muted"><UIcon :name="icons[row.original.type]" class="size-3.5 shrink-0" />{{ types[row.original.type] }}</span><UBadge :color="caseReady(row.original) ? 'info' : 'warning'" variant="subtle">{{ caseReady(row.original) ? 'Beskrivet' : 'Komplettera' }}</UBadge></div></div></template>
          <template #result-cell="{ row }"><WorkspaceRunStatus v-if="item" :item="item" :case-id="row.original.id" show-count /><span v-else class="text-xs text-muted">Spara planen för att följa körningar.</span></template>
        </UTable>
        <div class="flex items-start gap-3 rounded-lg bg-muted/50 p-3 text-xs leading-relaxed text-muted"><UIcon name="i-lucide-info" class="mt-0.5 size-4 shrink-0" /><p>Beskrivet betyder att namn, steg och förväntat resultat finns. Det är inte ett godkänt testresultat. Eventuella observationer i anteckningarna är inte strukturerade körningsresultat.</p></div>
      </section>
      <UModal v-model:open="open" :title="selected?.title || 'Testfall'" description="Testfallets definition och förväntningar.">
        <template #body><div v-if="selected" class="space-y-5">
          <WorkspaceTestRequirements v-if="item" :key="selected.id" :item="item" :case-id="selected.id" @open-material="open = false" />
          <WorkspaceRunHistory v-if="item" :key="`run:${selected.id}`" :item="item" :case-id="selected.id" />
          <div class="flex flex-wrap items-center gap-2"><UBadge color="neutral" variant="soft" :icon="icons[selected.type]">{{ types[selected.type] }}</UBadge><UBadge :color="caseReady(selected) ? 'info' : 'warning'" variant="soft">{{ caseReady(selected) ? 'Beskrivet' : 'Komplettera' }}</UBadge><span class="font-mono text-xs text-muted">{{ selected.id.slice(0,8).toUpperCase() }}</span></div>
          <section class="rounded-xl border border-default p-4"><h4 class="mb-2 flex items-center gap-2 font-semibold"><UIcon name="i-lucide-key-round" class="size-4 text-muted" /> Förutsättningar</h4><p class="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted">{{ selected.preconditions || 'Ej angivna — kontrollera vad som behövs före körning.' }}</p></section>
          <section class="rounded-xl border border-default p-4"><h4 class="mb-2 flex items-center gap-2 font-semibold"><UIcon name="i-lucide-list-ordered" class="size-4 text-muted" /> Teststeg</h4><p class="whitespace-pre-wrap break-words text-sm leading-loose">{{ selected.steps || 'Steg behöver läggas till.' }}</p></section>
          <section class="rounded-xl border border-info/20 bg-info/5 p-4"><h4 class="mb-2 flex items-center gap-2 font-semibold"><UIcon name="i-lucide-target" class="size-4 text-info" /> Förväntat resultat</h4><p class="whitespace-pre-wrap break-words text-sm leading-relaxed">{{ selected.expected || 'Förväntat resultat behöver anges.' }}</p></section>
        </div></template>
      </UModal>
    </template>
  </div>
</template>
<style scoped>
.test-case-table :deep(th:first-child) { width: 58%; }
.test-case-table :deep(th:last-child) { width: 42%; }
</style>

