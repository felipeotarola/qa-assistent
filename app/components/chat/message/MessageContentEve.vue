<script setup lang="ts">
import { agentIdentities } from '#shared/agent-identities';
import { toolDetails } from '#shared/tool-details';
import {
  getToolName,
  isDynamicToolUIPart,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
} from "ai";
import type { UIMessage } from "ai";
import type { ChatSuggestion } from "#shared/chat-suggestions";
import type { EveDynamicToolPart } from "eve/vue";
import { isPartStreaming, isToolStreaming } from "@nuxt/ui/utils/ai";
import type { AgentInputResponse } from "~/components/AgentInputRequest.vue";
import type { ChatStatus } from "~/composables/chat/useChatSession";
import { getMergedParts } from "~/utils/chat/ai";
import { hasVisibleParts, getToolDisplayName, getToolNamespace, normalizeEveParts, shouldShowToolInput } from "~/utils/chat/eve";
import type { WeatherUIToolInvocation } from "~~/shared/utils/tools/weather";

const props = defineProps<{
  message: UIMessage;
  status: ChatStatus;
  isLast?: boolean;
  canRespond?: boolean;
  suggestions?: ChatSuggestion[];
}>();

const emit = defineEmits<{
  inputResponses: [responses: AgentInputResponse[]];
  suggestion: [prompt: string];
}>();

const rawParts = computed(() => props.message.parts);
const displayParts = computed(() => getMergedParts(normalizeEveParts(rawParts.value)).filter(part => !((isToolUIPart(part) || isDynamicToolUIPart(part)) && getToolName(part) === "suggest_next_steps")));

const isBusy = computed(
  () => props.status === "submitted" || props.status === "streaming",
);

const showThinking = computed(
  () =>
    props.message.role === "assistant"
    && props.isLast
    && isBusy.value
    && !hasVisibleParts(rawParts.value),
);
</script>

<template>
  <ChatActivityIndicator v-if="showThinking" />

  <template
    v-for="(part, index) in displayParts"
    :key="`${message.id}-part-${index}`"
  >
    <ChatReasoningDetails
      v-if="isReasoningUIPart(part)"
      :text="part.text"
      :streaming="isPartStreaming(part)"
    />

    <template v-else-if="isToolUIPart(part) || isDynamicToolUIPart(part)">
      <ChatToolWeather
        v-if="getToolName(part) === 'weather'"
        :invocation="{ ...(part as WeatherUIToolInvocation) }"
        :streaming="isToolStreaming(part)"
      />
      <UChatTool
        v-else-if="getToolName(part) === 'web_search' || getToolName(part) === 'google_search'"
        :text="isToolStreaming(part) ? 'Searching the web...' : 'Searched the web'"
        :suffix="getSearchQuery(part)"
        :streaming="isToolStreaming(part)"
        chevron="leading"
      >
        <ChatToolSources :sources="getSources(part)" />
      </UChatTool>
      <UChatTool
        v-else-if="getToolName(part) !== 'ask_question'"
        variant="card"
        :icon="getToolName(part) === 'bash' ? 'i-lucide-terminal' : 'i-lucide-wrench'"
        :loading="isToolStreaming(part)"
        :text="isDynamicToolUIPart(part) ? getToolDisplayName(part as EveDynamicToolPart) : getToolName(part) === 'codex' ? agentIdentities.vps.name : getToolName(part)"
        :suffix="[isDynamicToolUIPart(part) ? getToolNamespace(part as EveDynamicToolPart) : '', part.state === 'output-error' || part.state === 'output-denied' ? 'Verktygsfel' : part.state === 'output-available' ? 'Svar mottaget' : isToolStreaming(part) ? 'Pågår' : 'Väntar'].filter(Boolean).join(' · ')"
        :streaming="isToolStreaming(part)"
        chevron="trailing"
        :default-open="part.state === 'approval-requested' || part.state === 'approval-responded'"
      >
        <AgentInputRequest
          v-if="isDynamicToolUIPart(part)"
          :can-respond="canRespond ?? true"
          :part="part as EveDynamicToolPart"
          @input-responses="emit('inputResponses', $event)"
        />

        <ToolCallDetails
          :input="(!isDynamicToolUIPart(part) || shouldShowToolInput(part as EveDynamicToolPart)) ? toolDetails(part.input) : []"
          :output="toolDetails(part.errorText ? { errorText: part.errorText } : part.output)"
        />
      </UChatTool>

      <AgentInputRequest
        v-else-if="isDynamicToolUIPart(part)"
        compact
        :can-respond="canRespond ?? true"
        :part="part as EveDynamicToolPart"
        @input-responses="emit('inputResponses', $event)"
      />
    </template>

    <template v-else-if="isTextUIPart(part)">
      <div
        v-if="message.role === 'assistant'"
        class="relative"
      >
        <ChatComark
          :key="isPartStreaming(part) ? `${message.id}-text-${part.text.length}` : `${message.id}-text-${index}`"
          :value="part.text"
          :streaming="isPartStreaming(part)"
        />
        <span
          v-if="isPartStreaming(part) && isLast"
          class="ml-0.5 inline-block h-[1.1em] w-0.5 translate-y-px animate-pulse rounded-full bg-highlighted"
          aria-hidden="true"
        />
      </div>
      <p
        v-else
        class="whitespace-pre-wrap"
      >
        {{ part.text }}
      </p>
    </template>
  </template>
  <ChatSuggestions :suggestions="suggestions ?? []" :disabled="!(canRespond ?? true)" @select="emit('suggestion', $event)" />
</template>
