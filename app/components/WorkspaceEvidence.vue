<script setup lang="ts">
import type { WorkspaceItem, ItemContent } from "#shared/workspace";
import type { EvidenceLink } from "#shared/evidence";
const props = defineProps<{ item: WorkspaceItem }>();
const open = ref(false);
const links = ref<EvidenceLink[]>([]);
const loading = ref(false);
const error = ref("");
const preview = ref<{ title: string; content: ItemContent; id: string; version: number }>();
const previewOpen = ref(false);
const summary = computed(() => {
  const s = props.item.evidenceSummary;
  return s ? [s.sources ? `${s.sources} källor` : "", s.related ? `${s.related} underlag` : "", s.tickets ? `${s.tickets} ärenden` : ""].filter(Boolean).join(" · ") || "Källor & länkar" : "Källor & länkar";
});
async function load() {
  loading.value = true; error.value = "";
  try { links.value = (await $fetch<{ links: EvidenceLink[] }>(`/api/workspaces/${props.item.workspaceId}/items/${props.item.id}/evidence`)).links; }
  catch { error.value = "Kunde inte hämta källor och länkar."; }
  finally { loading.value = false; }
}
async function showItem(link: EvidenceLink) {
  error.value = "";
  try {
    const result = await $fetch<{ versions: Array<{ version: number; title: string; content: ItemContent }> }>(`/api/workspaces/${props.item.workspaceId}/items/${link.targetItemId}/versions`);
    const version = result.versions.find(v => v.version === link.targetVersion);
    if (!version) throw new Error("Missing version");
    preview.value = { ...version, id: link.targetItemId! }; previewOpen.value = true;
  } catch { error.value = "Underlaget är borttaget eller kan inte öppnas."; }
}
watch(open, value => { if (value) void load(); });
const labels: Record<string, string> = { source: "Angiven källa", capture: "Hämtad källa", item: "Underlag", ticket: "Publicerat ärende", origin: "Ursprung" };
function date(value: string) { return new Date(value).toLocaleString("sv-SE"); }
</script>
<template>
  <div class="px-3 py-2">
    <UButton :label="summary" icon="i-lucide-link" variant="soft" color="neutral" size="sm" @click.stop="open = true" />
    <UModal v-model:open="open" title="Källor & länkar" :description="item.title">
      <template #body>
        <p v-if="loading" class="text-sm text-muted">Hämtar underlag…</p>
        <p v-else-if="!links.length && !error" class="text-sm text-muted">Inga källor eller publicerade ärenden är kopplade ännu. Objektet är sparat lokalt i workspace.</p>
        <ul class="space-y-4">
          <li v-for="link in links" :key="link.id" class="rounded-lg border border-default p-3">
            <p class="mb-1 text-xs text-muted">{{ labels[link.kind] || link.kind }} · Objektversion {{ link.itemVersion }}</p>
            <UButton v-if="link.url" :to="link.url" target="_blank" rel="noopener noreferrer" :label="link.label || link.url" trailing-icon="i-lucide-arrow-up-right" color="neutral" variant="link" class="max-w-full whitespace-normal break-all px-0" />
            <UButton v-else-if="link.targetItemId" :label="`${link.label || 'Öppna underlag'} · v${link.targetVersion}`" color="neutral" variant="link" class="px-0" @click="showItem(link)" />
            <p v-else class="text-sm">{{ link.label }}</p>
            <p class="mt-1 text-xs text-muted">{{ link.observedAt ? `Källdatum: ${date(link.observedAt)}` : `Länkat: ${date(link.createdAt)}` }}</p>
            <UButton v-if="link.threadId" :to="`/chat/${link.threadId}`" label="Öppna ursprungschatt" icon="i-lucide-messages-square" size="xs" variant="ghost" color="neutral" class="mt-2" />
          </li>
        </ul>
        <p v-if="error" role="alert" class="mt-3 text-sm text-error">{{ error }}</p>
      </template>
    </UModal>
    <UModal v-model:open="previewOpen" :title="preview?.title || 'Underlag'" :description="`Sparad version ${preview?.version ?? ''}`">
      <template #body>
        <template v-if="preview">
          <WorkspaceContent v-if="preview.content.kind === 'text' || preview.content.kind === 'table'" :content="preview.content" :workspace-id="item.workspaceId" />
          <img v-else-if="preview.content.kind === 'image'" :src="`/api/workspaces/${item.workspaceId}/items/${preview.id}/file`" :alt="preview.title" class="w-full rounded-lg">
          <UButton v-else :to="`/api/workspaces/${item.workspaceId}/items/${preview.id}/file`" target="_blank" label="Öppna fil" />
        </template>
      </template>
    </UModal>
  </div>
</template>
