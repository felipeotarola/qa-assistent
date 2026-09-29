<script setup lang="ts">
import type { DiagramContent } from '#shared/diagram';
const model = defineModel<DiagramContent>({ required: true });
const newId = () => crypto.randomUUID();
const nodes = computed(() => model.value.nodes.map(node => ({ label: node.label || node.id, value: node.id })));
function removeNode(id: string) {
  model.value.nodes = model.value.nodes.filter(node => node.id !== id);
  model.value.edges = model.value.edges.filter(edge => edge.source !== id && edge.target !== id);
}
</script>
<template>
  <div class="space-y-4">
    <UTextarea v-model="model.summary" aria-label="Diagrammets beskrivning" placeholder="Vad visar diagrammet? Vad är fortfarande okänt?" class="w-full" autoresize />
    <USelect v-model="model.direction" :items="[{ label: 'Vänster till höger', value: 'LR' }, { label: 'Uppifrån och ned', value: 'TB' }]" aria-label="Diagrammets riktning" />
    <h3 class="font-semibold">Sidor / noder</h3>
    <div v-for="(node, index) in model.nodes" :key="node.id" class="space-y-2 rounded-lg border border-default p-3">
      <div class="flex gap-2"><UInput v-model="node.label" :aria-label="`Namn på nod ${index + 1}`" placeholder="Namn" class="flex-1" /><UButton icon="i-lucide-trash-2" aria-label="Ta bort nod och dess samband" variant="ghost" color="neutral" @click="removeNode(node.id)" /></div>
      <UInput v-model="node.category" aria-label="Kategori" placeholder="Kategori" class="w-full" />
      <UInput v-model="node.url" aria-label="Sidans URL" placeholder="https://… (valfritt)" class="w-full" />
      <UTextarea v-model="node.description" aria-label="Nodens beskrivning" placeholder="Beskrivning" class="w-full" />
    </div>
    <UButton label="Lägg till nod" icon="i-lucide-plus" variant="soft" :disabled="model.nodes.length >= 150" @click="model.nodes.push({ id: newId(), label: 'Ny sida', category: 'Sida', url: '', description: '' })" />
    <h3 class="font-semibold">Samband</h3>
    <div v-for="edge in model.edges" :key="edge.id" class="space-y-2 rounded-lg border border-default p-3">
      <div class="flex flex-wrap gap-2"><USelect v-model="edge.source" :items="nodes" aria-label="Från nod" /><USelect v-model="edge.target" :items="nodes" aria-label="Till nod" /><UButton icon="i-lucide-trash-2" aria-label="Ta bort samband" variant="ghost" color="neutral" @click="model.edges = model.edges.filter(e => e.id !== edge.id)" /></div>
      <UInput v-model="edge.label" aria-label="Sambandets etikett" placeholder="Exempelvis: länkar till" class="w-full" />
      <USelect v-model="edge.status" :items="[{ label: 'Antaget', value: 'inferred' }, { label: 'Verifierat', value: 'verified' }]" aria-label="Sambandets verifiering" />
      <UTextarea v-model="edge.evidence" aria-label="Underlag för sambandet" placeholder="Källa eller observation (krävs för verifierat samband)" class="w-full" />
    </div>
    <UButton label="Lägg till samband" icon="i-lucide-plus" variant="soft" :disabled="model.nodes.length < 2 || model.edges.length >= 400" @click="model.edges.push({ id: newId(), source: model.nodes[0]!.id, target: model.nodes[1]!.id, label: '', status: 'inferred', evidence: '' })" />
  </div>
</template>
