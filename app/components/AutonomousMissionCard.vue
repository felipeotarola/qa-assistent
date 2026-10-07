<script setup lang="ts">
import type { MissionAllowedAction, MissionPresentation } from '#shared/mission-presentation';
import type { MissionWaitAnswer } from '#shared/mission-control';
import { useAutonomousMissions } from '~/composables/useAutonomousMissions';
import EnvironmentConsentPanel from './EnvironmentConsentPanel.vue';

const props = defineProps<{ workspaceId: string; mission: MissionPresentation; compact?: boolean }>();
const controls = useAutonomousMissions(), vault = useWorkspaceVault();
const { requestedItem } = useAgentActivity();
const answers = ref<Record<string, string>>({});
const expandedConsent = ref<string | null>(null);
const operation = computed(() => controls.operation(props.workspaceId, props.mission.id));
const notice = computed(() => controls.notice(props.workspaceId, props.mission.id));
const detail = computed(() => controls.detail(props.workspaceId, props.mission.id));
const telemetry = computed(() => detail.value?.telemetry);
const lifecycleLabels: Record<MissionPresentation['lifecycle'], string> = {
  accepted: 'Startar', running: 'Pågår', waiting: 'Väntar på svar', paused: 'Pausat', cancelling: 'Avbryter', closed: 'Avslutat',
};
const phaseLabels: Record<MissionPresentation['phase'], string> = {
  discover: 'Undersöker förutsättningar', plan: 'Planerar tester', prepare: 'Förbereder miljön', execute: 'Utför arbetet',
  review: 'Klara granskar', complement: 'Kompletterar underlag', report: 'Klara skriver rapport', idle: 'Inget steg körs',
};
const closureLabels = { investigated: 'Genomgång klar', criteria_satisfied: 'Uppdragets kriterier uppfyllda', blocked: 'Avslutat med hinder', budget_exhausted: 'Budgetgräns nådd', deadline: 'Tidsgräns nådd', cancelled: 'Avbrutet', delivery_failed: 'Rapportleverans saknas' };
const actionLabels = { pause: 'Pausa', cancel: 'Avbryt uppdrag', resume: 'Återuppta' };
const actionIcons = { pause: 'i-lucide-pause', cancel: 'i-lucide-square', resume: 'i-lucide-play' };
const statusColor = computed(() => props.mission.lifecycle === 'waiting' || props.mission.cleanupPending ? 'warning' : props.mission.lifecycle === 'running' || props.mission.lifecycle === 'accepted' ? 'info' : 'neutral');
const reportLabel = computed(() => {
  const report = props.mission.report;
  if (!report) return '';
  if (report.deleted) return 'Rapporten är borttagen';
  if (report.status === 'completed') return 'Rapport sparad';
  return { queued: 'Rapporten väntar i kön', running: 'Klara skriver rapport', failed: 'Rapporten kunde inte slutföras', unknown: 'Rapportstatus är okänd' }[report.status];
});
const date = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? `${new Date(value).toLocaleString('sv-SE', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'short' })} UTC` : 'Inte angivet';
const number = (value: number | null | undefined) => value == null ? 'Okänt' : value.toLocaleString('sv-SE');
const elapsed = computed(() => telemetry.value?.timing.elapsedMs == null ? 'Okänd' : `${Math.floor(telemetry.value.timing.elapsedMs / 60000)} min`);
const deadline = computed(() => props.mission.phase === 'report' && props.mission.reportDeadlineAt ? props.mission.reportDeadlineAt : props.mission.deadlineAt);
const deadlinePassed = computed(() => !!deadline.value && Date.parse(deadline.value) <= Date.parse(props.mission.observedAt));
async function command(action: MissionAllowedAction) { await controls.command(props.workspaceId, props.mission, { action }); }
async function answer(waitId: string, answer: MissionWaitAnswer) {
  const accepted = await controls.command(props.workspaceId, props.mission, { action: 'answer', waitId, answer });
  if (accepted) Reflect.deleteProperty(answers.value, waitId);
  return accepted;
}
async function approveEnvironment(waitId: string, consentId: string) {
  if (await answer(waitId, { kind: 'environment_consent', consentId })) expandedConsent.value = null;
}
function openReport() { if (props.mission.report?.itemId && !props.mission.report.deleted) requestedItem.value = { workspaceId: props.workspaceId, itemId: props.mission.report.itemId }; }
function loadDetails(event?: Event) { if (!event || (event.target as HTMLDetailsElement).open) void controls.loadDetails(props.workspaceId, props.mission.id); }
watch([() => props.workspaceId, () => props.mission.id], () => { answers.value = {}; expandedConsent.value = null; });
</script>

<template>
  <article class="min-w-0 space-y-3 rounded-xl border border-default bg-default p-3" :aria-label="`Uppdrag: ${mission.title}`">
    <div class="flex items-start gap-2">
      <UIcon name="i-lucide-route" class="mt-0.5 size-4 shrink-0 text-muted" />
      <div class="min-w-0 flex-1 space-y-1">
        <h4 class="break-words text-sm font-semibold">{{ mission.title }}</h4>
        <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
          <UBadge :color="statusColor" variant="soft" size="sm">{{ lifecycleLabels[mission.lifecycle] }}</UBadge>
          <span>{{ mission.lifecycle === 'closed' && mission.closureReason ? closureLabels[mission.closureReason] : phaseLabels[mission.phase] }}</span>
        </div>
      </div>
    </div>
    <p class="break-words text-sm"><span class="font-medium">Nästa steg: </span>{{ mission.nextStep.text }}</p>
    <p v-if="mission.lifecycle !== 'closed'" class="text-xs text-muted">
      {{ deadlinePassed ? 'Tidsgränsen passerad' : mission.phase === 'report' ? 'Rapport senast' : 'Arbetets tidsgräns' }} · <time :datetime="deadline ?? undefined">{{ date(deadline) }}</time>
    </p>
    <p v-if="mission.cleanupPending" class="flex items-start gap-2 text-xs text-warning"><UIcon name="i-lucide-hourglass" class="size-4 shrink-0" />{{ mission.resources.held }} resurser inväntar bekräftad frigöring<span v-if="mission.resources.humanControlled"> · {{ mission.resources.humanControlled }} under mänsklig kontroll</span>.</p>
    <p v-if="mission.scheduler.state === 'overdue' || mission.workers.state === 'deadline_passed'" class="text-xs text-warning">Senaste status behöver följas upp. En passerad tidsgräns bekräftar inte att utföraren har stoppat.</p>

    <section v-for="wait in mission.waits" :key="wait.id" class="space-y-2 rounded-lg border border-default bg-muted p-3" :aria-label="wait.status === 'deadline_passed' ? 'Svarstiden har gått ut' : 'Fråga om uppdraget'">
      <p class="break-words text-sm font-medium">{{ wait.question }}</p>
      <p class="text-xs text-muted">{{ wait.status === 'deadline_passed' ? 'Svarstiden har gått ut' : 'Svara senast' }} · <time :datetime="wait.deadlineAt">{{ date(wait.deadlineAt) }}</time></p>
      <form v-if="wait.allowedAnswers.includes('text')" class="space-y-2" @submit.prevent="answer(wait.id, { kind: 'text', text: answers[wait.id]?.trim() || '' })">
        <UFormField label="Ditt svar" description="Skriv inga lösenord eller API-nycklar här.">
          <UTextarea v-model="answers[wait.id]" :rows="2" :maxlength="5000" class="w-full" :disabled="!!operation" />
        </UFormField>
        <UButton type="submit" label="Skicka svar" icon="i-lucide-send" size="sm" :disabled="!!operation || !answers[wait.id]?.trim()" />
      </form>
      <div v-if="wait.allowedAnswers.includes('browser_returned') || wait.reason === 'authentication'" class="space-y-2">
        <UButton label="Öppna webbläsaren" icon="i-lucide-globe" :to="{ path: `/chat/${mission.threadId}`, query: { workspaceView: 'material' } }" color="neutral" variant="soft" size="sm" />
        <p class="text-xs text-muted">Använd webbläsarens kontroll för att lämna tillbaka den. Ett textsvar bekräftar inte en återlämning.</p>
      </div>
      <div v-if="wait.allowedAnswers.includes('environment_consent')" class="space-y-2">
        <template v-if="wait.setupJobId">
          <UButton v-if="expandedConsent !== wait.id" label="Granska och godkänn testmiljön" icon="i-lucide-shield-check" color="neutral" variant="soft" size="sm" :disabled="!!operation" :aria-expanded="false" @click="expandedConsent = wait.id" />
          <EnvironmentConsentPanel v-else :workspace-id="workspaceId" :setup-job-id="wait.setupJobId" :deadline-at="wait.deadlineAt" :disabled="!!operation || wait.status !== 'waiting'" @approved="approveEnvironment(wait.id, $event)" @close="expandedConsent = null" />
        </template>
        <template v-else>
          <UButton label="Öppna Vault" icon="i-lucide-key-round" color="neutral" variant="soft" size="sm" @click="vault.open(workspaceId)" />
          <p class="text-xs text-muted">Spara nycklar i Vault. Ett verifierat startmedgivande krävs innan miljön kan fortsätta.</p>
        </template>
      </div>
      <p v-if="wait.reason === 'authorization' && wait.status === 'waiting'" class="text-xs text-muted">Uppdraget behöver ett uttryckligt medgivande. Det ges inte genom ett vanligt textsvar.</p>
      <UButton v-if="wait.allowedAnswers.includes('decline')" label="Avstå från denna del" size="sm" color="neutral" variant="ghost" :disabled="!!operation" @click="answer(wait.id, { kind: 'decline', reason: '' })" />
    </section>

    <div v-if="mission.report" class="space-y-1 text-xs">
      <p class="font-medium">{{ reportLabel }}</p>
      <p v-if="mission.report.status === 'completed' && !mission.report.deleted" :class="mission.report.freshness === 'current' ? 'text-muted' : 'text-warning'">{{ mission.report.freshness === 'current' ? 'Rapportens underlag är aktuellt.' : mission.report.freshness === 'stale' ? 'Underlaget har ändrats sedan rapporten skrevs.' : 'Rapportens aktualitet är inte verifierad.' }}</p>
      <p class="text-muted">En färdig rapport är inte ett testgodkännande.</p>
    </div>
    <p v-if="notice" class="text-sm text-warning" role="alert">{{ notice }}</p>
    <div class="flex flex-wrap gap-1.5">
      <UButton v-if="mission.report?.status === 'completed' && mission.report.itemId && !mission.report.deleted" label="Öppna rapport" icon="i-lucide-file-chart-column" color="neutral" variant="soft" size="sm" @click="openReport" />
      <UButton v-for="action in mission.allowedActions" :key="action" :label="actionLabels[action]" :icon="actionIcons[action]" color="neutral" variant="ghost" size="sm" :disabled="!!operation" :loading="operation?.state === 'sending' && operation.input.action === action" @click="command(action)" />
      <UButton v-if="operation?.state === 'uncertain'" label="Skicka samma begäran igen" icon="i-lucide-rotate-cw" color="neutral" variant="soft" size="sm" @click="controls.retry(workspaceId, mission.id)" />
      <UButton v-if="operation?.state === 'uncertain' || mission.scheduler.state === 'overdue'" label="Hämta status" icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="sm" @click="controls.refresh()" />
    </div>
    <details class="text-xs text-muted" @toggle="loadDetails">
      <summary class="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-primary">{{ compact ? 'Status och mätvärden' : 'Uppdragets status och mätvärden' }}</summary>
      <div class="mt-3 space-y-3">
        <dl class="grid grid-cols-2 gap-x-3 gap-y-1 break-words">
          <dt>Arbetssteg</dt><dd class="text-right">{{ phaseLabels[mission.phase] }}</dd>
          <dt>Pågående försök</dt><dd>{{ mission.execution.active }}</dd>
          <dt>Start ännu obekräftad</dt><dd>{{ mission.execution.unconfirmedDispatch }}</dd>
          <dt>Senaste styrningsobservation</dt><dd class="text-right">{{ date(mission.scheduler.lastObservedAt) }}</dd>
          <dt>Senaste utförarkvitto</dt><dd class="text-right">{{ date(mission.workers.lastReceiptAt) }}</dd>
        </dl>
        <p>Observationerna är sparade kvitton, inte en bekräftelse på att processen kör just nu.</p>
        <p v-if="controls.detailError(workspaceId, mission.id)" role="alert" class="text-warning">{{ controls.detailError(workspaceId, mission.id) }}</p>
        <dl v-if="telemetry" class="grid grid-cols-2 gap-x-3 gap-y-1 break-words">
          <dt>Förfluten tid</dt><dd>{{ elapsed }}</dd>
          <dt>Körförsök / återförsök</dt><dd>{{ telemetry.attempts.logical }} / {{ telemetry.attempts.retries }}</dd>
          <dt>Uppmätta token</dt><dd>{{ number(telemetry.tokens.measuredKnown) }}{{ telemetry.tokens.total === null ? ' · ofullständig mätning' : '' }}</dd>
          <dt>Försök med okänd förbrukning</dt><dd>{{ telemetry.tokens.unknownAttempts }}</dd>
          <dt>Observerade verktygsanrop</dt><dd>{{ number(telemetry.toolCalls.observed) }}</dd>
          <dt>Kostnad</dt><dd>Inte uppmätt</dd>
        </dl>
        <p v-if="detail">Mätvärden hämtade {{ date(detail.mission.observedAt) }}.</p>
        <UButton label="Uppdatera mätvärden" icon="i-lucide-refresh-cw" size="sm" color="neutral" variant="ghost" :loading="controls.detailLoading(workspaceId, mission.id)" @click="loadDetails()" />
      </div>
    </details>
  </article>
</template>
