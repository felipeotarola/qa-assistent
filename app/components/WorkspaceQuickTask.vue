<script setup lang="ts">
import type { WorkspaceItem } from "#shared/workspace";
const props = defineProps<{ item: WorkspaceItem; disabled?: boolean }>();
const agent = useWorkspaceAgent();
const drafts = useState<Record<string, string>>("workspace-card-drafts", () => ({}));
const text = computed({ get: () => drafts.value[props.item.id] ?? "", set: value => { drafts.value[props.item.id] = value; } });
const sending = ref(false);
const notice = ref("");
const available = computed(() => !props.disabled && agent.value?.workspaceId === props.item.workspaceId && agent.value.available);
async function submit() {
  if (!available.value || sending.value || !text.value.trim()) return;
  sending.value = true; notice.value = "";
  const task = text.value;
  try {
    const accepted = await agent.value!.run(props.item, task);
    if (accepted) {
      if (text.value === task) text.value = "";
      notice.value = "Skickat till chatten. Följ svaret där.";
    } else notice.value = "Kontrollera chatten innan du skickar igen. Texten finns kvar.";
  } catch { notice.value = "Kunde inte bekräfta uppgiften. Kontrollera chatten innan du försöker igen."; }
  finally { sending.value = false; }
}
</script>
<template>
  <form class="border-b border-default/70 p-3" @submit.prevent="submit">
    <label :for="`task-${item.id}`" class="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted"><UIcon name="i-lucide-sparkles" class="size-3.5" /> Be agenten ändra</label>
    <div class="flex items-center gap-2">
      <UInput :id="`task-${item.id}`" v-model="text" class="min-w-0 flex-1" :maxlength="4000" :placeholder="item.content.kind === 'test_plan' ? 'Ändra testplanen…' : item.content.kind === 'diagram' ? 'Ändra diagrammet…' : item.content.kind === 'table' ? 'Lägg till i tabellen…' : 'Lägg till i dokumentet…'" :disabled="sending || disabled" />
      <UButton type="submit" icon="i-lucide-arrow-up" aria-label="Skicka uppgift till agenten" :loading="sending" :disabled="!available || !text.trim() || sending" />
    </div>
    <p class="mt-2 text-[11px] text-muted" aria-live="polite">{{ notice || (disabled ? 'Spara eller avbryt redigeringen först.' : !agent ? 'Öppna en chatt i detta workspace för att skicka.' : !available ? 'Vänta tills chatten är redo.' : 'Använder chatten och vald modell.') }}</p>
  </form>
</template>
