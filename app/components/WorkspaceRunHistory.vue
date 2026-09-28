<script setup lang="ts">
import WorkspaceRunStatus from './WorkspaceRunStatus.vue';
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
        <p class="font-medium">{{ runLabels[run.result.outcome] }}</p>
        <div><h5 class="text-sm font-medium">Förväntat vid körningen</h5><p class="whitespace-pre-wrap text-sm text-muted">{{ run.snapshot.expected }}</p></div>
        <div><h5 class="text-sm font-medium">Faktiskt resultat</h5><p class="whitespace-pre-wrap text-sm">{{ run.result.actual }}</p></div>
        <div v-if="run.result.unverified" class="rounded-lg bg-warning/10 p-3"><h5 class="font-medium text-warning">Ej verifierat</h5><p class="whitespace-pre-wrap text-sm">{{ run.result.unverified }}</p></div>
        <div v-for="(observation, index) in run.result.observations" :key="index" class="rounded-lg border border-warning/30 p-3">
          <h5 class="font-medium">{{ observation.title }}</h5><p class="mt-1 whitespace-pre-wrap text-sm text-muted">{{ observation.detail }}</p>
          <UButton class="mt-3" color="neutral" variant="outline" label="Skapa felärende i Linear" :disabled="!available" @click="ask(`Skapa ett Linear-ärende för observation ${index + 1} i sparad körning ${run!.id}: ${observation.title}. Läs körningen med test_run list först, använd observation, faktiskt och förväntat resultat samt begränsningar. Kontrollera tidigare publicering så samma observation inte dupliceras.`)" />
        </div>
        <div v-if="run.result.evidenceItemIds.length" class="flex flex-wrap gap-2"><UButton v-for="id in run.result.evidenceItemIds" :key="id" :to="`/api/workspaces/${item.workspaceId}/items/${id}/file`" target="_blank" color="neutral" variant="outline" icon="i-lucide-paperclip" label="Öppna bevis" /></div>
      </div>
      <p v-else class="text-sm text-warning">Körningen startades men inget slutresultat är sparat. Den kan fortfarande pågå eller ha avbrutits.</p>
    </template>
    <p v-else class="text-sm text-muted">Inga strukturerade körningar sparade. Tidigare observationer kan finnas i anteckningarna.</p>
    <p v-if="notice || !available" class="text-xs text-muted" aria-live="polite">{{ notice || 'Öppna en redo chatt i detta workspace för att köra eller skapa ärenden.' }}</p>
  </section>
</template>
