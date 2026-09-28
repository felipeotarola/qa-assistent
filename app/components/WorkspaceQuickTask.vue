<script setup lang="ts">
import type { WorkspaceItem, EditableContent } from "#shared/workspace";
import WorkspaceContent from './WorkspaceContent.vue';
const props = defineProps<{ item: WorkspaceItem; disabled?: boolean }>();
const agent = useWorkspaceAgent();
const drafts = useState<Record<string, string>>("workspace-card-drafts", () => ({}));
const text = computed({ get: () => drafts.value[props.item.id] ?? "", set: value => { drafts.value[props.item.id] = value; } });
const sending = ref(false);
const notice = ref("");
const quick = computed(() => ['text', 'table'].includes(props.item.content.kind));
const proposal = ref<{ summary: string; question: string; content: EditableContent | null; version: number; title: string }>();
const preview = ref(false);
const available = computed(() => !props.disabled && (quick.value || (agent.value?.workspaceId === props.item.workspaceId && agent.value.available)));
async function apply() {
  if (!proposal.value?.content || props.disabled) return;
  sending.value = true;
  try {
    await $fetch(`/api/workspaces/${props.item.workspaceId}/items/${props.item.id}`, { method: 'PATCH', body: { title: proposal.value.title, content: proposal.value.content, expectedVersion: proposal.value.version } });
    notice.value = 'Ändringen är sparad. Tidigare version finns i Historik.';
    proposal.value = undefined; preview.value = false; text.value = '';
  } catch { notice.value = 'Kunde inte bekräfta sparandet. Kontrollera aktuell version och Historik innan du försöker igen.'; }
  finally { sending.value = false; }
}
async function submit() {
  if (!available.value || sending.value || !text.value.trim()) return;
  sending.value = true; notice.value = "";
  const task = text.value;
  try {
    if (quick.value) {
      proposal.value = await $fetch(`/api/workspaces/${props.item.workspaceId}/items/${props.item.id}/quick-edit`, { method: 'POST', body: { text: task, expectedVersion: props.item.version } });
      notice.value = proposal.value!.question || 'Ändringen är klar att granska. Inget har sparats ännu.';
      preview.value = !!proposal.value!.content;
      return;
    }
    const accepted = await agent.value!.run(props.item, task);
    if (accepted) {
      if (text.value === task) text.value = "";
      notice.value = "Skickat till chatten. Följ svaret där.";
    } else notice.value = "Kontrollera chatten innan du skickar igen. Texten finns kvar.";
  } catch (cause) { notice.value = (cause as { data?: { statusMessage?: string } }).data?.statusMessage || "Kunde inte bekräfta uppgiften. Kontrollera chatten innan du försöker igen."; }
  finally { sending.value = false; }
}
</script>
<template>
  <form class="border-b border-default/70 p-3" @submit.prevent="submit">
    <label :for="`task-${item.id}`" class="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted"><UIcon name="i-lucide-sparkles" class="size-3.5" /> Be agenten ändra</label>
    <div class="flex items-center gap-2">
      <UInput :id="`task-${item.id}`" v-model="text" class="min-w-0 flex-1" :maxlength="4000" :placeholder="item.content.kind === 'test_plan' ? 'Ändra testplanen…' : item.content.kind === 'table' ? 'Lägg till i tabellen…' : 'Lägg till i dokumentet…'" :disabled="sending || disabled" />
      <UButton type="submit" icon="i-lucide-arrow-up" aria-label="Skicka uppgift till agenten" :loading="sending" :disabled="!available || !text.trim() || sending" />
    </div>
    <p class="mt-2 text-[11px] text-muted" aria-live="polite">{{ notice || (disabled ? 'Spara eller avbryt redigeringen först.' : quick ? 'Snabbändring · Flash · låg reasoning · endast detta objekt.' : !agent ? 'Öppna en chatt i detta workspace för att skicka.' : !available ? 'Vänta tills chatten är redo.' : 'Använder chatten och vald modell.') }}</p>
    <UButton v-if="proposal?.content" label="Granska ändringen" color="neutral" variant="link" @click="preview = true" />
  </form>
  <UModal v-model:open="preview" title="Granska snabbändringen" description="Kontrollera resultatet innan det ersätter den aktuella versionen." :ui="{ content: 'max-w-4xl' }">
    <template #body><p class="mb-4 text-sm">{{ proposal?.summary }}</p><WorkspaceContent v-if="proposal?.content" :content="proposal.content" :workspace-id="item.workspaceId" /></template>
    <template #footer><UButton label="Spara ändringen" :loading="sending" :disabled="disabled || proposal?.version !== item.version" @click="apply" /><UButton color="neutral" variant="ghost" label="Avbryt" :disabled="sending" @click="preview = false" /><p v-if="proposal?.version !== item.version" class="text-sm text-warning">Objektet har ändrats. Ta fram ett nytt förslag.</p><p class="text-sm" role="status">{{ notice }}</p></template>
  </UModal>
</template>
