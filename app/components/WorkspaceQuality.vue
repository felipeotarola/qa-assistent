<script setup lang="ts">
import type { WorkspaceItem } from '#shared/workspace';
import type { TestRun } from '#shared/test-run';
import { defaultQuality, qualitySummary, qualityLabels, qualityConfigSchema, type QualitySettings, type QualityStatus } from '#shared/quality';
import { startChat } from '~/composables/chat/navigation';
const props = defineProps<{ workspaceId: string; items: WorkspaceItem[] }>();
const emit = defineEmits<{ open: [item: WorkspaceItem] }>();
const runs = inject<Ref<TestRun[]>>('workspace-test-runs', ref([]));
const settings = inject<Ref<QualitySettings>>('workspace-quality', ref(defaultQuality()));
const summary = computed(() => qualitySummary(props.items, runs.value, settings.value.config));
const agent = useWorkspaceAgent();
const busy = ref(false);
const error = ref('');
const notice = ref('');
const editing = ref(false);
const draft = ref(defaultQuality());
const expandedCheck = ref<string>();
const readinessOptions = [{ label: 'Inte kontrollerad', value: 'unknown' }, { label: 'Bekräftad', value: 'ready' }, { label: 'Blockerad', value: 'blocked' }];
const filter = ref('all');
const visibleCount = ref(8);
let disposed = false;
onBeforeUnmount(() => { disposed = true; });
const filters = computed(() => [{ label: `Alla (${summary.value.total})`, value: 'all' }, ...Object.entries(qualityLabels).map(([value, label]) => ({ label: `${label} (${summary.value.counts[value as QualityStatus]})`, value })), { label: 'Regressionsurval', value: 'regression' }]);
const filtered = computed(() => summary.value.cases.filter(c => filter.value === 'all' || (filter.value === 'regression' ? c.regression : c.status === filter.value)));
const disabled = computed(() => busy.value || (agent.value?.workspaceId === props.workspaceId && !agent.value.available));
const statusColor = (status: QualityStatus) => status === 'passed' ? 'success' as const : status === 'failed' ? 'error' as const : ['blocked', 'inconclusive', 'stale', 'interrupted'].includes(status) ? 'warning' as const : 'neutral' as const;
watch(filter, () => { visibleCount.value = 8; });
function edit() {
  draft.value = structuredClone(toRaw(settings.value));
  const keys = new Set(summary.value.cases.map(c => c.key));
  draft.value.config.regression = draft.value.config.regression.filter(key => keys.has(key));
  draft.value.config.checks = draft.value.config.checks.filter(check => !check.caseKeys.length || check.caseKeys.some(key => keys.has(key))).map(check => ({ ...check, caseKeys: check.caseKeys.filter(key => keys.has(key)) }));
  if (!draft.value.config.checks.length) draft.value.config.checks = ['Testmiljön svarar', 'Rätt version är tillgänglig', 'Testkonton och testdata', 'Nödvändiga tjänster och beroenden'].map(label => ({ id: crypto.randomUUID(), label, status: 'unknown', detail: '', caseKeys: [] }));
  expandedCheck.value = undefined;
  error.value = ''; editing.value = true;
}
function addCheck() {
  const id = crypto.randomUUID();
  draft.value.config.checks.push({ id, label: '', status: 'unknown', detail: '', caseKeys: [] });
  expandedCheck.value = id;
}
async function save(value: QualitySettings) {
  const validation = qualityConfigSchema.safeParse(value.config);
  if (!validation.success) { error.value = validation.error.issues[0]?.message || 'Kontrollera uppgifterna.'; return false; }
  busy.value = true; error.value = '';
  try {
    const saved = await $fetch<QualitySettings>(`/api/workspaces/${props.workspaceId}/quality`, { method: 'PUT', body: { expectedRevision: value.revision, config: validation.data } });
    if (!disposed) settings.value = saved;
    return true;
  } catch (err) {
    const conflict = (err as { statusCode?: number }).statusCode === 409;
    error.value = conflict ? 'Någon har uppdaterat testberedskapen. Stäng och öppna inställningarna igen.' : 'Kunde inte spara. Kontrollera uppgifterna och försök igen.';
    return false;
  } finally { busy.value = false; }
}
async function saveDraft() { if (await save(draft.value)) editing.value = false; }
async function toggleRegression(key: string) {
  const next = structuredClone(toRaw(settings.value));
  next.config.regression = next.config.regression.includes(key) ? next.config.regression.filter(k => k !== key) : [...next.config.regression, key];
  await save(next);
}
async function ask(task: string) {
  if (disabled.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  const prompt = `I detta workspace: läs quality och de aktuella testplanerna först. Vald testmiljö/version måste verifieras innan resultat kopplas till den. ${task}`;
  try {
    if (agent.value?.workspaceId === props.workspaceId) {
      if (!await agent.value.ask(prompt)) throw new Error('Not sent');
    } else await startChat(prompt);
    notice.value = 'Uppgiften är skickad till chatten.';
  } catch { error.value = 'Kunde inte skicka till chatten. Försök igen.'; }
  finally { busy.value = false; }
}
function runCases(regression = false) {
  const selected = summary.value.cases.filter(c => regression ? c.regression : c.readiness === 'ready' && ['untested', 'stale', 'failed', 'inconclusive', 'interrupted'].includes(c.status));
  return ask(`Kör ${regression ? 'det sparade regressionsurvalet' : 'nästa testomgång'}: ${selected.map(c => c.key).join(', ')}. Kontrollera förutsättningarna per testfall, kör oberoende fall även om andra är blockerade. Delegera webbläsarflöden till Iris. Spara nya körningar, faktisk miljö/version, observationer och skärmbilder där det är relevant. Jämför med föregående jämförbara resultat och föreslå relevanta följdtester. Ändra inget i Linear.`);
}
function openPlan(itemId: string) { const item = props.items.find(item => item.id === itemId); if (item) emit('open', item); }
</script>

<template>
  <section class="qaa-panel border border-default p-4 sm:p-5 space-y-5 min-w-0" aria-label="Kvalitetsbild">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0"><h3 class="text-lg font-semibold">Kvalitetsbild</h3><p class="mt-1 text-sm text-muted break-words">{{ settings.config.target.environment || 'Miljö ej angiven' }} · {{ settings.config.target.revision || 'Version ej angiven' }}</p></div>
      <UButton label="Testberedskap" icon="i-lucide-sliders-horizontal" color="neutral" variant="outline" @click="edit" />
    </div>
    <p v-if="!summary.targetComplete" class="text-sm text-muted">Ange miljö och version för att bedöma en release. Historiska resultat är inte ett releasegodkännande.</p>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Sparade testresultat">
      <div v-for="status in (['passed', 'failed', 'blocked', 'untested'] as const)" :key="status" class="rounded-lg bg-muted p-3"><p class="text-xl font-semibold tabular-nums">{{ summary.counts[status] }}</p><p class="text-xs text-muted">{{ qualityLabels[status] }}</p></div>
    </div>
    <p class="text-sm text-muted">{{ summary.counts.passed }} av {{ summary.total }} testfall godkända i detta urval. {{ summary.counts.inconclusive }} oklara · {{ summary.counts.stale }} behöver testas om · {{ summary.counts.running }} pågår · {{ summary.counts.interrupted }} avbrutna.</p>
    <div class="flex flex-wrap gap-2">
      <UButton label="Kontrollera förutsättningar" icon="i-lucide-clipboard-check" color="neutral" variant="soft" :disabled="disabled" @click="ask('Kontrollera testberedskapen: miljö, faktisk version, testkonton utan hemligheter, testdata och beroenden. Spara endast kontrollerade förutsättningar med observationer, avgränsa blockerare till berörda testfall. Saknad information förblir okänd. Föreslå vad som kan testas nu. Kör inte testsviten ännu.')" />
      <UButton v-if="summary.cases.some(c => c.readiness === 'ready' && ['untested', 'stale', 'failed', 'inconclusive', 'interrupted'].includes(c.status))" label="Kör nästa testomgång" icon="i-lucide-play" :disabled="disabled" @click="runCases()" />
      <UButton v-if="summary.cases.some(c => c.regression)" label="Kör regressionsurval" icon="i-lucide-repeat" color="neutral" variant="outline" :disabled="disabled" @click="runCases(true)" />
      <UButton label="Föreslå fler tester" icon="i-lucide-sparkles" color="neutral" variant="ghost" :disabled="disabled" @click="ask('Föreslå högst tre relevanta nästa tester utifrån krav, risker, sparade resultat och luckor. Ange varför och vilka som kan köras oberoende. Återanvänd befintliga fall. Skapa eller kör inget ännu; ge förslagen som uppföljningsknappar.')" />
    </div>
    <div v-if="summary.total" class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2"><p class="text-xs text-muted">Förutsättningar: {{ summary.ready }} bekräftade · {{ summary.prerequisitesBlocked }} blockerade · {{ summary.prerequisitesUnknown }} okända</p><USelect v-model="filter" :items="filters" aria-label="Filtrera kvalitetsbild" class="w-full sm:w-64" /></div>
      <article v-for="entry in filtered.slice(0, visibleCount)" :key="entry.key" class="border-t border-default pt-3 space-y-2">
        <div class="flex flex-wrap items-center gap-2"><span class="min-w-0 flex-1 break-words text-sm font-medium">{{ entry.title || 'Namnlöst testfall' }}</span><UBadge :color="statusColor(entry.status)" variant="soft">{{ qualityLabels[entry.status] }}</UBadge></div>
        <p class="text-xs text-muted break-words">{{ entry.planTitle }} · {{ entry.readiness === 'ready' ? 'Förutsättningar kontrollerade' : entry.readiness === 'blocked' ? 'Förutsättning eller testbeskrivning saknas' : 'Förutsättningar behöver kontrolleras' }}</p>
        <p v-if="entry.change === 'regression'" class="text-xs text-error">Tidigare godkänt → nu underkänt</p><p v-else-if="entry.change === 'fixed'" class="text-xs text-success">Tidigare underkänt → nu godkänt</p>
        <details v-if="entry.run" class="text-sm"><summary class="cursor-pointer">Resultat och underlag</summary><div class="mt-2 space-y-2"><p class="whitespace-pre-wrap break-words">{{ entry.run.result?.actual || 'Körningen saknar slutresultat.' }}</p><p v-if="entry.run.result?.unverified" class="text-warning whitespace-pre-wrap">Inte verifierat: {{ entry.run.result.unverified }}</p><p class="text-xs text-muted break-all">{{ entry.run.environment }} · {{ entry.run.target?.revision || 'Version ej dokumenterad' }} · {{ new Date(entry.run.startedAt).toLocaleString('sv-SE') }}</p><p v-if="entry.previous" class="text-xs text-muted">Jämfört med körning {{ entry.previous.id }} · {{ entry.previous.target?.revision }}</p><UButton label="Öppna plan och körningshistorik" variant="link" @click="openPlan(entry.itemId)" /></div></details>
        <div v-if="entry.run?.result?.evidenceItemIds.length" class="flex flex-wrap gap-2"><UButton v-for="(id, index) in entry.run.result.evidenceItemIds" :key="id" :to="`/api/workspaces/${workspaceId}/items/${id}/file`" target="_blank" color="neutral" variant="link" icon="i-lucide-paperclip" :label="`Underlag ${index + 1}`" size="sm" /></div>
        <p v-if="entry.run?.reviews?.length" class="text-xs text-muted">Manuellt bedömt. Ursprunglig observation och bedömningshistorik finns i testplanen.</p>
        <div class="flex flex-wrap gap-2">
          <UButton label="Öppna testplan" color="neutral" variant="ghost" size="sm" @click="openPlan(entry.itemId)" />
          <UButton :label="entry.regression ? 'Ingår i regression' : 'Lägg i regression'" :icon="entry.regression ? 'i-lucide-check' : 'i-lucide-plus'" color="neutral" variant="ghost" size="sm" :aria-pressed="entry.regression" :disabled="busy" @click="toggleRegression(entry.key)" />
          <UButton v-if="entry.status !== 'running'" label="Testa om" color="neutral" variant="ghost" size="sm" :disabled="disabled" @click="ask(`Kör testfall ${entry.caseId} i plan ${entry.itemId} igen efter kontroll av dess förutsättningar. Spara en ny körning med verifierad miljö/version och jämför med föregående resultat. Behåll historiken. Ändra inget i Linear.`)" />
          <UButton v-if="entry.status === 'failed'" label="Förbered felrapport" color="neutral" variant="ghost" size="sm" :disabled="disabled" @click="ask(`Förbered en felrapport i Material för körning ${entry.run?.id}, testfall ${entry.caseId}, plan ${entry.itemId}. Läs planens källor och koppla till befintligt Linear-ärende om det finns. Ta med reproduktionssteg, förväntat/faktiskt resultat, miljö, version, körnings-ID och befintliga bildreferenser. Kontrollera om samma fel redan dokumenterats. Publicera inget och ändra ingen ärendestatus ännu.`)" />
        </div>
      </article>
      <p v-if="!filtered.length" class="text-sm text-muted">Inga testfall i detta urval.</p>
      <UButton v-if="filtered.length > visibleCount" label="Visa fler testfall" color="neutral" variant="ghost" @click="visibleCount += 20" />
    </div>
    <p v-else class="text-sm text-muted">Skapa en testplan, gärna från ett Linear-ärende, för att börja följa kvaliteten.</p>
    <p v-if="error && !editing" role="alert" class="text-sm text-error">{{ error }}</p><p v-if="notice" role="status" class="text-sm text-muted">{{ notice }}</p>
    <UModal v-model:open="editing" title="Testberedskap" description="Välj vad som ska testas och kontrollera att förutsättningarna finns.">
      <template #body><div class="space-y-6">
        <section aria-label="Testmål" class="space-y-3">
          <h3 class="flex items-center gap-2 text-sm font-semibold"><UIcon name="i-lucide-crosshair" class="size-4 text-muted" />Testmål</h3>
          <div class="grid gap-4 md:grid-cols-3">
            <UFormField label="Miljö" required><UInput v-model="draft.config.target.environment" placeholder="T.ex. staging" class="w-full" /></UFormField>
            <UFormField label="Testadress"><UInput v-model="draft.config.target.url" icon="i-lucide-link" placeholder="https://…" class="w-full" /></UFormField>
            <UFormField label="Version eller commit" required><UInput v-model="draft.config.target.revision" placeholder="Release-ID eller commit" class="w-full" /></UFormField>
          </div>
          <p class="text-xs text-muted">Byter du testmål behöver förutsättningarna kontrolleras igen. Sparade testresultat bevaras.</p>
        </section>
        <section aria-label="Förutsättningar" class="space-y-3 border-t border-default pt-5">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="flex items-center gap-2 text-sm font-semibold"><UIcon name="i-lucide-list-checks" class="size-4 text-muted" />Förutsättningar <span class="text-muted font-normal">{{ draft.config.checks.length }}</span></h3>
            <UButton label="Lägg till" aria-label="Lägg till förutsättning" icon="i-lucide-plus" color="neutral" variant="ghost" size="sm" :disabled="draft.config.checks.length >= 30" @click="addCheck" />
          </div>
          <p class="text-xs text-muted">Dokumentera observationer här. Lösenord och API-nycklar hör hemma i miljöns konfiguration.</p>
          <div class="overflow-hidden rounded-xl border border-default divide-y divide-default">
            <UCollapsible v-for="(check, index) in draft.config.checks" :key="check.id" :open="expandedCheck === check.id" @update:open="expandedCheck = $event ? check.id : undefined">
              <UButton color="neutral" variant="ghost" class="w-full rounded-none p-3 text-left sm:px-4" :aria-label="`Redigera förutsättning: ${check.label || 'Ny förutsättning'}`">
                <UIcon :name="check.status === 'ready' ? 'i-lucide-circle-check' : check.status === 'blocked' ? 'i-lucide-circle-alert' : 'i-lucide-circle-dashed'" class="size-4 shrink-0" :class="check.status === 'ready' ? 'text-success' : check.status === 'blocked' ? 'text-warning' : 'text-muted'" />
                <span class="min-w-0 flex-1"><span class="block truncate font-medium">{{ check.label || 'Ny förutsättning' }}</span><span class="block text-xs font-normal text-muted">{{ check.caseKeys.length ? `${check.caseKeys.length} valda testfall` : 'Alla testfall' }}</span></span>
                <UBadge :color="check.status === 'ready' ? 'success' : check.status === 'blocked' ? 'warning' : 'neutral'" variant="soft" size="sm">{{ readinessOptions.find(option => option.value === check.status)?.label }}</UBadge>
                <UIcon name="i-lucide-chevron-down" class="size-4 shrink-0 text-muted" :class="{ 'rotate-180': expandedCheck === check.id }" />
              </UButton>
              <template #content>
                <div class="space-y-4 border-t border-default bg-muted/40 p-3 sm:p-4">
                  <div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_14rem]">
                    <UFormField label="Förutsättning"><UInput v-model="check.label" placeholder="Vad behöver finnas för att testa?" class="w-full" /></UFormField>
                    <UFormField label="Status"><USelect v-model="check.status" :items="readinessOptions" class="w-full" /></UFormField>
                  </div>
                  <div class="grid gap-4 md:grid-cols-2">
                    <UFormField label="Observation eller blockerare"><UTextarea v-model="check.detail" :rows="2" placeholder="Vad har kontrollerats och vad saknas?" class="w-full" /></UFormField>
                    <UFormField label="Berörda testfall" hint="Valfritt"><USelectMenu v-model="check.caseKeys" multiple value-key="value" placeholder="Alla testfall" :aria-label="`Berörda testfall: ${check.label}`" :items="summary.cases.map(c => ({ label: `${c.planTitle} · ${c.title}`, value: c.key }))" class="w-full" /><p class="mt-1.5 text-xs text-muted">Lämna tomt för att gälla alla testfall.</p></UFormField>
                  </div>
                  <div class="flex justify-end"><UButton label="Ta bort" :aria-label="`Ta bort förutsättning: ${check.label || 'Ny förutsättning'}`" icon="i-lucide-trash-2" color="neutral" variant="ghost" size="sm" @click="draft.config.checks.splice(index, 1)" /></div>
                </div>
              </template>
            </UCollapsible>
          </div>
          <p v-if="!draft.config.checks.length" class="text-sm text-muted">Lägg till det som behöver vara på plats innan testerna kan köras.</p>
        </section>
        <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
      </div></template>
      <template #footer><div class="flex w-full justify-end gap-2"><UButton label="Avbryt" color="neutral" variant="ghost" @click="editing = false" /><UButton label="Spara testberedskap" :loading="busy" @click="saveDraft" /></div></template>
    </UModal>
  </section>
</template>
