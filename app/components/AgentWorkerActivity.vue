<script setup lang="ts">
import { BROWSER_THREAD_HEADER } from '#shared/browser';
import { projectActivity } from '#shared/agent-activity';

const props = defineProps<{ threadId: string; sessionId: string; name: string }>();
// Subscribe to the child's real Eve stream; opening this card cannot send work.
// The SDK detaches on unmount without cancelling the durable child execution.
const agent = useEveAgent({ initialSession: { sessionId: props.sessionId, streamIndex: 0 }, resume: true, headers: () => ({ [BROWSER_THREAD_HEADER]: props.threadId }) });
const busy = computed(() => ['streaming', 'submitted'].includes(agent.status.value));
const activity = computed(() => projectActivity(agent.data.value.messages, busy.value));
const labels = { working: 'Pågår', waiting: 'Väntar på dig', done: 'Utfört', error: 'Verktygsfel', unconfirmed: 'Ej bekräftat' };
const title = computed(() => props.name === 'repo' ? 'Axel · Repoagent' : props.name.replaceAll('__', ' · '));
</script>

<template>
  <section class="rounded-lg border border-default p-4 space-y-3" :aria-label="title">
    <div class="flex items-center gap-2 text-sm font-semibold">
      <UIcon :name="busy ? 'i-lucide-loader-circle' : 'i-lucide-bot'" :class="busy ? 'motion-safe:animate-spin' : ''" />
      <span>{{ title }}</span>
      <UBadge class="ml-auto" variant="soft" :color="agent.error.value ? 'warning' : busy ? 'info' : 'neutral'">{{ agent.error.value ? 'Anslutningsfel' : busy ? 'Arbetar' : agent.status.value === 'resuming' ? 'Återansluter' : 'Senaste arbete' }}</UBadge>
    </div>
    <p v-if="agent.error.value" class="text-xs text-muted">Barnagentens ström kunde inte läsas. Huvudagentens svar och sparade körresultat finns kvar.</p>
    <ol v-else-if="activity.steps.length" class="space-y-2">
      <li v-for="step in activity.steps.slice(-8)" :key="step.id" class="text-xs">
        <details v-if="step.kind !== 'reasoning'">
          <summary class="cursor-pointer break-words">{{ step.label }} · {{ labels[step.status] }}</summary>
          <ToolCallDetails :input="step.input || []" :output="step.output || []" />
        </details>
        <p v-else class="text-muted">{{ step.label }} · {{ labels[step.status] }}</p>
      </li>
    </ol>
    <p v-else class="text-xs text-muted">{{ busy ? 'Analyserar uppgiften…' : 'Inga verktygssteg att visa.' }}</p>
  </section>
</template>
