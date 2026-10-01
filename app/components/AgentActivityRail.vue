<script setup lang="ts">
import type { AgentRole } from '#shared/agent-identities';
defineProps<{ items: { id: string; label: string; icon: string; role?: AgentRole; status: 'working' | 'waiting' | 'error' | 'idle'; detail: string; count?: number }[] }>();
defineEmits<{ expand: [section?: string] }>();
const statusColors = { working: 'bg-info motion-safe:animate-pulse', waiting: 'bg-warning', error: 'bg-error', idle: 'bg-accented' };
</script>

<template>
  <div class="flex h-full w-full shrink-0 flex-col items-center gap-3 bg-default py-3">
    <UTooltip text="Visa Pågående arbete" :content="{ side: 'left' }"><UButton id="activity-rail-expand" icon="i-lucide-panel-right-open" aria-label="Visa Pågående arbete" :aria-expanded="false" color="neutral" variant="ghost" @click="$emit('expand')" /></UTooltip>
    <div class="flex min-h-0 w-full flex-1 flex-col items-center gap-3 overflow-y-auto px-1 py-1">
      <UTooltip v-for="item in items" :key="item.id" :text="`${item.label} · ${item.detail}${item.count && item.count > 1 ? ` · ${item.count} st` : ''}`" :content="{ side: 'left' }">
        <UButton :aria-label="`${item.label}: ${item.detail}${item.count && item.count > 1 ? `, ${item.count} st` : ''}`" class="relative size-10 shrink-0 justify-center p-1" color="neutral" variant="ghost" @click="$emit('expand', item.id)">
          <AgentAvatar v-if="item.role" :role="item.role" class="size-8" /><UIcon v-else :name="item.icon" class="size-5" />
          <span aria-hidden="true" class="absolute right-0.5 top-0.5 size-2 rounded-full ring-2 ring-default" :class="statusColors[item.status]" />
          <span v-if="item.count && item.count > 1" aria-hidden="true" class="absolute -bottom-1 right-0 rounded bg-elevated px-1 text-[10px] leading-4 text-muted">{{ item.count > 99 ? '99+' : item.count }}</span>
        </UButton>
      </UTooltip>
    </div>
  </div>
</template>
