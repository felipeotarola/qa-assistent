<script setup lang="ts">
import { VueFlow, Handle, Position, MarkerType, type VueFlowStore } from '@vue-flow/core';
import dagre from '@dagrejs/dagre';
import type { DiagramContent } from '#shared/diagram';
import { repositoryCodeUrl } from '#shared/diagram';
import type { WorkspaceItem } from '#shared/workspace';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';

const props = defineProps<{ diagram: DiagramContent; preview?: boolean; item?: WorkspaceItem }>();
const nodeId = ref('');
const node = computed(() => props.diagram.nodes.find(n => n.id === nodeId.value));
const agent = useWorkspaceAgent();
const sending = ref(false);
const notice = ref('');
const canAsk = computed(() => !!props.item && agent.value?.workspaceId === props.item.workspaceId && agent.value.available);
const focused = computed(() => new Set([nodeId.value, ...props.diagram.edges.filter(e => e.source === nodeId.value || e.target === nodeId.value).flatMap(e => [e.source, e.target])]));
async function suggestTests() {
  if (!canAsk.value || !node.value || sending.value) return;
  sending.value = true;
  try {
    const accepted = await agent.value!.ask(`Föreslå testfall för komponenten ${JSON.stringify({ id: node.value.id, label: node.value.label })} i repokartan ${props.item!.id}, visad version ${props.item!.version}, vid commit ${props.diagram.repository?.commit}. Läs kartan och dess kodunderlag först. Skilj antaganden från observerad kod. Visa högst fem prioriterade fall med förväntat resultat och förutsättningar i chatten. Detta är bara förslag: ändra inte diagrammet, skapa inga sparade objekt, kör inga tester och publicera inget.`);
    notice.value = accepted ? 'Skickat till chatten.' : 'Kontrollera chatten innan du försöker igen.';
  } catch { notice.value = 'Kunde inte bekräfta uppgiften. Kontrollera chatten.'; }
  finally { sending.value = false; }
}
const selected = ref('');
const summaryOpen = ref(false);
const flow = shallowRef<VueFlowStore>();
const selectedEdge = computed(() => props.diagram.edges.find(edge => edge.id === selected.value));
const graph = computed(() => {
  const layout = new dagre.graphlib.Graph().setGraph({ rankdir: props.diagram.direction, nodesep: 35, ranksep: 85 }).setDefaultEdgeLabel(() => ({}));
  props.diagram.nodes.forEach(node => layout.setNode(node.id, { width: 230, height: 110 }));
  props.diagram.edges.forEach(edge => layout.setEdge(edge.source, edge.target));
  dagre.layout(layout);
  return props.diagram.nodes.map(node => {
    const point = layout.node(node.id);
    return { id: node.id, type: 'page', position: { x: point.x - 115, y: point.y - 55 }, data: node, style: { opacity: nodeId.value && !focused.value.has(node.id) ? 0.3 : 1 } };
  });
});
const edges = computed(() => props.diagram.edges.map(edge => ({
  ...edge, type: 'smoothstep', markerEnd: MarkerType.ArrowClosed,
  style: { opacity: nodeId.value && edge.source !== nodeId.value && edge.target !== nodeId.value ? 0.2 : 1, stroke: edge.status === 'verified' ? 'var(--ui-primary)' : 'var(--ui-warning)', strokeDasharray: edge.status === 'inferred' ? '6 4' : undefined },
  labelStyle: { fill: 'var(--ui-text)' }, labelBgStyle: { fill: 'var(--ui-bg)' },
})));
</script>

<template>
  <div class="space-y-3">
    <div v-if="diagram.repository" class="flex flex-wrap items-center gap-2 text-xs text-muted">
      <UIcon name="i-lucide-git-branch" /><span>{{ diagram.repository.url.replace('https://github.com/', '') }}</span>
      <a :href="`${diagram.repository.url}/tree/${diagram.repository.commit}`" target="_blank" rel="noopener noreferrer" class="underline">Commit {{ diagram.repository.commit.slice(0, 8) }}</a>
      <span>Kodanalys · inte funktionstest</span>
    </div>
    <UCollapsible v-if="!preview && diagram.summary" v-model:open="summaryOpen" class="rounded-xl border border-default bg-default p-3">
      <UButton label="Om diagrammet & avgränsningar" icon="i-lucide-info" trailing-icon="i-lucide-chevron-down" color="neutral" variant="ghost" class="w-full justify-between" />
      <template #content><div class="readable-content break-words p-3 text-sm leading-relaxed text-muted"><ChatComark :value="diagram.summary.replace(/\s+(?=\(\d+\))/g, '\n\n')" /></div></template>
    </UCollapsible>
    <div v-if="!diagram.nodes.length" class="rounded-xl border border-dashed border-default p-8 text-center text-muted">
      <UIcon name="i-lucide-workflow" class="mb-2 size-8" />
      <p>Lägg till sidor i Redigera eller be agenten skapa ett diagram från ert material.</p>
    </div>
    <div v-else class="diagram-canvas overflow-hidden rounded-xl border border-default bg-muted" :class="preview ? 'h-52' : 'h-[clamp(20rem,55dvh,52rem)]'">
      <VueFlow :key="String(preview)" :nodes="graph" :edges="edges" fit-view-on-init :nodes-draggable="false" :nodes-connectable="false" :min-zoom="0.08" :max-zoom="2" :zoom-on-scroll="false" @init="flow = $event" @edge-click="selected = $event.edge.id">
        <template #node-page="{ data }">
          <div class="h-[110px] w-[230px] rounded-xl border border-default bg-default p-3 shadow-sm">
            <Handle type="target" :position="diagram.direction === 'LR' ? Position.Left : Position.Top" />
            <div class="mb-1 flex items-center gap-2 text-xs text-primary"><UIcon name="i-lucide-file" />{{ data.category }}</div>
            <button class="nodrag nopan line-clamp-2 text-left font-semibold text-highlighted focus-visible:outline-2 focus-visible:outline-primary" :title="data.description || data.label" :aria-pressed="nodeId === data.id" @click="nodeId = nodeId === data.id ? '' : data.id">{{ data.label }}</button>
            <a v-if="data.url" :href="data.url" target="_blank" rel="noopener noreferrer" class="nodrag nopan mt-1 block truncate text-xs text-muted underline" :title="data.url">{{ data.url }}</a>
            <Handle type="source" :position="diagram.direction === 'LR' ? Position.Right : Position.Bottom" />
          </div>
        </template>
        <template #default>
          <div class="absolute bottom-3 left-3 z-10 flex gap-1 rounded-lg border border-default bg-default p-1">
            <UButton icon="i-lucide-minus" aria-label="Zooma ut" color="neutral" variant="ghost" @click="flow?.zoomOut()" />
            <UButton icon="i-lucide-plus" aria-label="Zooma in" color="neutral" variant="ghost" @click="flow?.zoomIn()" />
            <UButton icon="i-lucide-maximize" aria-label="Visa hela diagrammet" color="neutral" variant="ghost" @click="flow?.fitView({ padding: 0.15 })" />
          </div>
        </template>
      </VueFlow>
    </div>
    <div class="flex flex-wrap gap-3 text-xs text-muted"><span>{{ diagram.nodes.length }} noder · {{ diagram.edges.length }} samband</span><span class="text-primary">— {{ diagram.repository ? 'Kodunderlag angivet' : 'Verifierat' }}</span><span class="text-warning">┄ Antaget</span></div>
    <template v-if="!preview">
      <div class="flex gap-2">
        <USelect v-model="nodeId" :items="diagram.nodes.map(n => ({ label: n.label, value: n.id }))" placeholder="Utforska en komponent…" aria-label="Välj komponent" class="min-w-0 flex-1" />
        <UButton v-if="nodeId" label="Visa alla" variant="ghost" color="neutral" @click="nodeId = ''" />
      </div>
      <section v-if="node" aria-label="Komponentdetaljer" class="space-y-3 rounded-xl border border-default p-4">
        <h3 class="font-semibold">{{ node.label }}</h3>
        <p class="whitespace-pre-wrap text-sm text-muted">{{ node.description || 'Beskrivning saknas.' }}</p>
        <ul v-if="diagram.repository && node.code?.length" class="space-y-2 text-sm">
          <li v-for="ref in node.code" :key="`${ref.path}:${ref.line}`"><a :href="repositoryCodeUrl(diagram.repository, ref)" target="_blank" rel="noopener noreferrer" class="break-all underline">{{ ref.path }}{{ ref.line ? `:${ref.line}` : '' }}</a></li>
        </ul>
        <p v-else-if="diagram.repository" class="text-sm text-muted">Kodreferenser saknas för denna komponent.</p>
        <UButton v-if="diagram.repository" label="Föreslå tester" icon="i-lucide-list-checks" :disabled="!canAsk || sending" :loading="sending" @click="suggestTests" />
        <p v-if="diagram.repository" aria-live="polite" class="text-xs text-muted">{{ sending ? 'Skickar till chatten…' : notice || (!agent ? 'Öppna en chatt i detta workspace för att föreslå tester.' : !canAsk ? 'Vänta tills chatten är redo.' : 'Förslagen visas i chatten. Inga tester startas.') }}</p>
      </section>
      <USelect v-model="selected" :items="diagram.edges.map(edge => ({ label: `${diagram.nodes.find(n => n.id === edge.source)?.label} → ${diagram.nodes.find(n => n.id === edge.target)?.label}`, value: edge.id }))" placeholder="Granska ett samband…" aria-label="Granska samband och källa" class="w-full" />
      <div v-if="selectedEdge" class="rounded-lg border border-default p-3 text-sm">
        <UBadge :color="selectedEdge.status === 'verified' ? 'primary' : 'warning'" variant="soft">{{ selectedEdge.status === 'verified' ? (diagram.repository ? 'Kodunderlag angivet' : 'Verifierat samband') : 'Antaget samband' }}</UBadge>
        <p class="mt-2 font-medium">{{ selectedEdge.label }}</p>
        <p class="whitespace-pre-wrap text-muted">{{ selectedEdge.evidence || 'Ingen verifierad källa. Be agenten undersöka sambandet.' }}</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.diagram-canvas :deep(.vue-flow__edge.selected path) { stroke-width: 3; }
.diagram-canvas :deep(.vue-flow__handle) { background: var(--ui-primary); border-color: var(--ui-bg); }
</style>
