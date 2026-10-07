<script setup lang="ts">
import type { MissionView } from '~/composables/useMissions';
import { useAutonomousMissions } from '~/composables/useAutonomousMissions';
import AutonomousMissionCard from './AutonomousMissionCard.vue';
defineProps<{ compact?: boolean }>();
const { activeId } = useWorkspaces();
const { data, error, refresh } = useMissions();
const autonomous = useAutonomousMissions();
const autonomousMissions = computed(() => autonomous.data.value?.missions ?? []);
const legacyMissions = computed(() => data.value?.missions.filter(mission => mission.controllerVersion !== 1) ?? []);
const { requestedItem } = useAgentActivity();
const agent = useWorkspaceAgent();
const busy = ref(''), notice = ref('');
async function report(mission: MissionView) {
  if (mission.controllerVersion === 1) return;
  if (busy.value) return; busy.value = mission.id; notice.value = '';
  try { await $fetch(`/api/workspaces/${activeId.value}/missions`, { method: 'POST', body: { action: 'report', missionId: mission.id, threadId: mission.threadId, retry: mission.reports[0]?.status === 'failed' } }); await refresh(); }
  catch { notice.value = 'Rapportbeställningen kunde inte bekräftas. Läs status före ett nytt försök.'; }
  finally { busy.value = ''; }
}
function open(itemId: string) { if (activeId.value) requestedItem.value = { workspaceId: activeId.value, itemId }; }
async function plan() { await agent.value?.ask('Planera ett avgränsat uppdrag för detta workspace. Läs vårt sparade underlag och föreslå mål, omfattning och kriterier som Klara kan rapportera mot. Starta inga tester ännu.'); }
</script>
<template>
  <section v-if="autonomousMissions.length || legacyMissions.length || autonomous.error.value || !compact" class="space-y-3" aria-label="Uppdrag och rapporter">
    <div class="flex flex-wrap items-center justify-between gap-2"><h3 class="flex items-center gap-2 text-sm font-semibold"><UIcon v-if="compact" name="i-lucide-route" class="size-4" />Uppdrag och rapporter</h3><UButton v-if="!compact && agent?.available" label="Planera uppdrag" icon="i-lucide-plus" size="sm" variant="ghost" color="neutral" @click="plan" /></div>
    <p v-if="error || notice || autonomous.error.value" class="text-sm text-error" role="alert">{{ notice || 'Uppdragen kunde inte hämtas. Tidigare visad status kan vara inaktuell.' }}</p>
    <UButton v-if="autonomous.error.value" label="Hämta uppdragsstatus" icon="i-lucide-refresh-cw" size="sm" color="neutral" variant="ghost" @click="autonomous.refresh()" />
    <p v-if="!autonomousMissions.length && !legacyMissions.length && !autonomous.error.value" class="text-sm text-muted">{{ autonomous.pending.value ? 'Hämtar uppdrag…' : 'Be V testa en webbplats eller sammanställa sparat underlag. Följ uppdraget och Klaras rapport här.' }}</p>
    <AutonomousMissionCard v-for="mission in autonomousMissions" :key="mission.id" :workspace-id="activeId!" :mission="mission" :compact="compact" />
    <p v-if="autonomous.data.value?.hasMore" class="text-xs text-muted">De 30 senast uppdaterade uppdragen visas.</p>
    <details v-if="legacyMissions.length" :open="!compact" class="space-y-3">
    <summary class="cursor-pointer text-sm font-medium text-muted">Övriga rapportuppdrag · {{ legacyMissions.length }}</summary>
    <div v-for="mission in legacyMissions" :key="mission.id" class="space-y-2 rounded-xl border border-default p-3">
      <p class="font-medium">{{ mission.config.title }}</p>
      <p class="text-xs text-muted" role="status">{{ mission.reports[0]?.phase || 'Inget rapportjobb ännu' }} · {{ mission.status === 'closed' ? 'Avslutat uppdrag' : 'Uppdrag pågår' }}</p>
      <p v-if="mission.reports[0]?.error" class="text-sm text-error">Rapporten kunde inte slutföras.</p>
      <div class="flex flex-wrap gap-2"><UButton v-if="mission.reports.find(r => r.itemId && !r.deleted)" label="Öppna rapport" icon="i-lucide-file-chart-column" size="sm" variant="soft" color="neutral" @click="open(mission.reports.find(r => r.itemId && !r.deleted)!.itemId!)" /><UButton :label="mission.reports[0]?.status === 'failed' ? 'Försök igen' : 'Uppdatera rapport'" icon="i-lucide-refresh-cw" size="sm" variant="ghost" color="neutral" :loading="busy === mission.id || mission.reports.some(r => ['queued', 'running'].includes(r.status))" @click="report(mission)" /></div>
      <details v-if="!compact" class="text-sm"><summary class="cursor-pointer text-muted">Mål, kriterier och historik</summary><div class="mt-3 space-y-3"><p>{{ mission.config.goal }}</p><p class="text-muted">{{ mission.config.scope }}</p><ol class="list-decimal space-y-1 pl-5"><li v-for="criterion in mission.config.criteria" :key="criterion.id">{{ criterion.text }}</li></ol><p class="text-xs text-muted">{{ mission.config.caseKeys.length }} valda testfall · {{ mission.config.automaticReports ? 'Rapporten uppdateras efter nya resultat' : 'Rapporter beställs manuellt' }}</p><ul class="space-y-1"><li v-for="version in mission.reports" :key="version.id"><UButton v-if="version.itemId && !version.deleted" :label="`Revision ${version.revision} · ${new Date(version.createdAt).toLocaleString('sv-SE')}`" color="neutral" variant="link" @click="open(version.itemId)" /><span v-else class="text-xs text-muted">{{ version.deleted ? 'Rapport borttagen' : version.phase }}</span></li></ul></div></details>
    </div>
    </details>
  </section>
</template>
