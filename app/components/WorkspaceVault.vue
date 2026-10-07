<script setup lang="ts">
import { environmentName, parseEnvironmentFile, vaultRepositoryUrl, type VaultEntry, type SetupView } from '#shared/project-environment';
const { request } = useWorkspaceVault();
const { activeId } = useWorkspaces();
const open = computed({ get: () => !!request.value, set: value => { if (!value) request.value = null; } });
const entries = ref<VaultEntry[]>([]), jobs = ref<SetupView[]>([]);
const repoUrl = ref(''), loading = ref(false), busy = ref(false), error = ref(''), info = ref('');
const loaded = ref(false);
const rows = ref<{ name: string; value: string; remove: boolean }[]>([]);
const fileInput = ref<HTMLInputElement>();
let generation = 0;
const repo = computed(() => vaultRepositoryUrl.safeParse(repoUrl.value));
const entry = computed(() => entries.value.find(e => e.repoUrl === (repo.value.success ? repo.value.data : '')));
const job = computed(() => {
  const matches = jobs.value.filter(j => j.result?.environment?.repoUrl === (repo.value.success ? repo.value.data : ''));
  return matches.find(j => j.id === request.value?.jobId) || matches[0];
});
const plan = computed(() => job.value?.result?.environment);
const options = computed(() => [...new Set([...jobs.value.flatMap(j => j.result?.environment ? [j.result.environment.repoUrl] : []), ...entries.value.map(e => e.repoUrl)])].map(value => ({ label: value.split('/').slice(-2).join('/'), value })));
const canContinue = computed(() => !!plan.value && !!job.value && !job.value.autonomous && ['needs_configuration', 'failed', 'completed'].includes(job.value.status) && plan.value.variables.every(field => !field.required || rows.value.some(row => row.name === field.name && !row.remove && (row.value || entry.value?.configuredNames.includes(row.name)))));
function resetRows() {
  rows.value = [...new Set([...(plan.value?.variables.map(v => v.name) || []), ...(entry.value?.configuredNames || [])])].map(name => ({ name, value: '', remove: false }));
  if (!rows.value.length) rows.value = [{ name: '', value: '', remove: false }];
  error.value = ''; info.value = '';
}
watch(repoUrl, resetRows);
watch(activeId, () => { request.value = null; });
watch(request, async value => {
  const current = ++generation;
  loaded.value = false;
  rows.value = []; entries.value = []; jobs.value = []; repoUrl.value = ''; error.value = ''; info.value = '';
  if (!value) { loading.value = false; return; }
  loading.value = true;
  try {
    const [vault, setups] = await Promise.all([
      $fetch<{ entries: VaultEntry[] }>(`/api/workspaces/${value.workspaceId}/vault`),
      $fetch<{ jobs: SetupView[] }>(`/api/workspaces/${value.workspaceId}/setup-jobs`),
    ]);
    if (current !== generation) return;
    entries.value = vault.entries; jobs.value = setups.jobs;
    repoUrl.value = setups.jobs.find(j => j.id === value.jobId)?.result?.environment?.repoUrl || options.value[0]?.value || '';
    resetRows();
    loaded.value = true;
  } catch { if (current === generation) error.value = 'Vaulten kunde inte läsas. Stäng och öppna igen för att försöka på nytt.'; }
  finally { if (current === generation) loading.value = false; }
});
onBeforeUnmount(() => { generation++; rows.value = []; });
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0], current = generation, target = repoUrl.value;
  try {
    if (!file) return;
    if (file.size > 128000) throw Error();
    const values = parseEnvironmentFile(await file.text());
    if (current !== generation || target !== repoUrl.value) return;
    for (const [name, value] of Object.entries(values)) {
      const row = rows.value.find(r => r.name === name);
      if (row) { row.value = value; row.remove = false; }
      else rows.value.push({ name, value, remove: false });
    }
    rows.value = rows.value.filter(r => r.name || r.value);
    info.value = `${Object.keys(values).length} värden inlästa. Klicka på Spara för att spara dem.`;
  } catch { if (current === generation) error.value = 'Filen kunde inte läsas. Använd NAMN=värde, en variabel per rad, utan dubbla namn.'; }
  finally { input.value = ''; }
}
async function save(resume: boolean) {
  if (!request.value || !repo.value.success || busy.value || !loaded.value) return;
  const selected = rows.value.filter(r => r.name || r.value);
  if (selected.some(r => r.name && !r.value && !r.remove && !entry.value?.configuredNames.includes(r.name) && !plan.value?.variables.some(v => v.name === r.name))) {
    error.value = 'Fyll i ett värde för varje ny variabel.'; return;
  }
  if (selected.some(r => !environmentName.safeParse(r.name).success) || new Set(selected.map(r => r.name)).size !== selected.length || selected.length > 30) {
    error.value = 'Använd unika variabelnamn i STORA_BOKSTÄVER, högst 30 variabler.'; return;
  }
  const values = Object.fromEntries(selected.filter(r => r.value && !r.remove).map(r => [r.name, r.value]));
  const forget = selected.filter(r => r.remove).map(r => r.name);
  const workspaceId = request.value.workspaceId, url = repo.value.data, current = generation;
  busy.value = true; error.value = ''; info.value = '';
  try {
    // Saving never grants runtime access. Continuing uses the verified job plan.
    const saved = await $fetch<VaultEntry>(`/api/workspaces/${workspaceId}/vault`, { method: 'PUT', body: { repoUrl: url, expectedRevision: entry.value?.revision || 0, values, forget } });
    if (current !== generation) return;
    entries.value = [...entries.value.filter(e => e.repoUrl !== url), saved];
    rows.value.forEach(r => { r.value = ''; r.remove = false; });
    info.value = 'Nycklarna är sparade krypterat. Ingen app har startats.';
    if (resume && job.value && canContinue.value) {
      await $fetch(`/api/workspaces/${workspaceId}/setup-jobs/${job.value.id}`, { method: 'PUT', body: { expectedRevision: saved.revision, values: {}, forget: [], continue: true } });
      if (current === generation) { entries.value = entries.value.map(e => e.repoUrl === url ? { ...e, revision: saved.revision + 1 } : e); info.value = 'Nycklarna är sparade. Appstart kontrolleras nu; resultatet visas i Pågående arbete.'; }
    }
  } catch (cause) {
    if (current === generation) error.value = (cause as { data?: { statusMessage?: string } }).data?.statusMessage || 'Sparandet kunde inte bekräftas. Stäng och öppna vaulten för aktuell status.';
  } finally { busy.value = false; }
}
</script>

<template>
  <UModal v-model:open="open" title="Vault · Testmiljö" description="API-nycklar och miljövariabler för ditt repo. Skriv aldrig nycklar i chatten." :ui="{ description: 'pr-8' }" :dismissible="!busy" :close="{ disabled: busy }">
    <template #body>
      <div v-if="loading" class="flex items-center gap-2 text-sm text-muted"><UIcon name="i-lucide-loader-circle" class="motion-safe:animate-spin" />Läser vaulten…</div>
      <div v-else class="space-y-5">
        <USelect v-if="options.length" v-model="repoUrl" :items="options" aria-label="Välj sparat repo" placeholder="Välj repo" class="w-full" :disabled="busy" />
        <UFormField label="GitHub-repo" required description="Nycklarna hör bara till detta repo i ditt workspace.">
          <UInput v-model="repoUrl" placeholder="https://github.com/ägare/repo" class="w-full" :disabled="busy" />
        </UFormField>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-sm font-semibold">Miljövariabler <span class="font-normal text-muted">· Testmiljö</span></p>
          <UButton label="Importera .env" icon="i-lucide-file-up" variant="outline" size="sm" :disabled="busy || !repo.success" @click="fileInput?.click()" />
          <input ref="fileInput" type="file" accept=".env,.local,.txt" class="hidden" aria-label="Importera miljövariabler" @change="importFile">
        </div>
        <div v-for="(row, index) in rows" :key="index" class="space-y-2 rounded-lg border border-default p-3">
          <div class="flex items-start gap-2">
            <UFormField :label="`Variabel ${index + 1}`" class="min-w-0 flex-1" :hint="entry?.configuredNames.includes(row.name) ? 'Sparad' : undefined">
              <UInput v-model="row.name" placeholder="NEXT_PUBLIC_SUPABASE_URL" aria-label="Variabelnamn" class="w-full font-mono" :disabled="busy || !!plan?.variables.some(v => v.name === row.name) || !!entry?.configuredNames.includes(row.name)" />
            </UFormField>
            <UButton v-if="!entry?.configuredNames.includes(row.name) && !plan?.variables.some(v => v.name === row.name)" icon="i-lucide-x" aria-label="Ta bort variabelrad" variant="ghost" class="mt-6" :disabled="busy" @click="rows.splice(index, 1)" />
          </div>
          <UFormField :label="`Värde för ${row.name || 'variabeln'}`" :description="plan?.variables.find(v => v.name === row.name)?.reason" :required="plan?.variables.find(v => v.name === row.name)?.required">
            <UInput v-model="row.value" type="password" autocomplete="new-password" class="w-full" :placeholder="entry?.configuredNames.includes(row.name) ? 'Sparat · lämna tomt för att behålla' : 'Klistra in värde'" :disabled="busy || row.remove" />
          </UFormField>
          <UCheckbox v-if="entry?.configuredNames.includes(row.name)" v-model="row.remove" label="Ta bort sparat värde" :disabled="busy" />
        </div>
        <UButton label="Lägg till variabel" icon="i-lucide-plus" variant="ghost" :disabled="busy || rows.length >= 30" @click="rows.push({ name: '', value: '', remove: false })" />
        <p class="text-xs text-muted">Befintliga värden visas aldrig. Import läses lokalt och sparas först när du klickar på Spara.</p>
        <p v-if="!plan" class="text-sm text-muted">Du kan spara nycklar redan nu. Be sedan Otto förbereda testmiljön. När en körplan finns kan du godkänna att repot använder nycklarna här.</p>
        <p v-else-if="job?.autonomous" class="text-xs text-muted">Spara nycklarna här och gå tillbaka till uppdragets startplan för att godkänna användningen. Att spara i Vault startar inget arbete.</p>
        <p v-else class="text-xs text-muted">Spara och fortsätt ger detta repos kod tillgång till variablerna i körplanen och kontrollerar appens HTTP-svar.</p>
        <p v-if="info" role="status" class="text-sm text-success">{{ info }}</p>
        <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
      </div>
    </template>
    <template #footer><div class="flex flex-wrap gap-2">
      <UButton :label="job?.autonomous ? 'Spara i Vault' : 'Spara nycklar'" icon="i-lucide-lock-keyhole" :loading="busy" :disabled="!loaded || loading || !repo.success" @click="save(false)" />
      <UButton v-if="plan && !job?.autonomous" label="Spara och fortsätt" variant="outline" :disabled="busy || loading || !canContinue" @click="save(true)" />
      <UButton label="Stäng" variant="ghost" :disabled="busy" @click="open = false" />
    </div></template>
  </UModal>
</template>
