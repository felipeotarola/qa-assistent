<script setup lang="ts">
import type { WorkspaceItem } from '#shared/workspace';
import type { TestRequirement } from '#shared/test-requirement';
const props = defineProps<{ item: WorkspaceItem; caseId: string }>();
const emit = defineEmits<{ openMaterial: [] }>();
const endpoint = computed(() => `/api/workspaces/${props.item.workspaceId}/requirements`);
const items = inject<Ref<WorkspaceItem[]>>('workspace-items', ref([]));
const openItem = inject<(id: string) => void>('workspace-open-item');
const { data, error: loadError, refresh } = useFetch<TestRequirement[]>(endpoint, { method: 'POST', body: computed(() => ({ action: 'list', itemId: props.item.id, caseId: props.caseId })) });
const selectedId = ref('');
const selected = computed(() => data.value?.find(r => r.id === selectedId.value) ?? data.value?.[0]);
const current = computed(() => data.value?.find(r => r.appliedVersion));
const missing = computed(() => selected.value ? [!selected.value.clarification.trim() && 'Ert svar / beslutat krav', !selected.value.expected.trim() && 'Förväntat resultat', !selected.value.issue && 'Kopplat Linear-ärende'].filter(Boolean) : []);
const editing = ref(false);
const question = ref(''), clarification = ref(''), expected = ref(''), issueId = ref(''), sourceItemId = ref('none');
const busy = ref(false), error = ref(''), notice = ref('');
const requestId = ref(crypto.randomUUID());
const sourceOptions = computed(() => [{ label: 'Inget extra underlag', value: 'none' }, ...items.value.filter(i => i.content.kind === 'text').map(i => ({ label: i.title, value: i.id }))]);
function showMaterial(id: string) { emit('openMaterial'); openItem?.(id); }
watch([question, clarification, expected, issueId, sourceItemId], () => { requestId.value = crypto.randomUUID(); });
function edit(record?: TestRequirement) {
  question.value = record?.question ?? '';
  clarification.value = record?.clarification ?? '';
  expected.value = record?.expected ?? (props.item.content.kind === 'test_plan' ? props.item.content.cases.find(c => c.id === props.caseId)?.expected ?? '' : '');
  issueId.value = record?.issue?.id ?? current.value?.issue?.id ?? '';
  sourceItemId.value = record?.sourceItemId ?? 'none';
  editing.value = true; notice.value = ''; error.value = '';
}
async function save() {
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const saved = await $fetch<TestRequirement>(endpoint.value, { method: 'POST', body: { action: 'propose', itemId: props.item.id, caseId: props.caseId, expectedVersion: props.item.version, requestId: requestId.value, question: question.value, clarification: clarification.value, expected: expected.value, ...(issueId.value.trim() ? { issueId: issueId.value.trim() } : {}), ...(sourceItemId.value !== 'none' ? { sourceItemId: sourceItemId.value } : {}) } });
    selectedId.value = saved.id; editing.value = false;
    await refresh(); notice.value = 'Förslag sparat. Granska nedan innan du sparar i Linear.';
  }
  catch (cause) { error.value = (cause as { data?: { statusMessage?: string } }).data?.statusMessage ?? 'Förslaget kunde inte sparas.'; }
  finally { busy.value = false; }
}
async function publish() {
  if (!selected.value || missing.value.length) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    await $fetch(endpoint.value, { method: 'POST', body: { action: 'publish', id: selected.value.id, expectedVersion: props.item.version } });
    notice.value = 'Sparat i Linear. Kravdokument och testfallets förväntade resultat är uppdaterade. Tidigare körningar är oförändrade.';
  }
  catch (cause) { error.value = (cause as { data?: { statusMessage?: string } }).data?.statusMessage ?? 'Kunde inte bekräfta uppdateringen. Kontrollera status innan du försöker igen.'; }
  finally { await refresh(); busy.value = false; }
}
let timer: ReturnType<typeof setInterval>;
onMounted(() => { timer = setInterval(() => { if (!busy.value) void refresh(); }, 5000); });
onBeforeUnmount(() => clearInterval(timer));
</script>
<template>
  <section class="space-y-4 rounded-xl border border-info/20 bg-info/5 p-4" aria-label="Krav och kontext">
    <div class="flex flex-wrap items-center justify-between gap-2"><h4 class="flex items-center gap-2 font-semibold"><UIcon name="i-lucide-book-open-check" />Krav & kontext</h4><UButton color="neutral" variant="outline" label="Lägg till kravförtydligande" :disabled="busy" @click="edit()" /></div>
    <p class="text-sm text-muted">Svara på det som saknas och koppla kravet till ett befintligt Linear-ärende. Det blir grunden för nästa körning.</p>
    <div v-if="current" class="space-y-2 rounded-lg border border-default bg-default p-3">
      <UBadge color="success" variant="soft">Krav sparat · plan v{{ current.appliedVersion }}</UBadge>
      <p class="whitespace-pre-wrap text-sm">{{ current.clarification }}</p>
      <div class="flex flex-wrap gap-2"><UButton v-if="current.issue" :to="current.issue.url" target="_blank" color="neutral" variant="link" :label="current.issue.title" icon="i-lucide-external-link" /><UButton v-if="current.materialId && openItem" label="Kravdokument i Material" color="neutral" variant="link" @click="showMaterial(current.materialId)" /></div>
      <p class="text-xs text-muted">Linear är huvudkälla. Material innehåller en daterad kopia; externa ändringar synkas inte automatiskt.</p>
    </div>
    <p v-if="!data?.length && !loadError" class="text-sm text-muted">Inga kravförtydliganden kopplade ännu. Ni kan länka ett kravdokument från Material som underlag.</p>
    <USelect v-if="(data?.length ?? 0) > 1" v-model="selectedId" aria-label="Välj kravförslag" :items="data!.map(r => ({ label: `${r.appliedVersion ? 'Sparat' : 'Förslag'} · ${r.question.slice(0,80)}`, value: r.id }))" class="w-full" />
    <form v-if="editing" class="space-y-3" @submit.prevent="save">
      <UFormField label="Vad behöver förtydligas?" required><UTextarea v-model="question" class="w-full" :rows="2" :maxlength="3000" required /></UFormField>
      <UFormField label="Ert svar / beslutat krav" description="Lämna tomt om ni fortfarande behöver ett svar."><UTextarea v-model="clarification" class="w-full" :rows="3" :maxlength="5000" placeholder="Exempel: Ett gemensamt felmeddelande är acceptabelt för felaktiga inloggningsuppgifter." /></UFormField>
      <UFormField label="Förväntat resultat för nästa körning"><UTextarea v-model="expected" class="w-full" :rows="3" :maxlength="5000" /></UFormField>
      <UFormField label="Linear-ärende" description="Ärende-ID, t.ex. COM-123. Använd ärendet som äger kravet, inte ett nytt felärende."><UInput v-model="issueId" class="w-full" placeholder="COM-123" /></UFormField>
      <UFormField label="Kravdokument i Material (valfritt)"><USelectMenu v-model="sourceItemId" value-key="value" :items="sourceOptions" class="w-full" /></UFormField>
      <div class="flex flex-wrap gap-2"><UButton type="submit" label="Spara förslag för granskning" :loading="busy" :disabled="!question.trim()" /><UButton label="Avbryt" color="neutral" variant="ghost" :disabled="busy" @click="editing = false" /></div>
    </form>
    <div v-else-if="selected && (!selected.appliedVersion || selected.id !== current?.id)" class="space-y-3 rounded-lg border border-default bg-default p-4">
      <UBadge :color="selected.appliedVersion ? 'neutral' : selected.publishedAt ? 'warning' : 'info'" variant="soft">{{ selected.appliedVersion ? `Tidigare kravbeslut · plan v${selected.appliedVersion}` : selected.publishedAt ? 'Sparat i Linear · lokal uppdatering återstår' : 'Förslag · inte publicerat' }}</UBadge>
      <h5 class="font-medium">{{ selected.question }}</h5>
      <div><p class="text-xs font-medium text-muted">Krav som läggs till i Linear</p><p class="whitespace-pre-wrap text-sm">{{ selected.clarification || 'Ert svar saknas.' }}</p></div>
      <div><p class="text-xs font-medium text-muted">Nytt förväntat resultat</p><p class="whitespace-pre-wrap text-sm">{{ selected.expected || 'Behöver anges.' }}</p></div>
      <UButton v-if="selected.issue" :to="selected.issue.url" target="_blank" color="neutral" variant="link" :label="`Ändrar: ${selected.issue.title}`" icon="i-lucide-external-link" />
      <div v-if="missing.length" class="space-y-2 rounded-lg bg-warning/10 p-3"><p class="text-sm font-medium">Förslaget är inte redo att publiceras</p><ul class="list-inside list-disc text-sm"><li v-for="field in missing" :key="String(field)">{{ field }} saknas</li></ul><p class="text-xs text-muted">Komplettera uppgifterna nedan. Inget har ändrats i Linear eller testfallet.</p></div>
      <p v-if="selected.sourceItemId" class="text-xs text-muted">Underlag: {{ items.find(i => i.id === selected!.sourceItemId)?.title ?? selected.sourceItemId }} · v{{ selected.sourceVersion }}</p>
      <div v-if="!selected.appliedVersion" class="flex flex-wrap gap-2"><UButton v-if="!missing.length" :label="selected.publishedAt ? 'Slutför lokal uppdatering' : 'Spara i Linear och uppdatera testfallet'" :loading="busy" @click="publish" /><UButton v-if="!selected.publishedAt" :label="missing.length ? 'Komplettera krav och koppla Linear' : 'Ändra förslaget'" :color="missing.length ? 'primary' : 'neutral'" :variant="missing.length ? 'solid' : 'outline'" :disabled="busy" @click="edit(selected)" /></div>
      <p v-if="!selected.appliedVersion" class="text-xs text-muted">Ett spårbart kravavsnitt läggs till i ärendet. Övrigt innehåll behålls. Tidigare körningar behöver bedömas separat.</p>
    </div>
    <p v-if="error || loadError" class="text-sm text-error" role="alert">{{ error || 'Kunde inte läsa kraven. Försök igen.' }}</p>
    <p v-if="notice" class="text-sm" role="status">{{ notice }}</p>
  </section>
</template>
