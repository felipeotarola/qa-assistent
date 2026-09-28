import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import postgres from 'postgres';
import { sealCredential, openCredential } from '../server/utils/oauth-crypto.ts';
if(process.env.RUN_WORKSPACE_TESTS!=='1') throw Error('Set RUN_WORKSPACE_TESTS=1');
const encrypted=sealCredential('secret','owner');
assert.equal(openCredential(encrypted,'owner'),'secret');
assert.throws(()=>openCredential(encrypted,'other-user'));
assert.throws(()=>openCredential(encrypted.slice(0,-3)+'abc','owner'));
const admin=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const url=new URL(process.env.DATABASE_URL), sql=postgres(url.toString(),{max:1,prepare:false,...(url.hostname.endsWith('.pooler.supabase.com')?{port:6543}:{})});
const users=[];
async function fixture(){
 const email=`linear-test-${randomUUID()}@example.com`,password=randomUUID();
 const {data,error}=await admin.auth.admin.createUser({email,password,email_confirm:true});if(error)throw error;
 users.push(data.user.id);const cookies=new Map();
 const auth=createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,{cookieOptions:{name:'pat_supabase_auth',path:'/',sameSite:'lax'},cookies:{getAll:()=>[...cookies].map(([name,value])=>({name,value})),setAll:values=>values.forEach(c=>cookies.set(c.name,c.value))}});
 assert.equal((await auth.auth.signInWithPassword({email,password})).error,null);
 return {id:data.user.id,cookie:()=>[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')};
}
const origin='http://localhost:3000';
try {
 const a=await fixture(), b=await fixture();
 const call=(user,path,opts={})=>fetch(origin+path,{redirect:'manual',signal:AbortSignal.timeout(30000),...opts,headers:{cookie:user.cookie(),...opts.headers}});
 for(const u of [a,b]) assert.equal((await call(u,'/api/integrations/linear/status')).status,200);
 assert.equal((await fetch(origin+'/api/integrations/linear/connect',{method:'POST'})).status,401);
 assert.equal((await call(a,'/api/integrations/linear/connect',{method:'POST',headers:{origin:'https://evil.example'}})).status,403);
 const response=await call(a,'/api/integrations/linear/connect',{method:'POST',headers:{origin}});
 if(response.status!==200) console.log(await response.clone().text()); assert.equal(response.status,200);
 const authUrl=new URL((await response.json()).url);
 assert.equal(authUrl.origin,'https://linear.app');assert.equal(authUrl.searchParams.get('redirect_uri'),process.env.LINEAR_REDIRECT_URI || origin+'/api/integrations/linear/callback');
 assert.equal(authUrl.searchParams.get('scope'),'read,write');assert.equal(authUrl.searchParams.get('code_challenge_method'),'S256');
 const state=authUrl.searchParams.get('state'); const oauthCookie=response.headers.getSetCookie().find(c=>c.startsWith('pat_linear_oauth=')).split(';')[0];
 const [stored]=await sql`select * from pat_linear_oauth_states where user_id=${a.id}`;
 assert.equal(stored.id,createHash('sha256').update(state).digest('hex'));
 assert.equal(createHash('sha256').update(openCredential(stored.verifier,a.id)).digest('base64url'),authUrl.searchParams.get('code_challenge'));
 const callback=`/api/integrations/linear/callback?state=${state}&error=access_denied`;
 assert.equal((await call(a,callback)).status,400,'Cookie binding required');
 assert.equal((await call(b,callback,{headers:{cookie:b.cookie()+'; '+oauthCookie}})).status,400,'Wrong user rejected without consuming state');
 const own={headers:{cookie:a.cookie()+'; '+oauthCookie}};
 assert.equal((await call(a,callback,own)).status,302,'Denial completes without granting access');
 assert.equal((await call(a,callback,own)).status,400,'Replay rejected');
 const rows=await sql`select * from pat_linear_accounts where user_id=${a.id}`;assert.equal(rows.length,0);
 // A fake unexpired credential proves user-scoped lookup without contacting Linear.
 await sql`insert into pat_linear_accounts(user_id,credentials,label,expires_at) values(${a.id},${sealCredential(JSON.stringify({access_token:'fixture-only',refresh_token:'fixture-refresh',expires_in:3600}),a.id)},'Fixture',${new Date(Date.now()+3600000)})`;
 const statusA=await (await call(a,'/api/integrations/linear/status')).json(),statusB=await (await call(b,'/api/integrations/linear/status')).json();
 assert.equal(statusA.state,'connected');assert.equal(statusB.state,'not_connected');
 assert.ok(!JSON.stringify(statusA).includes('fixture-only'));
 assert.equal((await fetch(origin+'/api/internal/linear-token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:a.id})})).status,401);
 console.log('PASS OAuth URL/PKCE, encrypted owner-bound credentials, cookie + user binding, replay rejection, denial and two-user isolation. No real Linear grants or issues modified.');
}finally{for(const id of users){await sql`delete from pat_user where id=${id}`;await admin.auth.admin.deleteUser(id);}await sql.end();}



