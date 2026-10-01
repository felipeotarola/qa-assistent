<script setup lang="ts">
import type { Destination, DestinationOption, ExternalProvider, ExternalIssue } from "#shared/external";
const props = defineProps<{ workspaceId: string }>();
const open = defineModel<boolean>('open', { default: false });
const provider = ref<ExternalProvider>("github");
const targets = ref<Destination[]>([]);
const options = ref<DestinationOption[]>([]);
const projects = ref<DestinationOption[]>([]);
const targetId = ref<string>();
const projectId = ref<string>();
const cursor = ref<string>();
const projectCursor = ref<string>();
const busy = ref(false);
const loadingProjects = ref(false);
const error = ref("");
const notice = ref("");
const operations = ref<Array<{ id: string; provider: string; state: string; action: string; destination: Destination; result: ExternalIssue | null }>>([]);
const providerOptions = [{ label: "GitHub", value: "github" }, { label: "Linear", value: "linear" }];
const current = computed(() => targets.value.find(d => d.provider === provider.value));
async function refresh() {
  const workspaceId = props.workspaceId;
  const data = await $fetch(`/api/workspaces/${workspaceId}/destinations`);
  if (props.workspaceId !== workspaceId) return;
  targets.value = data.destinations;
  operations.value = data.operations;
}
async function loadMore() {
  busy.value = true; error.value = "";
  const selected = provider.value;
  try {
    const result = await $fetch(`/api/integrations/${selected}/destinations`, { query: { cursor: cursor.value } });
    if (provider.value !== selected) return;
    options.value.push(...result.options.filter(o => !options.value.some(old => old.id === o.id)));
    cursor.value = result.cursor;
  }
  catch { error.value = `Kunde inte läsa ${selected === 'github' ? 'GitHub' : 'Linear'}. Kontrollera din anslutning under Inställningar → Integrationer.`; }
  finally { busy.value = false; }
}
async function loadProjects(more = false) {
  const team = targetId.value;
  if (provider.value !== "linear" || !team) return;
  loadingProjects.value = true;
  try {
    const result = await $fetch("/api/integrations/linear/destinations", { query: { teamId: team, cursor: more ? projectCursor.value : undefined } });
    if (provider.value !== "linear" || targetId.value !== team) return;
    projects.value = more ? [...projects.value, ...result.options] : result.options;
    projectCursor.value = result.cursor;
  }
  catch { error.value = "Kunde inte läsa Linear-projekten."; }
  finally { loadingProjects.value = false; }
}
async function initialize() {
  options.value = []; projects.value = []; cursor.value = undefined; projectCursor.value = undefined;
  notice.value = ""; error.value = "";
  targetId.value = current.value?.targetId;
  projectId.value = current.value?.projectId;
  await loadMore();
  if (current.value && !options.value.some(o => o.id === current.value!.targetId)) options.value.unshift({ id: current.value.targetId, label: current.value.label });
  await loadProjects();
}
watch(provider, () => { if (open.value) void initialize(); });
function targetChanged() { projectId.value = undefined; projects.value = []; projectCursor.value = undefined; void loadProjects(); }
watch(open, async value => {
  if (value) {
    try { await refresh(); await initialize(); }
    catch { error.value = "Kunde inte läsa workspace-kopplingarna."; }
  }
});
watch(() => props.workspaceId, () => { open.value = false; targets.value = []; operations.value = []; });
async function save() {
  if (!targetId.value) return;
  busy.value = true; error.value = ""; notice.value = "";
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/destinations`, { method: "PUT", body: { provider: provider.value, targetId: targetId.value, ...(provider.value === "linear" && projectId.value ? { projectId: projectId.value } : {}) } });
    await refresh(); await refreshNuxtData(); notice.value = "Destinationen är sparad för alla chattar i detta workspace.";
  }
  catch { error.value = "Kunde inte spara destinationen. Kontrollera att du har åtkomst till valt repo eller projekt."; }
  finally { busy.value = false; }
}
async function remove() {
  busy.value = true; error.value = "";
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/destinations`, { method: "DELETE", query: { provider: provider.value } });
    await refresh(); await refreshNuxtData(); targetId.value = undefined; projectId.value = undefined; notice.value = "Workspace-kopplingen borttagen. Externa ärenden finns kvar.";
  }
  catch { error.value = "Kunde inte ta bort kopplingen."; }
  finally { busy.value = false; }
}
const safeLink = (url: string) => /^https:\/\/(github\.com|linear\.app)\//.test(url) ? url : undefined;
</script>

<template>
  <UModal v-model:open="open" title="Workspace-kopplingar" description="Välj var agenten arbetar när du ber den läsa eller spara externa ärenden.">
    <template #body>
      <div class="space-y-4">
        <p class="text-sm text-muted">Din personliga anslutning används. Valen gäller alla chattar i detta workspace. Dokument kan fortfarande sparas här, eller användas som underlag för externa ärenden.</p>
        <UFormField label="System"><USelect v-model="provider" :items="providerOptions" :disabled="busy || loadingProjects" class="w-full" /></UFormField>
        <p v-if="current" class="text-xs text-muted">Sparad destination: {{ current.label }}</p>
        <UFormField :label="provider === 'github' ? 'Repository' : 'Team'">
          <USelectMenu v-model="targetId" :items="options" value-key="id" label-key="label" :loading="busy" :disabled="busy || loadingProjects" placeholder="Välj destination" class="w-full" @update:model-value="targetChanged" />
        </UFormField>
        <UButton v-if="cursor" label="Hämta fler" variant="link" :disabled="busy" @click="loadMore" />
        <UFormField v-if="provider === 'linear' && targetId" label="Projekt (valfritt)">
          <USelectMenu v-model="projectId" :items="projects" value-key="id" label-key="label" :loading="loadingProjects" :disabled="busy || loadingProjects" placeholder="Hela teamet" class="w-full" />
          <UButton v-if="projectId" label="Använd hela teamet" variant="link" :disabled="busy" @click="projectId = undefined" />
          <UButton v-if="projectCursor" label="Hämta fler projekt" variant="link" :disabled="loadingProjects" @click="loadProjects(true)" />
        </UFormField>
        <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
        <p v-if="notice" role="status" class="text-sm text-success">{{ notice }}</p>
        <div class="flex flex-wrap gap-2">
          <UButton label="Spara destination" :disabled="!targetId || loadingProjects" :loading="busy" @click="save" />
          <UButton v-if="current" label="Ta bort koppling" color="neutral" variant="soft" :disabled="busy" @click="remove" />
          <UButton to="/settings/integrations" label="Hantera anslutningar" color="neutral" variant="link" />
        </div>
        <div v-if="operations.length" class="space-y-3 border-t border-default pt-4">
          <h3 class="text-sm font-medium">Senaste externa ändringar</h3>
          <div v-for="operation in operations" :key="operation.id" class="text-sm">
            <p class="text-xs text-dimmed">{{ operation.provider }} · {{ operation.destination.label }}</p>
            <UButton v-if="operation.state === 'complete' && operation.result" :to="safeLink(operation.result.url)" target="_blank" :label="operation.result.title || 'Öppna ärendet'" variant="link" class="max-w-full" />
            <p v-else class="text-warning">Resultatet är inte bekräftat — kontrollera i {{ operation.provider }} innan du försöker igen.</p>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
