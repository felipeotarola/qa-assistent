<script setup lang="ts">
import { agent } from '#shared/agent';
import { agentCapabilities } from '#shared/agent-capabilities';
import type { ConnectorState } from '#shared/types/connector';

useHead({ title: `Agenten · ${agent.name}` });
const selected = ref<string>('testing');
const capability = computed(() => agentCapabilities.find(item => item.id === selected.value) ?? agentCapabilities[0]);
const related = computed(() => agentCapabilities.filter(item => (capability.value.related as readonly string[]).includes(item.id)));
const { connectors, pending, error, refresh } = useConnectors();
const statuses: Record<ConnectorState, string> = { connected: 'Anslutet', not_connected: 'Inte anslutet', installation_required: 'Installation behövs', setup_required: 'Konfiguration behövs', error: 'Kunde inte kontrolleras' };
const mounted = ref(false);
onMounted(() => { mounted.value = true; });
const toast = useToast();
async function copyExample() {
  try { await navigator.clipboard.writeText(capability.value.example); toast.add({ title: 'Exempel kopierat', description: 'Klistra in det i en chatt i rätt workspace.', color: 'success' }); }
  catch { toast.add({ title: 'Kunde inte kopiera', description: 'Markera och kopiera exempeltexten manuellt.', color: 'error' }); }
}
</script>

<template>
  <UDashboardPanel id="agents" class="min-h-0" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header><AppNavbar embedded><template #title><h1 class="text-sm font-semibold">Agenten</h1></template></AppNavbar></template>
    <template #body>
      <div class="app-page space-y-6">
        <WorkspacePageHeader title="En agent. Flera sätt att hjälpa." description="Utforska hur agenten använder verktyg, underlag och integrationer — från första fråga till sparat testresultat.">
          <UButton to="/?view=workspaces" label="Öppna ett workspace" icon="i-lucide-arrow-up-right" variant="outline" color="neutral" />
        </WorkspacePageHeader>

        <section class="qaa-panel border border-default p-5 sm:p-6" aria-label="Agentens förmågor">
          <div class="agent-hub mx-auto flex max-w-lg items-center gap-4 rounded-xl border border-default bg-muted p-4">
            <div class="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary text-inverted"><UIcon :name="agent.avatar.icon" class="size-6" /></div>
            <div><h2 class="text-lg font-semibold">{{ agent.name }} · Din huvudagent</h2><p class="mt-1 text-sm text-muted">Du beskriver målet. Agenten använder förmågorna nedan och sammanhanget i ditt workspace.</p></div>
          </div>
          <div class="agent-branches grid grid-cols-1 gap-3 pt-8 sm:grid-cols-2 xl:grid-cols-3" role="group" aria-label="Välj förmåga">
            <UButton v-for="item in agentCapabilities" :key="item.id" :aria-pressed="selected === item.id" aria-controls="capability-detail" color="neutral" :variant="selected === item.id ? 'soft' : 'outline'" class="items-start justify-start gap-3 p-4 text-left" @click="selected = item.id">
              <UIcon :name="item.icon" class="mt-0.5 size-5 shrink-0 text-primary" />
              <span class="min-w-0"><span class="block font-semibold">{{ item.title }}</span><span class="mt-1 block text-xs font-normal leading-relaxed text-muted">{{ item.summary }}</span></span>
            </UButton>
          </div>
          <p class="mt-4 text-xs text-muted">Kartan beskriver agentens förmågor, inte pågående körningar eller separata specialistagenter.</p>
        </section>

        <div class="grid items-start gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <section id="capability-detail" class="qaa-panel min-w-0 border border-default p-5 sm:p-6" aria-labelledby="capability-title" aria-live="polite">
            <div class="flex items-center gap-3"><UIcon :name="capability.icon" class="size-6 text-primary" /><h2 id="capability-title" class="text-lg font-semibold">{{ capability.title }}</h2></div>
            <p class="mt-3 text-sm leading-relaxed text-muted">{{ capability.description }}</p>
            <div class="mt-5 rounded-lg border border-default bg-muted p-4"><h3 class="text-sm font-semibold">Det här behövs</h3><p class="mt-2 text-sm leading-relaxed text-muted">{{ capability.needs }}</p></div>
            <h3 class="mt-6 text-sm font-semibold">Så fungerar det</h3>
            <ol class="mt-3 space-y-4"><li v-for="(step, index) in capability.steps" :key="step" class="flex gap-3 text-sm leading-relaxed"><span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-elevated text-xs font-semibold text-primary">{{ index + 1 }}</span><span>{{ step }}</span></li></ol>
            <div class="mt-5 border-t border-default pt-5"><h3 class="text-sm font-semibold">Här hittar du resultatet</h3><p class="mt-2 text-sm leading-relaxed text-muted">{{ capability.result }}</p></div>
            <p class="mt-4 text-sm leading-relaxed text-muted">{{ capability.boundary }}</p>
            <div class="mt-5 rounded-lg border border-default p-4"><div class="flex flex-wrap items-center justify-between gap-2"><h3 class="text-sm font-semibold">Exempel att be agenten om</h3><UButton label="Kopiera exempel" icon="i-lucide-copy" size="sm" variant="ghost" color="neutral" @click="copyExample" /></div><p class="mt-2 text-sm leading-relaxed">{{ capability.example }}</p></div>
            <div class="mt-5 flex flex-wrap items-center gap-2"><span class="text-xs text-muted">Hänger ihop med</span><UButton v-for="item in related" :key="item.id" :label="item.title" :icon="item.icon" size="sm" variant="outline" color="neutral" @click="selected = item.id" /></div>
          </section>

          <div class="space-y-6">
            <section class="qaa-panel border border-default p-5 sm:p-6" aria-labelledby="connections-title">
              <div class="flex items-center justify-between gap-3"><h2 id="connections-title" class="text-lg font-semibold">Dina integrationer</h2><UButton icon="i-lucide-refresh-cw" aria-label="Uppdatera anslutningsstatus" variant="ghost" color="neutral" :loading="mounted && pending" @click="refresh()" /></div>
              <p class="mt-2 text-sm leading-relaxed text-muted">Personliga anslutningar för agentens åtkomst. Destination väljs separat i varje workspace.</p>
              <p v-if="!mounted || (!connectors && !error)" role="status" class="mt-4 text-sm text-muted">Kontrollerar anslutningar…</p>
              <UAlert v-else-if="error" class="mt-4" title="Anslutningsstatus kunde inte hämtas" description="Försök uppdatera igen. Ingen anslutning har ändrats." color="warning" variant="subtle" />
              <div v-else class="mt-4 divide-y divide-default">
                <div v-for="connector in connectors" :key="connector.id" class="flex flex-wrap items-center gap-3 py-4"><UIcon :name="connector.icon" class="size-5" /><span class="flex-1 font-semibold">{{ connector.name }}</span><UBadge :color="connector.status.state === 'connected' ? 'success' : 'neutral'" variant="soft">{{ statuses[connector.status.state] }}</UBadge></div>
                <p v-if="!connectors?.length" class="py-4 text-sm text-muted">Inga integrationer att visa.</p>
              </div>
              <UButton to="/settings/integrations" label="Hantera integrationer" trailing-icon="i-lucide-arrow-right" color="neutral" variant="outline" class="mt-4" />
            </section>
            <section class="qaa-panel border border-default p-5 sm:p-6"><h2 class="text-lg font-semibold">Samma sammanhang, rätt plats</h2><dl class="mt-4 space-y-4 text-sm"><div><dt class="font-semibold">Chatten</dt><dd class="mt-1 leading-relaxed text-muted">Ge uppdrag och följ agentens arbete. Modell och resonemang väljs här, även för uppgifter från materialkort.</dd></div><div><dt class="font-semibold">Workspacet</dt><dd class="mt-1 leading-relaxed text-muted">Material, krav och testresultat delas mellan dess chattar. Körningar sparas separat från testplanernas definitioner.</dd></div><div><dt class="font-semibold">Din profil och ditt minne</dt><dd class="mt-1 leading-relaxed text-muted">Personligt sammanhang som är separat från projektets underlag.</dd></div></dl><UButton to="/settings/profile" label="Öppna profil" variant="link" color="neutral" class="mt-4" /></section>
          </div>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>

<style scoped>
.agent-hub { position: relative; }
.agent-hub::after { content: ''; position: absolute; top: 100%; left: 50%; height: 24px; border-left: 1px solid var(--qaa-border-component); }
.agent-branches { position: relative; }
.agent-branches::before { content: ''; position: absolute; top: 23px; left: 12%; right: 12%; border-top: 1px solid var(--qaa-border-component); }
</style>
