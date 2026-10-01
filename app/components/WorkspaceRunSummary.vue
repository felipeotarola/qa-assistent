<script setup lang="ts">
import { effectiveRunOutcome, type TestRun } from '#shared/test-run';
import type { WorkspaceItem } from '#shared/workspace';
import { defaultQuality, qualitySummary, type QualitySettings } from '#shared/quality';
const props = defineProps<{ item: WorkspaceItem; compact?: boolean }>();
const runs = inject<Ref<TestRun[]>>('workspace-test-runs', ref([]));
const settings = inject<Ref<QualitySettings>>('workspace-quality', ref(defaultQuality()));
const quality = computed(() => qualitySummary([props.item], runs.value, settings.value.config));
const latest = computed(() => quality.value.cases.map(c => c.run));
const counts = computed(() => ({
  passed: latest.value.filter(r => r && effectiveRunOutcome(r) === 'passed').length,
  failed: latest.value.filter(r => r && effectiveRunOutcome(r) === 'failed').length,
  attention: latest.value.filter(r => r && ['running','inconclusive','blocked','interrupted'].includes(effectiveRunOutcome(r))).length,
  none: quality.value.counts.untested,
  older: quality.value.counts.stale,
}));
const observations = computed(() => latest.value.filter(r => r && effectiveRunOutcome(r) !== 'passed').flatMap(r => r?.result?.observations.map(o => ({ title: o.title, caseTitle: r.snapshot.title })) ?? []));
</script>
<template>
  <section :class="compact ? 'mt-3' : 'rounded-xl border border-default bg-default p-4'" aria-label="Körningsresultat">
    <h4 v-if="!compact" class="mb-3 font-semibold">Vad har verifierats?</h4>
    <div class="flex flex-wrap gap-2">
      <UBadge v-if="counts.passed" color="success" variant="soft">{{ counts.passed }} godkända</UBadge>
      <UBadge v-if="counts.failed" color="error" variant="soft">{{ counts.failed }} underkända</UBadge>
      <UBadge v-if="counts.attention" color="warning" variant="soft">{{ counts.attention }} behöver följas upp</UBadge>
      <UBadge v-if="counts.none" color="neutral" variant="soft">{{ counts.none }} utan sparad körning</UBadge>
      <UBadge v-if="counts.older" color="warning" variant="outline">{{ counts.older }} behöver testas om</UBadge>
    </div>
    <div v-if="observations.length" class="mt-3 space-y-1 text-sm">
      <p v-for="(observation, index) in observations.slice(0, compact ? 1 : 3)" :key="index" class="flex items-start gap-2"><UIcon name="i-lucide-info" class="mt-0.5 size-4 shrink-0 text-muted" /><span>{{ observation.title }}<span v-if="!compact" class="block text-xs text-muted">{{ observation.caseTitle }}</span></span></p>
      <p v-if="observations.length > (compact ? 1 : 3)" class="text-xs text-muted">Fler observationer finns i testfallen.</p>
    </div>
    <p v-if="!compact" class="mt-3 text-xs text-muted">Senaste körningen per testfall. Äldre observationer i anteckningar räknas inte som sparade körningar. Öppna ett testfall för resultat och historik.</p>
  </section>
</template>
