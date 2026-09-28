<script setup lang="ts">
import type { TestPlan } from "#shared/test-plan";
import { newTestCase } from "#shared/test-plan";
const plan = defineModel<TestPlan>({ required: true });
const types = [{ label: 'Webbläsare', value: 'browser' }, { label: 'API', value: 'api' }, { label: 'Manuellt', value: 'manual' }];
</script>
<template>
  <div class="space-y-4">
    <UFormField label="Sammanfattning"><UTextarea v-model="plan.summary" class="w-full" autoresize /></UFormField>
    <div v-for="(test, index) in plan.cases" :key="test.id" class="space-y-3 rounded-lg border border-default p-4">
      <div class="flex items-center justify-between"><h4 class="font-medium">Testfall {{ index + 1 }}</h4><UButton label="Ta bort testfall" color="neutral" variant="ghost" @click="plan.cases.splice(index, 1)" /></div>
      <UFormField label="Testets namn"><UInput v-model="test.title" class="w-full" :maxlength="300" /></UFormField>
      <UFormField label="Typ"><USelect v-model="test.type" :items="types" /></UFormField>
      <UFormField label="Förutsättningar"><UTextarea v-model="test.preconditions" class="w-full" autoresize /></UFormField>
      <UFormField label="Steg"><UTextarea v-model="test.steps" class="w-full" autoresize /></UFormField>
      <UFormField label="Förväntat resultat"><UTextarea v-model="test.expected" class="w-full" autoresize /></UFormField>
      <p class="text-xs text-dimmed">ID: {{ test.id }}</p>
    </div>
    <UButton label="Lägg till testfall" icon="i-lucide-plus" variant="soft" :disabled="plan.cases.length >= 500" @click="plan.cases.push(newTestCase())" />
  </div>
</template>
