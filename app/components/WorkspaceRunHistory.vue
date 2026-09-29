<script setup lang="ts">
import WorkspaceRunStatus from './WorkspaceRunStatus.vue';
import WorkspaceRunReview from './WorkspaceRunReview.vue';
import { runNarrative } from '#shared/run-narrative';
import { runLabels, type TestRun } from '#shared/test-run';
import type { WorkspaceItem } from '#shared/workspace';
const props = defineProps<{ item: WorkspaceItem; caseId: string }>();
const runs = inject<Ref<TestRun[]>>('workspace-test-runs', ref([]));
const history = computed(() => runs.value.filter(r => r.itemId === props.item.id && r.caseId === props.caseId).sort((a,b) => b.startedAt.localeCompare(a.startedAt)));
const chosen = ref('');
const run = computed(() => history.value.find(r => r.id === chosen.value) ?? history.value[0]);
const agent = useWorkspaceAgent();
const busy = ref(false);
const notice = ref('');
const available = computed(() => agent.value?.workspaceId === props.item.workspaceId && agent.value.available && !busy.value);
async function ask(task: string) {
  if (!available.value) return;
  busy.value = true;
  try { notice.value = await agent.value!.run(props.item, task) ? 'Skickat till chatten.' : 'Kunde inte skicka. Kontrollera chatten.'; }
  catch { notice.value = 'Kunde inte skicka. Försök igen när chatten är redo.'; }
  finally { busy.value = false; }
}
</script>
<template>
  <section class="space-y-4 rounded-xl border border-default bg-muted/30 p-4" aria-label="Körningshistorik">
    <div class="flex flex-wrap items-center justify-between gap-2"><h4 class="font-semibold">Körningsresultat</h4><UButton :disabled="!available" icon="i-lucide-play" label="Kör testfallet" @click="ask(`Kör testfall ${caseId}. Läs aktuell plan och spara en separat körning med test_run start/finish. Ändra inte testplanen för att spara resultat.`)" /></div>
    <WorkspaceRunStatus :item="item" :case-id="caseId" />
    <UButton color="neutral" variant="ghost" icon="i-lucide-pencil-line" label="Förtydliga testfallet" :disabled="!available" @click="ask(`Hjälp mig förtydliga testfall ${caseId} utifrån senaste sparade körningens oklarheter. Läs med test_run list. Föreslå konkret vad som behöver förtydligas; fråga om kravet är oklart. Ändra aldrig tidigare körningsresultat.`)" />
    <USelect v-if="history.length > 1" v-model="chosen" aria-label="Välj tidigare körning" :items="history.map(r => ({ label: `${new Date(r.startedAt).toLocaleString('sv-SE')} · ${runLabels[r.result?.outcome ?? 'running']}`, value: r.id }))" class="w-full" />
    <template v-if="run">
      <p class="break-all text-xs text-muted">{{ run.environment }} · plan v{{ run.planVersion }}</p>
      <p class="text-xs text-muted">Körnings-ID: {{ run.id }}</p>
      <div v-if="run.result" class="space-y-3">
        <WorkspaceRunReview :key="run.id" :run="run" />
        <p class="font-medium">Agentens ursprungliga bedömning: {{ runLabels[run.result.outcome] }}</p>
        <div><h5 class="text-sm font-medium">Förväntat vid körningen</h5><p class="whitespace-pre-wrap text-sm text-muted">{{ run.snapshot.expected }}</p></div>
        <div class="rounded-lg border border-default bg-default p-4"><h5 class="mb-3 text-sm font-semibold">Faktiskt resultat</h5><div class="readable-content document-markdown break-words text-sm leading-relaxed"><ChatComark :value="runNarrative(run.result.actual)" /></div></div>
        <div v-if="run.result.unverified" class="rounded-lg bg-warning/10 p-3"><h5 class="font-medium text-warning">Ej verifierat</h5><p class="whitespace-pre-wrap text-sm">{{ run.result.unverified }}</p></div>
        <p v-if="run.result.observations.length" class="text-xs text-muted">Observationer är underlag för bedömningen, inte automatiskt fel. Skapa bara ett felärende för en bekräftad avvikelse från kraven.</p>
        <div v-for="(observation, index) in run.result.observations" :key="index" class="rounded-lg border border-default p-3">
          <UBadge v-if="observation.kind" :color="observation.kind === 'defect' ? 'error' : observation.kind === 'requirement_gap' ? 'warning' : 'neutral'" variant="soft" class="mb-2">{{ observation.kind === 'defect' ? 'Avvikelse' : observation.kind === 'requirement_gap' ? 'Krav behöver förtydligas' : 'Observation' }}</UBadge>
          <h5 class="font-medium">{{ observation.title }}</h5><p class="mt-1 whitespace-pre-wrap text-sm text-muted">{{ observation.detail }}</p>
          <UButton class="mt-3" color="neutral" variant="ghost" label="Utred om detta är en avvikelse" :disabled="!available" @click="ask(`Utred observation ${index + 1} i sparad körning ${run!.id}: ${observation.title}. Läs test_run list och test_requirement list samt länkade krav. Förklara om något krav faktiskt bryts eller om kontext saknas. Spara ett kravförslag om det behövs. Skapa inget felärende ännu.`)" />
          <UButton v-if="observation.kind !== 'note' && (run.reviews?.[0]?.outcome ?? run.result.outcome) === 'failed'" class="mt-3" color="neutral" variant="outline" label="Skapa felärende i Linear" :disabled="!available" @click="ask(`Skapa ett Linear-ärende för bekräftad avvikelse i observation ${index + 1}, körning ${run!.id}: ${observation.title}. Läs körning, krav och bedömning först. Beskriv vilket krav som bryts. Kontrollera tidigare publicering för att undvika dubletter.`)" />
        </div>
        <div v-if="run.result.evidenceItemIds.length" class="flex flex-wrap gap-2"><UButton v-for="id in run.result.evidenceItemIds" :key="id" :to="`/api/workspaces/${item.workspaceId}/items/${id}/file`" target="_blank" color="neutral" variant="outline" icon="i-lucide-paperclip" label="Öppna bevis" /></div>
      </div>
      <p v-else class="text-sm text-warning">Körningen startades men inget slutresultat är sparat. Den kan fortfarande pågå eller ha avbrutits.</p>
      <section class="space-y-3" aria-label="Skärmbilder från körningen">
        <h5 class="font-medium">Skärmbilder · {{ run.captures?.filter(c => c.itemId).length ?? 0 }}</h5>
        <p v-if="!run.captures?.length" class="text-sm text-muted">Inga automatiska skärmbilder i denna körning. Nya webbtester sparar bilder efter sidbesök och interaktioner.</p>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <template v-for="(capture, index) in run.captures" :key="capture.id">
            <a v-if="capture.itemId" :href="`/api/workspaces/${item.workspaceId}/items/${capture.itemId}/file`" target="_blank" rel="noopener" class="overflow-hidden rounded-lg border border-default bg-default focus-visible:outline-2 focus-visible:outline-primary">
              <img :src="`/api/workspaces/${item.workspaceId}/items/${capture.itemId}/file`" :alt="`Skärmbild ${index + 1}: ${capture.title || capture.action}`" loading="lazy" class="h-36 w-full object-cover object-top">
              <div class="space-y-1 p-2"><p class="text-sm font-medium">{{ index + 1 }}. {{ capture.title || 'Webbsida' }}</p><p class="break-all text-xs text-muted">{{ capture.url }}</p><p class="text-xs text-muted">{{ capture.action }} · {{ new Date(capture.createdAt).toLocaleTimeString('sv-SE') }}</p></div>
            </a>
            <p v-else class="rounded-lg bg-warning/10 p-3 text-sm text-warning">{{ capture.error }}</p>
          </template>
        </div>
      </section>
    </template>
    <p v-else class="text-sm text-muted">Inga strukturerade körningar sparade. Tidigare observationer kan finnas i anteckningarna.</p>
    <p v-if="notice || !available" class="text-xs text-muted" aria-live="polite">{{ notice || 'Öppna en redo chatt i detta workspace för att köra eller skapa ärenden.' }}</p>
  </section>
</template>
