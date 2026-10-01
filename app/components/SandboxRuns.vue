<script setup lang="ts">
import type { SandboxState } from '#shared/sandbox';
const sessions = useState<SandboxState[]>('execution-sandboxes', () => []);
const { activeId } = useWorkspaces();
const minimized = ref(false), busy = ref(false), error = ref('');
const showHistory = ref(false);
const visibleProcesses = (session: SandboxState) => showHistory.value ? session.processes : session.processes.filter((p, i) => p.status === 'running' || i === session.processes.length - 1);
const latest = computed(() => sessions.value.at(-1));
watch(() => latest.value?.id, () => { minimized.value = false; });
async function stop(id: string) {
  busy.value = true; error.value = '';
  try { await $fetch(`/api/workspaces/${activeId.value}/sandboxes`, { method: 'POST', body: { id, action: 'stop' } }); }
  catch { error.value = 'Kunde inte bekräfta stopp. Senast kända status visas.'; }
  finally { busy.value = false; }
}
</script>
<template>

    <section v-if="sessions.length" aria-label="Arbetsmiljöer på VPS" class="min-w-0 overflow-hidden rounded-xl border border-default bg-default">
      <header class="flex items-center gap-2 p-3"><UIcon name="i-lucide-container" class="size-4" /><h2 class="flex-1 text-sm font-semibold">Arbetsmiljö på VPS</h2><UButton :icon="minimized ? 'i-lucide-chevron-up' : 'i-lucide-minus'" :aria-label="minimized ? 'Visa arbetsmiljö' : 'Minimera arbetsmiljö'" :aria-expanded="!minimized" variant="ghost" size="xs" @click="minimized = !minimized" /></header>
      <div v-show="!minimized" class="space-y-4 border-t border-default p-4">
        <article v-for="session in sessions" :key="session.id" class="space-y-3">
          <div v-if="session.codex" class="space-y-2 rounded-lg border border-default p-3">
            <p class="flex items-center gap-2 text-sm font-medium"><UIcon :name="['starting', 'running'].includes(session.codex.status) ? 'i-lucide-loader-circle' : 'i-lucide-bot'" :class="['starting', 'running'].includes(session.codex.status) ? 'motion-safe:animate-spin' : ''" />Codex · {{ session.codex.status }}</p>
            <p class="text-xs text-muted" role="status">{{ session.codex.message }}</p>
            <details v-if="session.codex.result"><summary class="cursor-pointer text-xs">Visa rapport</summary><p class="mt-2 whitespace-pre-wrap break-words text-sm">{{ session.codex.result }}</p></details>
          </div>
          <p class="text-sm" role="status">{{ session.message }}</p><p class="text-xs text-muted">{{ session.id.slice(0, 8) }} · {{ session.status }} · {{ session.processes.length }} processer</p>
          <details v-for="process in visibleProcesses(session)" :key="process.id" :open="process.status === 'running'"><summary class="cursor-pointer text-xs">Process {{ process.id.slice(0, 8) }} · {{ process.status }}<span v-if="process.exitCode !== null"> · exit {{ process.exitCode }}</span></summary><pre class="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{{ process.stdout }}{{ process.stderr }}</pre></details>
          <UButton v-if="session.processes.length > 1" :label="showHistory ? 'Dölj avslutade processer' : `Visa alla ${session.processes.length} processer`" variant="ghost" size="sm" @click="showHistory = !showHistory" />
          <UButton v-if="session.status === 'ready'" label="Stoppa miljön" icon="i-lucide-square" size="sm" variant="outline" :loading="busy" @click="stop(session.id)" />
        </article>
        <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
      </div>
    </section>

</template>
