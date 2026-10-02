<script setup lang="ts">
import { brand } from '#shared/brand';

defineProps<{
  size?: "sm" | "lg";
}>();
</script>

<template>
  <div
    v-if="size !== 'sm'"
    class="space-y-3 pb-2"
  >
    <div class="space-y-3">
      <h1 class="text-3xl font-semibold tracking-tight text-highlighted sm:text-4xl">
        {{ brand.name }}
      </h1>
      <p class="max-w-md text-sm leading-relaxed text-muted">
        {{ brand.description }}
      </p>
    </div>
  </div>

  <div
    v-else
    class="flex items-center gap-2.5"
  >
    <AppLogo class="size-7 text-highlighted" />
    <span class="text-sm font-semibold text-highlighted">
      {{ brand.name }}
    </span>
  </div>
</template>
