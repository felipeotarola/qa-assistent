<script setup lang="ts">
import type { EnvironmentConsentView } from '#shared/project-environment-consent';
import { useEnvironmentConsent, usableEnvironmentConsent } from '~/composables/useEnvironmentConsent';

const props = defineProps<{ workspaceId: string; setupJobId: string; deadlineAt: string; disabled?: boolean }>();
const emit = defineEmits<{ approved: [consentId: string]; close: [] }>();
const client = useEnvironmentConsent(), vault = useWorkspaceVault();
const selectedNames = ref<string[]>([]), selectedConsent = ref(''), hours = ref(24);
const state = computed(() => client.state(props.workspaceId, props.setupJobId));
const status = computed(() => state.value.status);
const plan = computed(() => state.value.pending?.plan ?? status.value?.plan);
const date = (value: string) => Number.isFinite(Date.parse(value)) ? `${new Date(value).toLocaleString('sv-SE', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'short' })} UTC` : 'Okänd';
const waitClosed = computed(() => !!props.disabled || Date.parse(props.deadlineAt) <= Date.now());
const blocked = computed(() => waitClosed.value || state.value.loading || !!state.value.pending);
const activeConsents = computed(() => (status.value?.consents ?? []).filter(consent => usableEnvironmentConsent(consent, status.value, Date.now())));
const consent = computed(() => activeConsents.value.find(entry => entry.id === selectedConsent.value));
const consentOptions = computed(() => activeConsents.value.map(entry => ({ value: entry.id, label: `Gäller till ${date(entry.expiresAt)} · ${entry.allowedNames.length} variabler` })));
const canGrant = computed(() => !blocked.value && !!status.value?.plan && !!status.value.planHash && status.value.vaultRevision > 0
  && selectedNames.value.length > 0 && !status.value.missingNames.length
  && status.value.plan.variables.every(variable => !variable.required || selectedNames.value.includes(variable.name)));
const durationOptions = [{ label: '1 timme', value: 1 }, { label: '24 timmar', value: 24 }, { label: '7 dagar', value: 168 }];
watch([() => props.workspaceId, () => props.setupJobId], () => {
  selectedNames.value = []; selectedConsent.value = ''; hours.value = 24;
  void refresh();
}, { immediate: true });
watch(status, value => {
  selectedNames.value = (value?.plan?.variables ?? []).filter(variable => variable.required && value?.configuredNames.includes(variable.name)).map(variable => variable.name);
  selectedConsent.value = activeConsents.value[0]?.id ?? '';
}, { immediate: true });
function selectName(name: string, checked: boolean | 'indeterminate') {
  selectedNames.value = checked === true ? [...new Set([...selectedNames.value, name])] : selectedNames.value.filter(value => value !== name);
}
async function refresh() { await client.load(props.workspaceId, props.setupJobId); }
function forward(value: EnvironmentConsentView | null, workspaceId: string, setupJobId: string) {
  if (workspaceId !== props.workspaceId || setupJobId !== props.setupJobId || props.disabled || Date.parse(props.deadlineAt) <= Date.now()) return;
  if (value && usableEnvironmentConsent(value, status.value, Date.now())) emit('approved', value.id);
}
async function grant() {
  if (!canGrant.value) return;
  const { workspaceId, setupJobId } = props;
  forward(await client.grant(workspaceId, setupJobId, selectedNames.value, hours.value), workspaceId, setupJobId);
}
async function retry() {
  if (props.disabled || Date.parse(props.deadlineAt) <= Date.now()) return;
  const { workspaceId, setupJobId } = props;
  forward(await client.retry(workspaceId, setupJobId), workspaceId, setupJobId);
}
function reuse() { if (!blocked.value) forward(consent.value ?? null, props.workspaceId, props.setupJobId); }
</script>

<template>
  <section class="min-w-0 space-y-3 rounded-lg border border-default bg-default p-3" aria-label="Godkänn testmiljön">
    <div class="flex items-start justify-between gap-2">
      <h5 class="text-sm font-semibold">Godkänn testmiljön</h5>
      <UButton icon="i-lucide-x" aria-label="Stäng startplanen" size="xs" color="neutral" variant="ghost" @click="emit('close')" />
    </div>
    <p class="text-xs text-muted">Granska vad som får startas och vilka sparade variabler som får användas. Nycklarnas värden visas aldrig här.</p>
    <p v-if="state.loading" class="text-sm text-muted" role="status">Hämtar aktuell startplan…</p>
    <p v-if="state.notice" class="break-words text-sm text-warning" role="alert">{{ state.notice }}</p>
    <template v-if="plan">
      <dl class="space-y-2 text-xs">
        <div><dt class="font-medium">Repository</dt><dd class="break-all text-muted">{{ plan.repoUrl }}</dd></div>
        <div><dt class="font-medium">Exakt commit</dt><dd class="break-all font-mono text-muted">{{ plan.commit }}</dd></div>
        <div><dt class="font-medium">Projektrot</dt><dd class="break-all font-mono text-muted">{{ plan.root }}</dd></div>
        <div><dt class="font-medium">Appkatalog</dt><dd class="break-all font-mono text-muted">{{ plan.directory }}</dd></div>
        <div><dt class="font-medium">Startkommando</dt><dd class="whitespace-pre-wrap break-all font-mono text-muted">{{ plan.command }}</dd></div>
        <div><dt class="font-medium">Port</dt><dd>{{ plan.port }}</dd></div>
      </dl>
      <p class="text-xs text-muted">Svarstiden för uppdraget är fortfarande {{ date(deadlineAt) }}.</p>
      <div v-if="state.pending" class="space-y-2 text-xs">
        <p class="font-medium">Den skickade begäran</p>
        <p class="break-all">{{ state.pending.body.allowedNames.join(', ') }}</p>
        <p>Gäller till {{ date(state.pending.body.expiresAt) }}. Ett nytt försök använder exakt samma begäran.</p>
        <UButton v-if="state.pending.state === 'uncertain'" label="Försök samma godkännande igen" icon="i-lucide-rotate-cw" size="sm" :disabled="waitClosed || state.loading" @click="retry" />
        <p v-else role="status">Sparar medgivandet…</p>
      </div>
      <template v-else>
        <div v-if="activeConsents.length" class="space-y-2 rounded-lg border border-default p-2">
          <UFormField label="Sparat giltigt medgivande">
            <USelect v-model="selectedConsent" :items="consentOptions" class="w-full" :disabled="blocked" />
          </UFormField>
          <p v-if="consent" class="break-all text-xs text-muted">Tillåtna variabler: {{ consent.allowedNames.join(', ') }}</p>
          <UButton label="Använd medgivandet och fortsätt" size="sm" :disabled="blocked || !consent" @click="reuse" />
        </div>
        <fieldset class="min-w-0 space-y-2" :disabled="blocked">
          <legend class="mb-2 text-xs font-medium">Variabler från Vault</legend>
          <UCheckbox v-for="variable in plan.variables" :key="variable.name" :label="variable.name" :description="!status?.configuredNames.includes(variable.name) ? 'Saknas i Vault' : variable.required ? 'Obligatorisk · sparad' : 'Valfri · sparad'" :model-value="selectedNames.includes(variable.name)" :disabled="blocked || variable.required || !status?.configuredNames.includes(variable.name)" @update:model-value="selectName(variable.name, $event)">
            <template #label><span class="break-all font-mono text-xs">{{ variable.name }}</span></template>
          </UCheckbox>
          <p v-if="!plan.variables.length" class="text-xs text-muted">Startplanen begär inga Vault-variabler.</p>
        </fieldset>
        <p v-if="status?.missingNames.length" class="break-words text-xs text-warning">Lägg först till de saknade obligatoriska variablerna i Vault och hämta sedan aktuell status.</p>
        <UFormField v-if="plan.variables.length" label="Medgivandets giltighet" description="Uppdragets egen tidsgräns förlängs inte.">
          <USelect v-model="hours" :items="durationOptions" class="w-full" :disabled="blocked" />
        </UFormField>
        <UButton v-if="plan.variables.length" label="Godkänn och fortsätt" icon="i-lucide-shield-check" size="sm" :disabled="!canGrant" @click="grant" />
      </template>
    </template>
    <p v-else-if="!state.loading && status" class="text-xs text-muted">En verifierad startplan saknas ännu. Inget kan godkännas.</p>
    <div class="flex flex-wrap gap-1.5">
      <UButton label="Öppna Vault" icon="i-lucide-key-round" color="neutral" variant="soft" size="sm" @click="vault.open(workspaceId, setupJobId)" />
      <UButton label="Hämta aktuell status" icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="sm" :loading="state.loading" @click="refresh" />
    </div>
  </section>
</template>
