<script setup lang="ts">
import { VueFlow, Handle, Position, MarkerType, type VueFlowStore } from '@vue-flow/core';
import AgentAvatar from './AgentAvatar.vue';
import { agentCapabilities, mainAgentGuide } from '#shared/agent-capabilities';
import { agentIdentities, isAgentRole } from '#shared/agent-identities';
import { vpsToolGuides } from '#shared/vps-tool-guides';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';

const selected = defineModel<string>({ required: true });
const open = ref(true);
const paused = ref(false);
const media = window.matchMedia('(prefers-reduced-motion: reduce)');
const reducedMotion = ref(media.matches);
const updateMotion = () => { reducedMotion.value = media.matches; };
onMounted(() => media.addEventListener('change', updateMotion));
onBeforeUnmount(() => media.removeEventListener('change', updateMotion));
const moving = computed(() => !paused.value && !reducedMotion.value);
const flow = shallowRef<VueFlowStore>();
const canvas = ref<HTMLElement>();
let resizeObserver: ResizeObserver | undefined;
let fitFrame = 0;
onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => { void flow.value?.fitView({ padding: 0.15 }); });
  });
  if (canvas.value) resizeObserver.observe(canvas.value);
});
onBeforeUnmount(() => { resizeObserver?.disconnect(); cancelAnimationFrame(fitFrame); });
const entries = [mainAgentGuide, ...agentCapabilities, ...vpsToolGuides];
const nodeTitle = (id: string, title: string) => isAgentRole(id) ? agentIdentities[id].name : title;
const vpsView = computed(() => selected.value === 'vps' || selected.value.startsWith('vps-'));
const positions: Record<string, { x: number; y: number }> = {
  main: { x: 300, y: 0 }, repository: { x: 600, y: 190 },
  browser: { x: 0, y: 190 }, testing: { x: 300, y: 190 },
  research: { x: 0, y: 390 }, reviewer: { x: 300, y: 390 }, requirements: { x: 0, y: 590 },
  vps: { x: 600, y: 390 }, integrations: { x: 600, y: 590 }, material: { x: 300, y: 790 },
};
const toolPositions: Record<string, { x: number; y: number }> = { vps: { x: 300, y: 0 } };
vpsToolGuides.forEach((tool, index) => { toolPositions[tool.id] = index === 4 ? { x: 300, y: 670 } : { x: (index % 2) * 600, y: 240 + Math.floor(index / 2) * 220 }; });
const nodes = computed(() => entries.filter(entry => vpsView.value ? entry.id === 'vps' || entry.id.startsWith('vps-') : !entry.id.startsWith('vps-')).map((entry, index) => ({ id: entry.id, type: 'guide', position: (vpsView.value ? toolPositions : positions)[entry.id]!, data: { ...entry, index } })));
const connections = [
  ['main', 'browser', 'Delegerar i bakgrunden'], ['main', 'testing', 'Planerar & verifierar'], ['main', 'repository', 'Delegerar vid behov'],
  ['browser', 'research', 'Samlar underlag'], ['testing', 'reviewer', 'Sparade körningar'],
  ['repository', 'vps', 'Arbete i sandlådan'], ['repository', 'integrations', 'Kod & ärenden'], ['research', 'material', 'Källor'],
  ['requirements', 'reviewer', 'Ursprungliga krav'], ['reviewer', 'material', 'Läser underlag'], ['integrations', 'material', 'Spårbara länkar'],
];
const edges = computed(() => (vpsView.value ? vpsToolGuides.map(tool => ['vps', tool.id, '']) : connections).map(([source, target, label]) => ({
  id: `${source}-${target}`, source: source!, target: target!, label,
  ...(source === 'requirements' && target === 'reviewer' ? { sourceHandle: 'review-input', targetHandle: 'requirements' } : {}),
  ...(source === 'repository' && target === 'integrations' ? { sourceHandle: 'integrations', targetHandle: 'repository' } : {}),
  type: 'smoothstep', animated: moving.value, markerEnd: MarkerType.ArrowClosed,
  style: { stroke: 'var(--ui-primary)', opacity: source === selected.value || target === selected.value ? 0.9 : 0.35 },
  labelStyle: { fill: 'var(--ui-text-muted)', fontSize: 11 }, labelBgStyle: { fill: 'var(--ui-bg)' },
})));
function choose(id: string) {
  selected.value = id;
  open.value = true;
  if (window.matchMedia('(max-width: 1279px)').matches) {
    nextTick(() => document.getElementById('agent-map-detail')?.scrollIntoView({ block: 'nearest', behavior: moving.value ? 'smooth' : 'instant' }));
  }
}
function close() {
  open.value = false;
  nextTick(() => document.getElementById(`agent-node-${selected.value}`)?.focus());
}
</script>

<template>
  <section class="team-map qaa-panel overflow-hidden border border-default" :class="{ 'motion-paused': !moving }" aria-label="Agenternas samarbete">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-default px-4 py-3 sm:px-5">
      <div><h2 class="text-sm font-semibold">Från uppdrag till resultat</h2><p class="mt-1 text-xs text-muted">Interaktiv guide · rörelsen illustrerar samband, inte liveaktivitet</p></div>
      <div class="flex flex-wrap gap-2">
        <UButton v-if="vpsView" label="Visa hela teamet" icon="i-lucide-arrow-left" color="neutral" variant="outline" @click="choose('main')" />
        <USelect :model-value="selected" :items="entries.map(item => ({ label: item.title, value: item.id }))" aria-label="Visa agent eller förmåga" class="w-52" @update:model-value="choose($event)" />
        <UButton :icon="moving ? 'i-lucide-pause' : 'i-lucide-play'" :label="reducedMotion ? 'Minskad rörelse' : moving ? 'Pausa rörelse' : 'Starta rörelse'" :disabled="reducedMotion" :aria-pressed="!moving" color="neutral" variant="outline" @click="paused = !paused" />
      </div>
    </div>
    <div class="team-map-body grid" :class="open ? 'xl:grid-cols-[minmax(0,1fr)_24rem]' : 'grid-cols-1'">
      <div ref="canvas" class="team-canvas relative min-w-0" aria-label="Panorera och zooma agentkartan">
        <VueFlow :key="vpsView ? 'vps' : 'team'" :nodes="nodes" :edges="edges" fit-view-on-init :nodes-draggable="false" :nodes-connectable="false" :elements-selectable="false" :min-zoom="0.3" :max-zoom="1.6" :zoom-on-scroll="true" @init="flow = $event" @node-click="choose($event.node.id)">
          <template #node-guide="{ data }">
            <div class="node-reveal" :style="{ '--entrance-delay': `${data.index * 60}ms` }">
              <Handle type="target" :position="data.id.startsWith('vps-') && data.id !== 'vps-environment' ? toolPositions[data.id]?.x === 0 ? Position.Right : Position.Left : Position.Top" />
              <Handle v-if="data.id === 'reviewer'" id="requirements" type="target" :position="Position.Left" />
              <Handle v-if="data.id === 'integrations'" id="repository" type="target" :position="Position.Right" />
              <button :id="`agent-node-${data.id}`" type="button" class="team-node nodrag nopan text-left" :class="{ 'is-selected': selected === data.id && open, 'is-agent': isAgentRole(data.id) }" :aria-pressed="selected === data.id && open" aria-controls="agent-map-detail" @click.stop="choose(data.id)">
                <span class="mb-3 flex items-center justify-between gap-3"><AgentAvatar v-if="isAgentRole(data.id)" :role="data.id" class="size-14" /><span v-else class="flex size-10 items-center justify-center rounded-xl bg-elevated text-primary"><UIcon :name="data.icon" class="size-5" /></span><span class="text-[10px] font-medium uppercase tracking-wider text-muted">{{ data.id === 'main' ? 'Orkestrator' : isAgentRole(data.id) ? 'Specialist' : data.id.startsWith('vps-') ? 'VPS-verktyg' : 'Förmåga' }}</span></span>
                <span class="block text-sm font-semibold text-highlighted">{{ nodeTitle(data.id, data.title) }}</span>
                <span class="mt-1 block text-xs leading-relaxed text-muted">{{ data.summary }}</span>
                <span v-if="data.id === 'vps' && !vpsView" class="mt-2 block text-xs font-medium text-primary">Visa 5 VPS-verktyg →</span>
              </button>
              <Handle type="source" :position="Position.Bottom" />
              <Handle v-if="data.id === 'requirements'" id="review-input" type="source" :position="Position.Right" />
              <Handle v-if="data.id === 'repository'" id="integrations" type="source" :position="Position.Right" />
            </div>
          </template>
        </VueFlow>
        <div class="absolute bottom-4 left-4 z-10 flex gap-1 rounded-xl border border-default bg-default p-1 shadow-sm">
          <UButton icon="i-lucide-minus" aria-label="Zooma ut" color="neutral" variant="ghost" @click="flow?.zoomOut()" />
          <UButton icon="i-lucide-plus" aria-label="Zooma in" color="neutral" variant="ghost" @click="flow?.zoomIn()" />
          <UButton icon="i-lucide-maximize" aria-label="Visa hela agentkartan" color="neutral" variant="ghost" @click="flow?.fitView({ padding: 0.15 })" />
        </div>
      </div>
      <Transition name="agent-detail">
        <aside v-if="open" id="agent-map-detail" :key="selected" class="team-detail min-w-0 overflow-y-auto border-t border-default bg-default xl:border-t-0 xl:border-l" aria-label="Vald agent eller förmåga" @keydown.esc="close">
          <div class="sticky top-0 z-10 flex items-center justify-between border-b border-default bg-default px-5 py-3"><span class="text-xs font-medium uppercase tracking-wider text-muted">{{ selected === 'main' ? 'Huvudagent' : selected === 'repository' ? 'Repo-specialist' : selected === 'browser' ? 'Webbläsarspecialist' : selected === 'vps' ? 'VPS-specialist' : selected === 'reviewer' ? 'Resultatgranskning' : 'Verktyg & förmågor' }}</span><UButton icon="i-lucide-x" aria-label="Stäng detaljer" color="neutral" variant="ghost" @click="close" /></div>
          <slot />
        </aside>
      </Transition>
    </div>
  </section>
</template>

<style scoped>
.team-canvas { height: clamp(32rem, 72dvh, 58rem); background-image: radial-gradient(var(--ui-border-accented) 1px, transparent 1px); background-size: 20px 20px; }
.team-detail { max-height: 46rem; }
.team-node { width: 240px; min-height: 140px; padding: 18px; border: 1px solid var(--ui-border-accented); border-radius: 16px; background: var(--ui-bg); box-shadow: 0 4px 16px color-mix(in srgb, var(--ui-primary) 6%, transparent); cursor: pointer; transition: box-shadow 180ms, border-color 180ms; }
.team-node:hover, .team-node:focus-visible, .team-node.is-selected { border-color: var(--ui-primary); outline: 2px solid color-mix(in srgb, var(--ui-primary) 25%, transparent); outline-offset: 3px; box-shadow: 0 8px 28px color-mix(in srgb, var(--ui-primary) 14%, transparent); }
.node-reveal { animation: node-entrance 500ms both; animation-delay: var(--entrance-delay); }
.team-map :deep(.vue-flow__handle) { background: var(--ui-primary); border-color: var(--ui-bg); }
.team-map :deep(.vue-flow__edge-path) { stroke-width: 1.5; }
.team-map :deep(.vue-flow__edge.animated path) { animation-duration: 2s; }
.agent-detail-enter-active { transition: opacity 220ms, transform 220ms; }
.agent-detail-leave-active { display: none; }
.agent-detail-enter-from { opacity: 0; transform: translateX(20px); }
@keyframes node-entrance { from { opacity: 0; transform: translateY(12px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
.motion-paused .node-reveal { animation: none; }
@media (min-width: 1280px) { .team-detail { max-height: clamp(32rem, 72dvh, 58rem); } }
@media (prefers-reduced-motion: reduce) { .node-reveal, .team-map :deep(.vue-flow__edge.animated path) { animation: none !important; } .agent-detail-enter-active, .team-node { transition: none; } }
</style>
