<script setup lang="ts">
import { runLabels, type TestRun } from '#shared/test-run';
const props = defineProps<{ run: TestRun }>();
const runs = inject<Ref<TestRun[]>>('workspace-test-runs', ref([]));
const outcome = ref<'passed' | 'failed' | 'inconclusive'>('passed');
const reason = ref(''), error = ref(''), notice = ref('');
const busy = ref(false), open = ref(false);
const requestId = ref(crypto.randomUUID());
watch([outcome, reason, () => props.run.id], () => { requestId.value = crypto.randomUUID(); notice.value = ''; });
async function save() {
  busy.value = true; error.value = '';
  try {
    await $fetch(`/api/workspaces/${props.run.workspaceId}/run-review`, { method: 'POST', body: { runId: props.run.id, requestId: requestId.value, outcome: outcome.value, reason: reason.value } });
    runs.value = await $fetch<TestRun[]>(`/api/workspaces/${props.run.workspaceId}/runs`);
    open.value = false; notice.value = 'Bedömning sparad för denna körning. Krav och framtida körningar är oförändrade.';
  }
  catch (cause) { error.value = (cause as { data?: { statusMessage?: string } }).data?.statusMessage ?? 'Bedömningen kunde inte bekräftas.'; }
  finally { busy.value = false; }
}
</script>
<template>
  <section v-if="run.result" class="space-y-3 rounded-lg border border-default bg-default p-3" aria-label="Mänsklig bedömning">
    <h5 class="font-medium">Hur går vi vidare?</h5>
    <p class="text-sm text-muted">Om kravet är oklart: förtydliga det under Krav & kontext. Om observationerna räcker för ett beslut kan du bedöma just denna körning här.</p>
    <div v-if="run.reviews?.[0]" class="rounded-lg bg-muted p-3 text-sm"><p class="font-medium">{{ runLabels[run.reviews[0].outcome] }} · manuellt bedömt</p><p class="whitespace-pre-wrap">{{ run.reviews[0].reason }}</p><p class="mt-1 text-xs text-muted">{{ new Date(run.reviews[0].createdAt).toLocaleString('sv-SE') }} · användare {{ run.reviews[0].userId }}</p></div>
    <UButton color="neutral" variant="outline" label="Bedöm den här körningen" @click="open = !open" />
    <form v-if="open" class="space-y-3" @submit.prevent="save">
      <UFormField label="Bedömning"><USelect v-model="outcome" :items="[{label:'Godkänd efter granskning',value:'passed'},{label:'Underkänd efter granskning',value:'failed'},{label:'Behöver fortfarande bedömas',value:'inconclusive'}]" class="w-full" /></UFormField>
      <UFormField label="Varför?" description="Motivera beslutet och hur du hanterar eventuella begränsningar. Detta ändrar inte testkravet." required><UTextarea v-model="reason" :rows="3" :maxlength="5000" class="w-full" required /></UFormField>
      <UButton type="submit" label="Spara bedömning för denna körning" :loading="busy" :disabled="reason.trim().length < 10" />
    </form>
    <UCollapsible v-if="(run.reviews?.length ?? 0) > 1"><UButton label="Tidigare bedömningar" color="neutral" variant="link" /><template #content><div v-for="review in run.reviews!.slice(1)" :key="review.id" class="mt-2 text-sm"><p>{{ runLabels[review.outcome] }} · {{ new Date(review.createdAt).toLocaleString('sv-SE') }}</p><p>{{ review.reason }}</p><p class="text-xs text-muted">Användare {{ review.userId }}</p></div></template></UCollapsible>
    <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p><p v-if="notice" role="status" class="text-sm">{{ notice }}</p>
  </section>
</template>
