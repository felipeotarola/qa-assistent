<script setup lang="ts">
import { agent } from '#shared/agent';
import { isAgentRole } from '#shared/agent-identities';
import { vpsToolGuides } from '#shared/vps-tool-guides';
import AgentAvatar from '~/components/AgentAvatar.vue';
import { agentCapabilities, mainAgentGuide } from '#shared/agent-capabilities';
import type { ConnectorState } from '#shared/types/connector';

useHead({ title: `Agenten · ${agent.name}` });
const selected = ref<string>('main');
const guides = [...agentCapabilities, ...vpsToolGuides];
const capability = computed(() => selected.value === 'main' ? mainAgentGuide : guides.find(item => item.id === selected.value) ?? mainAgentGuide);
const related = computed(() => guides.filter(item => (capability.value.related as readonly string[]).includes(item.id)));
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
        <WorkspacePageHeader title="Dina agenter och deras verktyg" description="Huvudagenten samordnar, Iris testar i webbläsaren och Axel arbetar med kod. Otto sköter VPS-miljön och Klara granskar underlaget från sparade testkörningar.">
          <UButton to="/?view=workspaces" label="Öppna ett workspace" icon="i-lucide-arrow-up-right" variant="outline" color="neutral" />
        </WorkspacePageHeader>

        <AgentTeamMap v-model="selected">
          <section id="capability-detail" class="min-w-0 p-5" aria-labelledby="capability-title" aria-live="polite">
            <div class="flex items-center gap-3"><AgentAvatar v-if="isAgentRole(selected)" :role="selected" class="size-16" /><UIcon v-else :name="capability.icon" class="size-6 text-primary" /><h2 id="capability-title" class="text-lg font-semibold">{{ capability.title }}</h2></div>
            <p class="mt-3 text-sm leading-relaxed text-muted">{{ capability.description }}</p>
            <div class="mt-5 rounded-lg border border-default bg-muted p-4"><h3 class="text-sm font-semibold">Det här behövs</h3><p class="mt-2 text-sm leading-relaxed text-muted">{{ capability.needs }}</p></div>
            <section v-if="selected === 'vps'" class="mt-5 space-y-2" aria-label="Ottos VPS-verktyg">
              <h3 class="text-sm font-semibold">Verktyg i arbetsmiljön</h3>
              <UButton v-for="tool in vpsToolGuides" :key="tool.id" :label="tool.title" :icon="tool.icon" color="neutral" variant="outline" block @click="selected = tool.id" />
            </section>
            <h3 class="mt-6 text-sm font-semibold">Så fungerar det</h3>
            <ol class="mt-3 space-y-4"><li v-for="(step, index) in capability.steps" :key="step" class="flex gap-3 text-sm leading-relaxed"><span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-elevated text-xs font-semibold text-primary">{{ index + 1 }}</span><span>{{ step }}</span></li></ol>
            <div class="mt-5 border-t border-default pt-5"><h3 class="text-sm font-semibold">Här hittar du resultatet</h3><p class="mt-2 text-sm leading-relaxed text-muted">{{ capability.result }}</p></div>
            <p class="mt-4 text-sm leading-relaxed text-muted">{{ capability.boundary }}</p>
            <div class="mt-5 rounded-lg border border-default p-4"><div class="flex flex-wrap items-center justify-between gap-2"><h3 class="text-sm font-semibold">Exempel att be agenten om</h3><UButton label="Kopiera exempel" icon="i-lucide-copy" size="sm" variant="ghost" color="neutral" @click="copyExample" /></div><p class="mt-2 text-sm leading-relaxed">{{ capability.example }}</p></div>
            <div class="mt-5 flex flex-wrap items-center gap-2"><span class="text-xs text-muted">Hänger ihop med</span><UButton v-for="item in related" :key="item.id" :label="item.title" :icon="item.icon" size="sm" variant="outline" color="neutral" @click="selected = item.id" /></div>
          </section>

        </AgentTeamMap>

        <div class="grid items-start gap-6 lg:grid-cols-2">
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
    </template>
  </UDashboardPanel>
</template>
