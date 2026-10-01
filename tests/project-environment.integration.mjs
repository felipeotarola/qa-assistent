// Opt-in: disposable account and synthetic job. Never starts a VPS process or model turn.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import postgres from 'postgres';
import { chromium } from 'playwright-core';
import { runtimeScope } from '../shared/runtime-scope.ts';
import { sandboxScope } from '../server/utils/sandbox-scope.ts';
if(process.env.RUN_ENVIRONMENT_TESTS!=='1') throw Error('Enable RUN_ENVIRONMENT_TESTS=1');
const origin='http://localhost:3000',email=`environment-${randomUUID()}@example.com`,password=randomUUID();
const admin=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const {data,error}=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.equal(error,null);
const userId=data.user.id,cookies=new Map(),database=postgres(process.env.POSTGRES_URL||process.env.POSTGRESQL_URL||process.env.DATABASE_URL,{prepare:false,max:1});
const auth=createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,{cookieOptions:{name:'pat_supabase_auth',path:'/',sameSite:'lax'},cookies:{getAll:()=>[...cookies].map(([name,value])=>({name,value})),setAll:items=>items.forEach(c=>cookies.set(c.name,c.value))}});
async function api(path,method='GET',body,internal=false){const response=await fetch(origin+path,{method,headers:{cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),'content-type':'application/json',...(internal?{authorization:`Bearer ${process.env.INTERNAL_API_SECRET}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};}
let browser;
try {
  assert.equal((await fetch(origin+'/workers/setup/notify',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401,'Custom channel must reach Eve, not return an HTML fallback');
  assert.equal((await auth.auth.signInWithPassword({email,password})).error,null);
  const created=await api('/api/workspaces','POST',{name:'Tillfällig miljöverifiering'}); assert.equal(created.status,200,JSON.stringify(created.data)); const workspaceId=created.data.workspace.id;
  const threadId=(await api('/api/threads','POST',{workspaceId,title:'Syntetisk konfigurationskontroll'})).data.thread.id;
  const jobId=randomUUID(),sessionKey=randomUUID(),id=sandboxScope(userId,threadId,sessionKey).id;
  const plan={repoUrl:'https://github.com/example/fixture',root:'/workspace/fixture',directory:'/workspace/fixture/app',commit:'a'.repeat(40),command:'npm run dev',port:3000,httpStatus:500,variables:[{name:'DATABASE_URL',reason:'Testdatabas för startsidan',required:true},{name:'STREAM_TOKEN',reason:'Bara för livesändning',required:false}]};
  const result={jobId,id,workspaceId,status:'needs_configuration',message:'Behöver konfiguration',environment:plan,updatedAt:new Date().toISOString()};
  await database`insert into pat_setup_jobs (id,workspace_id,thread_id,runtime,parent_session_id,session_key,task,model,reasoning,status,result,notification) values (${jobId},${workspaceId},${threadId},${runtimeScope()},'synthetic-no-session',${sessionKey},'Synthetic fixture only','glm-5.3','low','needs_configuration',${database.json(result)},'delivered')`;
  const path=`/api/workspaces/${workspaceId}/setup-jobs`,secret='fixture-secret-'+randomUUID();
  assert.equal((await fetch(origin+path)).status,401);
  assert.equal((await api(`/api/workspaces/${randomUUID()}/setup-jobs/${jobId}`,'PUT',{expectedRevision:0,values:{DATABASE_URL:secret},continue:false})).status,404);
  assert.equal((await api(path+'/'+jobId,'PUT',{expectedRevision:0,values:{NODE_OPTIONS:secret},continue:false})).status,400);
  assert.equal((await api(path+'/'+jobId,'PUT',{expectedRevision:0,values:{UNREQUESTED:secret},continue:false})).status,400);
  assert.equal((await api(path+'/'+jobId,'PUT',{expectedRevision:0,values:{},continue:true})).status,400);
  assert.equal((await api(path+'/'+jobId,'PUT',{expectedRevision:0,values:{DATABASE_URL:secret},continue:false})).status,200);
  assert.equal((await api(path+'/'+jobId,'PUT',{expectedRevision:0,values:{DATABASE_URL:'stale'},continue:false})).status,409);
  const view=await api(path);assert.equal(view.status,200);assert.deepEqual(view.data.jobs[0].configuredNames,['DATABASE_URL']);assert.ok(!JSON.stringify(view.data).includes(secret));
  const [vault]=await database`select sealed_values from pat_project_environments where workspace_id=${workspaceId}`;assert.ok(!vault.sealed_values.includes(secret));assert.ok(vault.sealed_values.startsWith('v1.'));
  assert.equal((await api('/api/internal/setup-result','POST',{...result,id:randomUUID()},true)).status,409);
  // Terminal callback cannot revive an obsolete session, nor regress to older state.
  const completed={...result,status:'failed',updatedAt:new Date(Date.now()+1000).toISOString()};
  assert.equal((await api('/api/internal/setup-result','POST',completed,true)).status,200);
  assert.equal((await api('/api/internal/setup-result','POST',result,true)).status,200);
  const [saved]=await database`select status,notification from pat_setup_jobs where id=${jobId}`;assert.equal(saved.status,'failed');assert.equal(saved.notification,'session_changed');
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addCookies([...cookies].map(([name,value])=>({name,value,domain:'localhost',path:'/'})).concat([{name:'pat_workspace',value:workspaceId,domain:'localhost',path:'/'},{name:'agent-activity-pinned',value:'true',domain:'localhost',path:'/'}]));
  const page=await context.newPage();await page.goto(origin+'/?workspace='+workspaceId);
  const button=page.getByRole('button',{name:'Konfigurera testmiljön',exact:true});await button.waitFor({timeout:60000});await button.click();
  const dialog=page.getByRole('dialog',{name:'Konfigurera testmiljön'});await dialog.waitFor();
  assert.equal(await dialog.getByLabel('DATABASE_URL',{exact:true}).getAttribute('type'),'password');
  assert.equal(await dialog.getByLabel('DATABASE_URL',{exact:true}).inputValue(),'');
  assert.equal(await dialog.getByRole('button',{name:'Spara och fortsätt',exact:true}).isEnabled(),true);
  await dialog.getByLabel('Importera miljövariabler').setInputFiles({name:'.env',mimeType:'text/plain',buffer:Buffer.from('STREAM_TOKEN=ui-test-token\nEXTRA_KEY=not-uploaded')});
  assert.equal(await dialog.getByLabel('STREAM_TOKEN',{exact:true}).inputValue(),'ui-test-token');
  await dialog.getByRole('button',{name:'Spara utan att starta',exact:true}).click();
  await dialog.getByRole('status').filter({hasText:'Konfigurationen sparades'}).waitFor();
  const imported=(await api(path)).data.jobs[0];assert.deepEqual(imported.configuredNames.sort(),['DATABASE_URL','STREAM_TOKEN']);assert.ok(!JSON.stringify(imported).includes('ui-test-token'));
  await page.screenshot({animations:'disabled',path:process.env.TEMP+'/environment-form-wide.png'});
  await dialog.getByRole('button',{name:'Stäng',exact:true}).click();
  await page.emulateMedia({colorScheme:'dark'});await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Pågående arbete',exact:true}).click();await button.click();await dialog.waitFor();
  assert.ok(await dialog.evaluate(el=>el.getBoundingClientRect().width<=window.innerWidth));
  await page.screenshot({animations:'disabled',path:process.env.TEMP+'/environment-form-narrow.png'});
  await dialog.getByRole('button',{name:'Stäng',exact:true}).click();
  console.log('Passed: ownership, encryption, names-only response, revision conflicts, scope/replay callbacks, masked form, local import/save-only and responsive modal. No VPS/model execution.');
} finally {
  await browser?.close();await auth.auth.signOut({scope:'local'});await database`delete from pat_user where id=${userId}`;await admin.auth.admin.deleteUser(userId);await database.end();
}
