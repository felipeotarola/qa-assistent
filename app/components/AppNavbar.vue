<script setup lang="ts">
import { startNewChat } from "~/composables/chat/navigation";

defineProps<{ embedded?: boolean }>();
</script>

<template>
  <UDashboardNavbar
    class="z-10 sm:px-4"
    :class="embedded
      ? 'relative shrink-0 border-b border-default bg-default/80'
      : 'pointer-events-none absolute inset-x-0 top-0 border-b-0 backdrop-blur lg:backdrop-blur-none'"
    :ui="{ left: 'pointer-events-auto min-w-0', right: 'pointer-events-auto gap-1' }"
  >
    <template #left>
      <slot name="title" />
    </template>

    <template #right>
      <slot />

      <UserMenu />

      <UColorModeButton />

      <UButton
        color="neutral"
        variant="ghost"
        icon="i-lucide-circle-plus"
        class="lg:hidden"
        aria-label="New chat"
        @click="startNewChat()"
      />
    </template>
  </UDashboardNavbar>
</template>
