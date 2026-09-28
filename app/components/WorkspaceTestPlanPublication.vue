<script setup lang="ts">
import type { WorkspaceItem } from "#shared/workspace";
import type { Destination, ExternalIssue } from "#shared/external";
const props = defineProps<{ item: WorkspaceItem; disabled?: boolean }>();
const emit = defineEmits<{ saved: [] }>();
const endpoint = computed(() => `/api/workspaces/${props.item.workspaceId}/items/${props.item.id}/publication`);
const { data, error: loadError, refresh } = useFetch<{ destination: Destination | null; published: { version: number; issue: ExternalIssue } | null; currentVersion: number }>(endpoint, { key: `test-plan-publication:${props.item.workspaceId}:${props.item.id}`, watch: [() => props.item.version] });
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => { timer = setInterval(() => { if (!busy.value) void refresh(); }, 15000); });
onBeforeUnmount(() => clearInterval(timer));
const busy = ref(false), error = ref("");
const current = computed(() => data.value?.published?.version === props.item.version);
async function publish() {
  busy.value = true; error.value = "";
  try { await $fetch(endpoint.value, { method: "POST", body: { expectedVersion: props.item.version } }); await refresh(); emit("saved"); }
  catch (cause) { error.value = (cause as { data?: { statusMessage?: string } }).data?.statusMessage || "Kunde inte bekräfta publiceringen. Kontrollera Linear innan du försöker igen."; }
  finally { busy.value = false; }
}
</script>
<template>
  <div class="space-y-2 border-b border-default p-3 text-xs">
    <p v-if="loadError" role="alert">Kunde inte läsa Linear-kopplingen. <UButton label="Försök igen" variant="link" @click="refresh()" /></p>
    <template v-else-if="data">
      <div v-if="data.published" class="flex flex-wrap gap-2"><a :href="data.published.issue.url" target="_blank" rel="noopener" class="underline">Publicerad i Linear · version {{ data.published.version }}</a><UBadge v-if="!current" color="warning" variant="subtle">Lokala ändringar finns</UBadge></div>
      <p v-if="data.destination" class="text-muted">Linear · {{ data.destination.label }}</p>
      <p v-else class="text-muted">Välj Linear-team/projekt under Kopplingar för att publicera planen.</p>
      <UButton :label="current ? 'Publicerad' : data.published ? 'Uppdatera i Linear' : 'Publicera i Linear'" icon="i-lucide-send" variant="soft" :loading="busy" :disabled="disabled || busy || current || !data.destination || item.content.kind !== 'test_plan' || !item.content.cases.length" @click="publish" />
      <p v-if="!data.published && data.destination" class="text-dimmed">Skapar ett ärende. Senare versioner uppdaterar samma ärende.</p>
    </template>
    <p v-if="error" role="alert" class="text-error">{{ error }}</p>
  </div>
</template>
