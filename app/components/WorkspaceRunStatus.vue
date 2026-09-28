<script setup lang="ts">
import { latestCaseRun, effectiveRunOutcome, runLabels, type TestRun } from '#shared/test-run';
import type { WorkspaceItem } from '#shared/workspace';
const props = defineProps<{ item: WorkspaceItem; caseId: string; showCount?: boolean }>();
const runs = inject<Ref<TestRun[]>>('workspace-test-runs', ref([]));
const run = computed(() => latestCaseRun(runs.value, props.item.id, props.caseId));
const attempts = computed(() => runs.value.filter(r => r.itemId === props.item.id && r.caseId === props.caseId).length);
const status = computed(() => run.value ? effectiveRunOutcome(run.value) : 'none');
const colors = { passed: 'success', failed: 'error', inconclusive: 'warning', blocked: 'warning', interrupted: 'neutral', running: 'info', none: 'neutral' } as const;
</script>
<template>
  <div class="min-w-0 space-y-1 break-words">
    <UBadge :color="colors[status]" variant="subtle" class="max-w-full whitespace-normal">{{ runLabels[status] }}</UBadge>
    <p v-if="run?.reviews?.length" class="text-xs text-muted">Manuellt bedömt</p>
    <p v-if="run" class="text-xs text-muted">Senast {{ new Date(run.startedAt).toLocaleString('sv-SE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }} · v{{ run.planVersion }}</p>
    <p v-if="showCount" class="text-xs text-muted">{{ attempts }} {{ attempts === 1 ? 'körning' : 'körningar' }}<span v-if="run?.result?.observations.length"> · {{ run.result.observations.length }} {{ run.result.observations.length === 1 ? 'observation' : 'observationer' }}</span></p>
    <p v-if="run && run.planVersion !== item.version" class="text-xs text-warning">Gäller en äldre planversion</p>
  </div>
</template>
