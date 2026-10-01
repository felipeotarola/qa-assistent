<script setup lang="ts">
import { materialKinds } from "#shared/workspace-presentation";
import WorkspaceRunSummary from './WorkspaceRunSummary.vue';
import type { WorkspaceItem } from '#shared/workspace';
import { caseReady } from '#shared/test-plan';

const props = defineProps<{ workspaceId: string; items: WorkspaceItem[]; browserPresent?: boolean }>();
defineEmits<{ open: [item: WorkspaceItem]; testing: []; material: [] }>();
const recent = computed(() => [...props.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
const plans = computed(() => recent.value.filter(item => item.content.kind === 'test_plan'));
const materials = computed(() => recent.value.filter(item => item.content.kind !== 'test_plan'));
function readiness(item: WorkspaceItem) {
  if (item.content.kind !== 'test_plan') return '';
  const total = item.content.cases.length;
  const ready = item.content.cases.filter(caseReady).length;
  return total ? `${total} testfall · ${ready} färdigbeskrivna` : 'Inga testfall ännu';
}
</script>

<template>
  <div class="w-full space-y-8">
    <WorkspacePageHeader title="Fortsätt där ni var" description="Testplaner och gemensamt underlag, samlat för detta workspace." />
    <WorkspaceQuality :key="workspaceId" :workspace-id="workspaceId" :items="items" @open="$emit('open', $event)" />
    <UButton v-if="browserPresent" label="Visa webbläsaren" icon="i-lucide-globe" color="neutral" variant="soft" @click="$emit('material')" />
    <section aria-label="Testplaner" class="space-y-3">
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-sm font-medium">Testplaner</h3>
        <UButton label="Visa alla" trailing-icon="i-lucide-arrow-right" color="neutral" variant="ghost" @click="$emit('testing')" />
      </div>
      <div v-if="plans.length" class="qaa-panel divide-y divide-default overflow-hidden border border-default">
        <div v-for="item in plans.slice(0, 5)" :key="item.id" class="flex flex-wrap items-center gap-3 p-4">
          <UIcon name="i-lucide-list-checks" class="size-5 shrink-0 text-muted" />
          <div class="min-w-0 flex-1 basis-40">
            <h4 class="break-words text-sm font-medium">{{ item.title }}</h4>
            <p class="mt-1 text-xs text-muted">{{ readiness(item) }}</p><WorkspaceRunSummary :item="item" compact />
          </div>
          <UButton label="Öppna plan" color="neutral" variant="soft" :aria-label="`Öppna plan: ${item.title}`" @click="$emit('open', item)" />
        </div>
      </div>
      <div v-else class="rounded-xl border border-default bg-default p-5">
        <h4 class="font-medium">Vad vill ni testa?</h4>
        <p class="mt-2 text-sm text-muted">Beskriv uppgiften i chatten eller be agenten utgå från ett krav. Ni kan också skapa en tom testplan under Testning.</p>
        <UButton label="Gå till Testning" class="mt-4" color="neutral" @click="$emit('testing')" />
      </div>
      <p v-if="plans.length" class="text-xs text-dimmed">Färdigbeskrivna testfall är inte samma sak som godkända tester.</p>
    </section>
    <section aria-label="Senast uppdaterat material" class="space-y-3">
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-sm font-medium">Senast uppdaterat material</h3>
        <UButton label="Visa allt" trailing-icon="i-lucide-arrow-right" color="neutral" variant="ghost" @click="$emit('material')" />
      </div>
      <div v-if="materials.length" class="grid gap-3 sm:grid-cols-2">
        <UButton v-for="item in materials.slice(0, 4)" :key="item.id" color="neutral" variant="outline" class="justify-start p-4 text-left" @click="$emit('open', item)">
          <UIcon :name="materialKinds[item.content.kind].icon" class="size-4 shrink-0 text-muted" />
          <span class="min-w-0"><span class="block truncate">{{ item.title }}</span><span class="mt-1 block text-xs font-normal text-muted">{{ materialKinds[item.content.kind].label }} · version {{ item.version }}</span></span>
        </UButton>
      </div>
      <p v-else class="text-sm text-muted">Dokument, tabeller och bilder som ni sparar finns under Material.</p>
    </section>
  </div>
</template>
