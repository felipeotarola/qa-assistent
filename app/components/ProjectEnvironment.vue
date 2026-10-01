<script setup lang="ts">
import { parseEnvironmentFile, type SetupView } from '#shared/project-environment';
const props=defineProps<{workspaceId:string;job:SetupView}>();
const open=ref(false),busy=ref(false),error=ref(''),info=ref('');
const values=ref<Record<string,string>>({}),forget=ref<string[]>([]),revision=ref(0);
const plan=computed(()=>props.job.result?.environment);
const fields=computed(()=>plan.value?.variables||[]);
const canContinue=computed(()=>fields.value.every(v=>!v.required||!forget.value.includes(v.name)&&(!!values.value[v.name]||props.job.configuredNames.includes(v.name))));
watch(open,value=>{values.value={};forget.value=[];error.value='';info.value='';revision.value=props.job.revision; if(!value)values.value={};});
watch(()=>props.workspaceId,()=>{open.value=false;values.value={};});
onBeforeUnmount(()=>{values.value={};});
async function importFile(event:Event) {
  const input=event.target as HTMLInputElement,file=input.files?.[0]; error.value='';
  try {
    if(!file)return;if(file.size>128000)throw Error();
    const parsed=parseEnvironmentFile(await file.text()),names=new Set(fields.value.map(v=>v.name));
    const matching=Object.entries(parsed).filter(([key])=>names.has(key));
    values.value={...values.value,...Object.fromEntries(matching)};
    info.value=`${matching.length} värden lästes in. Övriga variabler importeras inte. Inget har sparats ännu.`;
  } catch {error.value='Kunde inte läsa filen. Använd NAMN=värde, en variabel per rad, utan dubbla namn.';}
  finally {input.value='';}
}
async function save(resume:boolean) {
  busy.value=true;error.value='';info.value='';
  try {
    const result=await $fetch(`/api/workspaces/${props.workspaceId}/setup-jobs/${props.job.id}`,{method:'PUT',body:{expectedRevision:revision.value,values:Object.fromEntries(Object.entries(values.value).filter(([,value])=>!!value)),forget:forget.value,continue:resume}});
    revision.value=result.revision;values.value={};forget.value=[];
    info.value=resume?'Konfigurationen sparades. Appen startas om och HTTP kontrolleras. V återkommer när resultatet är klart.':'Konfigurationen sparades. Inget har startats.';
    if(resume)open.value=false;
  } catch(cause) {error.value=(cause as {data?:{statusMessage?:string}}).data?.statusMessage||'Sparandet kunde inte bekräftas. Läs om inställningarna före nästa försök.';}
  finally {busy.value=false;}
}
async function retry() {
  busy.value=true;error.value='';
  try {await $fetch(`/api/workspaces/${props.workspaceId}/setup-jobs/${props.job.id}/resume`,{method:'POST',body:{revision:props.job.revision}});info.value='Fortsättningen har skickats med samma begäran.';}
  catch(cause){error.value=(cause as {data?:{statusMessage?:string}}).data?.statusMessage||'Fortsättningen kunde inte bekräftas.';}
  finally{busy.value=false;}
}
</script>
<template>
  <article v-if="plan" class="space-y-2 rounded-xl border border-default p-3">
    <p class="text-sm font-semibold">{{ job.status==='needs_configuration'?'Behöver konfiguration':job.status==='configuring'?'Kontrollerar appstart':job.status==='completed'?'Appstart kontrollerad':'Appstart behöver undersökas' }}</p>
    <p class="break-words text-xs text-muted">{{ plan.repoUrl.split('/').slice(-2).join('/') }} · Testmiljö · HTTP {{ plan.httpStatus??'ej verifierat' }}</p>
    <p v-if="job.status==='needs_configuration'" class="text-xs">Saknas för uppgiften: {{ fields.filter(v=>v.required&&!job.configuredNames.includes(v.name)).map(v=>v.name).join(', ') || 'sparad konfiguration behöver tillämpas' }}.</p>
    <UButton v-if="['needs_configuration','failed','completed'].includes(job.status)" :label="job.status==='completed'?'Miljöinställningar':'Konfigurera testmiljön'" icon="i-lucide-key-round" size="sm" @click="open=true" />
    <UButton v-if="['needs_configuration','failed'].includes(job.status)&&job.revision>0" label="Försök fortsätta igen" variant="ghost" size="sm" :loading="busy" @click="retry" />
    <p v-if="['unknown','failed','session_changed'].includes(job.notification)" class="text-xs text-warning">Återkopplingen till chatten kunde inte bekräftas. Resultatet finns kvar här; inget test körs om automatiskt.</p>
    <p v-if="info" role="status" class="text-xs">{{ info }}</p><p v-if="error&&!open" role="alert" class="text-xs text-error">{{ error }}</p>
    <UModal v-model:open="open" :ui="{ content: 'max-w-2xl' }" title="Konfigurera testmiljön" description="Värden sparas krypterat för detta repo och workspace. De visas aldrig i chatten.">
      <template #body><div class="space-y-4">
        <p class="break-words text-sm font-medium">{{ plan.repoUrl }}</p>
        <p class="text-sm text-muted">Spara och fortsätt ger koden i detta repo tillgång till de valda värdena. Använd testuppgifter. Befintlig installation återanvänds och appens HTTP-svar kontrolleras före fortsatt testning.</p>
        <div class="space-y-1 break-words text-xs text-muted"><p>Projekt: {{ plan.directory }}</p><p>Version: {{ plan.commit.slice(0,12) }}</p><p>Kommando: <code>{{ plan.command }}</code></p></div>
        <div v-for="field in fields" :key="field.name" class="space-y-1">
          <UFormField :label="field.name" :description="field.reason" :required="field.required" :hint="job.configuredNames.includes(field.name)?'Sparat värde finns':field.required?'Obligatorisk':'Valfri'">
            <UInput v-model="values[field.name]" type="password" autocomplete="new-password" :placeholder="job.configuredNames.includes(field.name)?'Lämna tomt för att behålla':'Fyll i värde'" class="w-full" />
          </UFormField>
          <UCheckbox v-if="job.configuredNames.includes(field.name)" :model-value="forget.includes(field.name)" label="Ta bort sparat värde" @update:model-value="checked=>forget=checked?[...forget,field.name]:forget.filter(name=>name!==field.name)" />
        </div>
        <UFormField label="Importera .env" description="Filen läses lokalt. Bara variablerna ovan tas med; inget körs eller sparas vid import."><input type="file" accept=".env,.local,.txt" aria-label="Importera miljövariabler" class="block w-full text-sm" @change="importFile"></UFormField>
        <p class="text-xs text-muted">Spara utan att starta ändrar valvet, men påverkar inte en redan körande process. Starta om för att använda ändrade eller borttagna värden.</p>
        <p v-if="info" role="status" class="text-sm">{{ info }}</p><p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
      </div></template>
      <template #footer><div class="flex flex-wrap gap-2"><UButton label="Spara och fortsätt" :loading="busy" :disabled="!canContinue" @click="save(true)" /><UButton label="Spara utan att starta" variant="outline" :disabled="busy" @click="save(false)" /><UButton label="Stäng" variant="ghost" :disabled="busy" @click="open=false" /></div></template>
    </UModal>
  </article>
</template>
