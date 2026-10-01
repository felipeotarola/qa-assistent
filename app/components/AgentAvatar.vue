<script setup lang="ts">
import type { AgentRole } from '#shared/agent-identities';
defineProps<{ role: AgentRole }>();
</script>

<template>
  <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" class="agent-avatar shrink-0" :class="`agent-avatar-${role}`">
    <ellipse cx="32" cy="57" rx="19" ry="3" fill="currentColor" opacity=".12" />
    <path d="M32 15V8" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
    <circle cx="32" cy="7" r="4" class="avatar-accent" />
    <rect x="7" y="27" width="7" height="15" rx="3.5" fill="currentColor" opacity=".5" />
    <rect x="50" y="27" width="7" height="15" rx="3.5" fill="currentColor" opacity=".5" />
    <rect x="12" y="15" width="40" height="37" :rx="role === 'main' ? 15 : 10" class="avatar-shell" stroke="currentColor" stroke-width="2" />
    <path d="M21 19H30" stroke="currentColor" stroke-opacity=".18" stroke-width="2" stroke-linecap="round" />
    <rect x="18" y="25" width="28" height="18" rx="7" fill="currentColor" />
    <g class="avatar-eyes" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <template v-if="role === 'main'">
        <path d="M25 32V35M39 32V35" />
        <path d="M29 38Q32 40 35 38" stroke-width="1.5" />
      </template>
      <template v-else-if="role === 'browser'"><circle cx="26" cy="34" r="3" /><circle cx="38" cy="34" r="3" /><path d="M29 34H35" /></template>
      <template v-else-if="role === 'vps'"><path d="M24 30L28 34L24 38M33 38H40" /></template>
      <template v-else-if="role === 'reviewer'"><circle cx="29" cy="33" r="4" /><path d="M32 36L38 40" /></template>
      <template v-else><path d="M27 30L23 34L27 38M37 30L41 34L37 38" /></template>
    </g>
    <path d="M28 47H36" stroke="currentColor" stroke-opacity=".4" stroke-width="2" stroke-linecap="round" />
    <circle cx="48" cy="49" r="7" class="avatar-accent" />
    <path v-if="role === 'main'" d="M48 45V53M44 49H52" class="avatar-badge" stroke-width="1.5" stroke-linecap="round" />
    <path v-else-if="role === 'reviewer'" d="M44 49L47 52L52 46" class="avatar-badge" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    <path v-else-if="role === 'vps'" d="M45 47H51M45 51H51" class="avatar-badge" stroke-width="1.5" stroke-linecap="round" />
    <path v-else d="M46 45V53M46 50Q50 50 50 46M49 46H51" class="avatar-badge" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
</template>

<style scoped>
.agent-avatar { color: var(--ui-primary); }
.avatar-shell { fill: var(--ui-bg-elevated); }
.agent-avatar-main .avatar-accent { fill: var(--ui-info); }
.agent-avatar-repository .avatar-accent { fill: var(--ui-success); }
.agent-avatar-browser .avatar-accent { fill: var(--ui-warning); }
.agent-avatar-vps .avatar-accent { fill: var(--ui-info); }
.agent-avatar-reviewer .avatar-accent { fill: var(--ui-success); }
.avatar-eyes { stroke: var(--ui-bg); }
.avatar-badge { stroke: var(--ui-bg); }
</style>
