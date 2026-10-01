<script setup lang="ts">
import type { LinearWorkspaceIssue } from '#shared/linear-workspace';
import { startChat } from '~/composables/chat/navigation';
const props = defineProps<{ workspaceId: string }>();
const issueCursor = ref<string>();
const documentCursor = ref<string>();
const query = ref('');
const selected = ref<LinearWorkspaceIssue>();
const section = ref('issues');
const agent = useWorkspaceAgent();
const busy = ref(false);
const actionError = ref('');
const toast = useToast();
const { data, error, status, refresh } = await useFetch(() => `/api/workspaces/${props.workspaceId}/linear`, {
  query: computed(() => ({ issues: issueCursor.value, documents: documentCursor.value })),
});
const issues = computed(() => (data.value?.project.issues.nodes ?? []).filter(issue => `${issue.identifier} ${issue.title} ${issue.state.name}`.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())));
watch(data, () => { if (selected.value) selected.value = data.value?.project.issues.nodes.find(issue => issue.id === selected.value?.id); });
const disabled = computed(() => busy.value || (!!agent.value && agent.value.workspaceId === props.workspaceId && !agent.value.available));
async function ask(kind: 'plan' | 'report') {
  const issue = selected.value;
  if (!issue || disabled.value) return;
  busy.value = true; actionError.value = '';
  const prompt = `Linear-issue ${issue.identifier} (ID: ${issue.id}), ${issue.url}. Läs den aktuella issuet via workspace-kopplingen först. ` + (kind === 'plan'
    ? 'Skapa eller uppdatera en testplan i detta workspace utifrån acceptanskriterierna. Återanvänd befintlig plan för denna issue om den finns. Spara källans URL och identifierare i planen. Dokumentera oklarheter. Kör inga tester och ändra inget i Linear i detta steg.'
    : 'Läs de sparade testresultaten som hör till denna issue i detta workspace. Publicera en kommentar i Linear med verifierade resultat, körnings-ID och underlag. Skilj godkänt, misslyckat, blockerat och inte testat. Om verifierat underlag saknas, skriv ingen kommentar utan förklara vad som saknas. Ändra inte issuets status.');
  try {
    if (agent.value?.workspaceId === props.workspaceId) {
      if (!await agent.value.ask(prompt)) actionError.value = 'Meddelandet kunde inte skickas. Kontrollera chatten innan du försöker igen.';
      else { selected.value = undefined; toast.add({ title: 'Uppgiften är skickad till chatten', color: 'success' }); }
    } else await startChat(prompt);
  } catch { actionError.value = 'Kunde inte öppna chatten. Försök igen.'; }
  finally { busy.value = false; }
}
</script>
<template>
  <section class="space-y-5 min-w-0" aria-label="Linear-projekt">
    <WorkspacePageHeader :title="data?.project.name || 'Linear'" description="Projektunderlag direkt från Linear. Testplaner och resultat sparas i ditt workspace.">
      <div class="flex flex-wrap items-center gap-2">
        <UButton icon="i-lucide-refresh-cw" label="Uppdatera" color="neutral" variant="outline" :loading="status === 'pending'" @click="refresh()" />
        <UButton v-if="data" :to="data.project.url" target="_blank" label="Öppna i Linear" icon="i-lucide-arrow-up-right" color="neutral" variant="ghost" />
        <span v-if="data" class="text-xs text-muted">Hämtat {{ new Date(data.fetchedAt).toLocaleTimeString('sv-SE') }}</span>
      </div>
    </WorkspacePageHeader>
    <UAlert v-if="error" color="error" title="Kunde inte hämta Linear" description="Kontrollera att Linear är anslutet under Integrationer och att ett projekt är valt under Kopplingar. Försök sedan uppdatera." />
    <p v-else-if="!data" role="status" class="text-muted">Hämtar projektet…</p>
    <template v-if="data && !error">
      <UTabs v-model="section" :content="false" :items="[{ label: 'Issues', value: 'issues' }, { label: 'Översikt', value: 'overview' }, { label: 'Dokument', value: 'documents' }]" />
      <div v-if="section === 'overview'" class="space-y-4 break-words">
        <p class="text-muted">{{ data.project.description }}</p>
        <ChatComark :value="data.project.content || 'Ingen projektbeskrivning ännu.'" />
      </div>
      <div v-else-if="section === 'documents'" class="space-y-3">
        <p v-if="!data.project.documents.nodes.length" class="text-muted">Inga projektdokument på den här sidan. Projektbeskrivningen finns under Översikt.</p>
        <details v-for="document in data.project.documents.nodes" :key="document.id" class="rounded-xl border border-default p-4">
          <summary class="cursor-pointer font-medium">{{ document.title }}</summary>
          <div class="mt-4 min-w-0 break-words"><ChatComark :value="document.content || 'Dokumentet är tomt.'" /></div>
          <UButton :to="document.url" target="_blank" label="Öppna dokumentet i Linear" color="neutral" variant="link" />
        </details>
        <div class="flex gap-2">
          <UButton v-if="documentCursor" label="Första sidan" variant="outline" color="neutral" @click="documentCursor = undefined" />
          <UButton v-if="data.project.documents.pageInfo.hasNextPage" label="Nästa dokument" variant="outline" color="neutral" @click="documentCursor = data.project.documents.pageInfo.endCursor || undefined" />
        </div>
      </div>
      <div v-else class="space-y-3">
        <UInput v-model="query" icon="i-lucide-search" placeholder="Sök på denna sida" aria-label="Sök issues på denna sida" class="w-full" />
        <p v-if="!issues.length" class="text-muted">Inga issues matchar på denna sida.</p>
        <UButton v-for="issue in issues" :key="issue.id" color="neutral" variant="outline" class="w-full justify-start text-left" @click="selected = issue">
          <div class="min-w-0 whitespace-normal">
            <span class="text-xs text-muted">{{ issue.identifier }} · {{ issue.state.name }} · {{ issue.assignee?.name || 'Ej tilldelad' }}</span>
            <p class="mt-1 font-medium">{{ issue.title }}</p>
          </div>
        </UButton>
        <div class="flex gap-2">
          <UButton v-if="issueCursor" label="Första sidan" color="neutral" variant="outline" @click="issueCursor = undefined" />
          <UButton v-if="data.project.issues.pageInfo.hasNextPage" label="Nästa issues" color="neutral" variant="outline" @click="issueCursor = data.project.issues.pageInfo.endCursor || undefined" />
        </div>
      </div>
    </template>
    <UModal :open="!!selected" :title="selected ? `${selected.identifier} · ${selected.title}` : 'Issue'" @update:open="value => { if (!value) selected = undefined }">
      <template #body>
        <div v-if="selected" class="space-y-4 min-w-0 break-words">
          <p class="text-sm text-muted">{{ selected.state.name }} · {{ selected.assignee?.name || 'Ej tilldelad' }}</p>
          <ChatComark :value="selected.description || 'Ingen beskrivning.'" />
          <UButton :to="selected.url" target="_blank" label="Öppna i Linear" color="neutral" variant="link" />
          <p class="text-sm text-muted">Skapa testplan skickar uppgiften till agenten. Rapportera resultat ber agenten publicera en kommentar med verifierat underlag; status ändras inte.</p>
          <p v-if="actionError" role="alert" class="text-error">{{ actionError }}</p>
        </div>
      </template>
      <template #footer>
        <div class="flex flex-wrap gap-2">
          <UButton label="Skapa testplan" icon="i-lucide-list-checks" :disabled="disabled" @click="ask('plan')" />
          <UButton label="Rapportera resultat" icon="i-lucide-send" color="neutral" variant="outline" :disabled="disabled" @click="ask('report')" />
        </div>
      </template>
    </UModal>
  </section>
</template>
