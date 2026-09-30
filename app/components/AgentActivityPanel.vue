<script setup lang="ts">
import type { ActivityStep } from '#shared/agent-activity';
import type { WorkspaceItem } from '#shared/workspace';
import AgentActivitySurface from './AgentActivitySurface.vue';

const { snapshot, open, requestedItem } = useAgentActivity();
const pinned = useCookie<boolean>('agent-activity-pinned', { default: () => false, sameSite: 'lax' });
const wide = ref(false);
onMounted(() => {
  const media = window.matchMedia('(min-width: 1280px)');
  const sync = () => { wide.value = media.matches; };
  sync(); media.addEventListener('change', sync);
  onBeforeUnmount(() => media.removeEventListener('change', sync));
});
const docked = computed(() => pinned.value && wide.value && !!snapshot.value);
const drawerOpen = computed({ get: () => open.value && !docked.value, set: value => { open.value = value; } });
function togglePin() { pinned.value = !pinned.value; open.value = true; }
const section = ref('activity');
const labels = { working: 'Pågår', waiting: 'Väntar på dig', done: 'Utfört', error: 'Verktygsfel', unconfirmed: 'Ej bekräftat' };
const icons = { working: 'i-lucide-loader-circle', waiting: 'i-lucide-message-circle-question', done: 'i-lucide-check', error: 'i-lucide-circle-alert', unconfirmed: 'i-lucide-circle-help' };
const color = (status: ActivityStep['status']) => status === 'error' ? 'error' : status === 'waiting' || status === 'unconfirmed' ? 'warning' : status === 'done' ? 'success' : 'info';
const saved = useState<Record<string, WorkspaceItem>>('activity-saved-texts', () => ({}));
const saving = ref<string>();
const saveError = ref('');
const draft = ref<{ id: string; text: string; title: string; threadId: string; workspaceId: string }>();
const current = computed(() => snapshot.value?.steps.findLast(step => step.status === 'working' || step.status === 'waiting'));
const heading = computed(() => snapshot.value?.failed ? 'Behöver uppmärksamhet' : current.value?.status === 'waiting' ? 'Väntar på dig' : snapshot.value?.busy ? 'Agenten arbetar' : 'Senaste arbete');
const results = computed(() => [...new Map(snapshot.value?.steps.flatMap(step => step.item ? [[step.item.id, step.item] as const] : []) ?? []).values()]);
function showItem(id: string) {
  if (!snapshot.value?.workspaceId) return;
  requestedItem.value = { workspaceId: snapshot.value.workspaceId, itemId: id };
  if (!docked.value) open.value = false;
}
function prepare(id: string, text: string) {
  if (!snapshot.value?.workspaceId) return;
  saveError.value = '';
  draft.value = { id, text, title: 'Anteckning från agenten', threadId: snapshot.value.threadId, workspaceId: snapshot.value.workspaceId };
}
async function save() {
  const value = draft.value;
  if (!value || saving.value) return;
  saving.value = value.id; saveError.value = '';
  try {
    const result = await $fetch<{ item: WorkspaceItem }>(`/api/workspaces/${value.workspaceId}/activity-material`, { method: 'POST', body: { threadId: value.threadId, sourceId: value.id, text: value.text, title: value.title } });
    saved.value[value.id] = result.item;
    draft.value = undefined;
  }
  catch { saveError.value = 'Sparandet kunde inte bekräftas. Försök igen; samma text skapar inte dubbla material.'; }
  finally { saving.value = undefined; }
}
watch(() => snapshot.value?.threadId, () => { draft.value = undefined; saveError.value = ''; });
</script>

<template>
  <div v-if="snapshot && !docked" class="fixed right-28 top-3 z-30">
    <UButton :icon="snapshot.busy ? 'i-lucide-loader-circle' : 'i-lucide-activity'" :label="heading" color="neutral" variant="soft" size="sm" :aria-expanded="drawerOpen" @click="open = !open" />
  </div>
  <AgentActivitySurface v-model:open="drawerOpen" :docked="docked" :can-pin="wide" @pin="togglePin">
      <div v-if="snapshot" class="space-y-6">
        <div class="rounded-lg border border-default bg-muted p-4 space-y-2" role="status">
          <div class="flex items-center gap-2 font-semibold">
            <UIcon :name="snapshot.busy ? 'i-lucide-loader-circle' : 'i-lucide-bot'" :class="snapshot.busy ? 'motion-safe:animate-spin' : ''" />
            {{ heading }}
          </div>
          <p class="text-sm text-muted">{{ current?.label ?? (snapshot.busy ? 'Bearbetar uppgiften…' : 'Se utförda steg och tillgängliga resultat nedan.') }}</p>
          <p class="text-xs text-dimmed">Huvudagent · {{ snapshot.steps.length }} verktygssteg</p>
        </div>
        <UAlert v-if="snapshot.failed" color="warning" variant="soft" title="Kontrollera chatten" description="Ett fel har rapporterats. Redan sparade resultat kan finnas kvar; kör inte om skrivningar utan att kontrollera dem." />
        <UTabs v-model="section" :items="[{ label: 'Aktivitet', value: 'activity', icon: 'i-lucide-list-checks' }, { label: 'Resultat', value: 'results', icon: 'i-lucide-files' }]" />
        <div v-if="section === 'activity'" class="space-y-3">
          <p class="text-xs text-muted">Utfört betyder att verktyget svarade. Testernas godkännande visas under Testning.</p>
          <p v-if="!snapshot.steps.length" class="text-sm text-muted">Inga verktygssteg i den här uppgiften ännu.</p>
          <ol class="space-y-3" aria-label="Agentens arbetssteg">
            <li v-for="step in snapshot.steps" :key="step.id" class="rounded-lg border border-default p-3">
              <div class="flex items-start gap-3">
                <UIcon :name="icons[step.status]" class="mt-0.5 size-4 shrink-0" :class="step.status === 'working' ? 'motion-safe:animate-spin' : ''" />
                <div class="min-w-0 space-y-2"><p class="text-sm font-medium break-words">{{ step.label }}</p><UBadge :color="color(step.status)" variant="soft" size="sm">{{ labels[step.status] }}</UBadge></div>
              </div>
            </li>
          </ol>
        </div>
        <div v-else class="space-y-4">
          <p class="text-sm text-muted">Sparade objekt öppnas på sin ordinarie plats. Text från chatten kan sparas som en anteckning i Material.</p>
          <div v-for="item in results" :key="item.id" class="rounded-lg border border-default p-4 space-y-3">
            <p class="text-sm font-semibold">{{ item.title }}</p>
            <WorkspaceImage v-if="item.kind === 'image' && snapshot.workspaceId" :workspace-id="snapshot.workspaceId" :image="{ kind: 'image', itemId: item.id, caption: item.title }" />
            <UBadge color="success" variant="soft">Sparat i workspace</UBadge>
            <UButton label="Visa objekt" icon="i-lucide-arrow-up-right" variant="ghost" @click="showItem(item.id)" />
          </div>
          <div v-for="text in snapshot.texts" :key="text.id" class="rounded-lg border border-default p-4 space-y-3">
            <details><summary class="cursor-pointer text-sm font-medium">{{ text.text.slice(0, 110) }}{{ text.text.length > 110 ? '…' : '' }}</summary><div class="mt-3 max-h-72 overflow-y-auto"><ChatComark :value="text.text" :streaming="false" /></div></details>
            <UButton v-if="saved[text.id]" label="Visa sparad anteckning" variant="soft" icon="i-lucide-check" @click="showItem(saved[text.id]!.id)" />
            <UButton v-else label="Spara till Material…" icon="i-lucide-bookmark-plus" variant="soft" :disabled="snapshot.busy || !snapshot.workspaceId" @click="prepare(text.id, text.text)" />
          </div>
          <p v-if="!results.length && !snapshot.texts.length" class="text-sm text-muted">Resultat visas här när de finns tillgängliga.</p>
          <p v-if="snapshot.busy" class="text-xs text-muted">Text kan sparas när agentens svar är färdigt.</p>
          <div v-if="draft" class="rounded-lg border border-default p-4 space-y-3">
            <UFormField label="Namn på anteckningen"><UInput v-model="draft.title" class="w-full" :maxlength="200" /></UFormField>
            <p class="text-xs text-muted">Sparar den valda texten med en länk till ursprungschatten. Detta ändrar inga testresultat.</p>
            <p v-if="saveError" role="alert" class="text-sm text-error">{{ saveError }}</p>
            <div class="flex gap-2"><UButton label="Spara anteckning" :loading="!!saving" :disabled="!draft.title.trim()" @click="save" /><UButton label="Avbryt" variant="ghost" :disabled="!!saving" @click="draft = undefined" /></div>
          </div>
        </div>
      </div>
      <p v-else class="text-sm text-muted">Öppna en chatt för att följa agentens arbete.</p>
  </AgentActivitySurface>
</template>
