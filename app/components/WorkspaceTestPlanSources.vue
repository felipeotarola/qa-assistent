<script setup lang="ts">
import type { WorkspaceItem } from "#shared/workspace";
import type { TestPlan } from "#shared/test-plan";
const props = defineProps<{ plan: Pick<TestPlan, "sources">; workspaceId: string }>();
const open = ref(false), busy = ref(false), error = ref("");
const source = ref<Pick<WorkspaceItem, "title" | "content" | "version">>();
async function show(itemId: string, version: number) {
  open.value = true; busy.value = true; error.value = ""; source.value = undefined;
  try {
    const result = await $fetch<{ versions: Array<Pick<WorkspaceItem, "title" | "content" | "version">> }>(`/api/workspaces/${props.workspaceId}/items/${itemId}/versions`);
    source.value = result.versions.find(v => v.version === version);
    if (!source.value) error.value = "Källversionen kunde inte hittas.";
  } catch { error.value = "Källan är inte tillgänglig. Kontrollera om originalet finns i papperskorgen."; }
  finally { busy.value = false; }
}
</script>
<template>
  <div v-if="plan.sources.length" class="border-b border-default p-3">
    <UButton v-for="(entry, index) in plan.sources" :key="entry.itemId" :label="`Visa underlag ${plan.sources.length > 1 ? index + 1 : ''} · v${entry.version}`" icon="i-lucide-link" variant="ghost" color="neutral" @click="show(entry.itemId, entry.version)" />
    <UModal v-model:open="open" :title="source ? `${source.title} · version ${source.version}` : 'Underlag'" description="Den sparade källversionen som testplanen bygger på.">
      <template #body><p v-if="busy">Hämtar underlag…</p><p v-else-if="error" role="alert" class="text-error">{{ error }}</p><WorkspaceContent v-else-if="source && (source.content.kind === 'text' || source.content.kind === 'table' || source.content.kind === 'test_plan' || source.content.kind === 'diagram')" :content="source.content" :workspace-id="workspaceId" /></template>
    </UModal>
  </div>
</template>
