import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { ref, computed, watch } from 'vue';
import * as recovery from '../shared/chat-recovery.ts';
import { randomUUID } from 'node:crypto';
const { draftKey } = recovery;

function fixture(fail, history = { messages: [], cursors: [] }) {
  let sends=0,reloads=0,resumes=0,rebinds=0,callbacks;const mounted=[],unmounted=[],stored=new Map(),failures={},workers=ref([]),listeners={};
  const agent={session:ref(undefined),events:ref([]),status:ref('ready'),error:ref(undefined),data:ref({messages:[]}),
    async resume(){resumes++;agent.status.value='streaming';},
    async send(){sends++;agent.error.value=fail?new Error('connection lost after server accepted turn'):undefined;agent.status.value=fail?'error':'ready';},
    async respond(){throw Error('response transport failed');},async cancel(){throw Error('cancel transport failed');}};
  const imports={
    '~/composables/chat/useAuthorizationChallenges':{recordAuthorizationEvent(){}},
    '~/composables/chat/thread-session':{resumeOptionsFromThread:()=>({})},
    '~/composables/chat/navigation':{refreshThreadList:async()=>{}},
    '~/composables/chat/stream-log':{recordStreamEvent(){}},
    '~/composables/chat/turn-errors':{clearTurnFailure:id=>delete failures[id],recordTurnFailure(){},turnFailure:id=>failures[id]},
    '#shared/chat-models':{CHAT_MODEL_HEADER:'model',REASONING_HEADER:'reasoning'},
    '#shared/browser':{BROWSER_THREAD_HEADER:'thread'}, '#shared/chat-recovery':recovery,
  };
  const source=fs.readFileSync(new URL('../app/composables/chat/useChatSession.ts',import.meta.url),'utf8').replaceAll('import.meta.client','true').replaceAll('import.meta.dev','false');
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};vm.runInNewContext(js,{Error,exports,require:name=>{assert.ok(imports[name],name);return imports[name];},ref,computed,watch,
    useAgentActivity:()=>({workers}),useChatModel:()=>ref('test'),useChatReasoning:()=>ref('low'),useEveAgent:options=>{callbacks=options;return agent;},useState:(_key,init)=>ref(init()),onMounted(fn){mounted.push(fn);},onBeforeUnmount(fn){unmounted.push(fn);},$fetch:async()=>history,crypto:{randomUUID},
    sessionStorage:{getItem:k=>stored.get(k),setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k)},window:{location:{reload(){reloads++;}},addEventListener:(k,fn)=>listeners[k]=fn,removeEventListener:k=>delete listeners[k]},document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},setTimeout:()=>0,clearTimeout});
  const chat=exports.useChatSession({id:'fixture',sessionId:null,history:[]},async()=>{rebinds++;});
  return { chat,stored,agent,workers,listeners,headers:()=>callbacks.headers(),event:e=>callbacks.onEvent(e),counts:()=>({sends,reloads}),resumes:()=>resumes,rebinds:()=>rebinds,unmount:()=>unmounted.forEach(fn=>fn()),mount:async()=>{mounted.forEach(fn=>fn());await new Promise(resolve=>setImmediate(resolve));} };
}
test('lost acknowledgement preserves outgoing text; reconnect never resubmits the action',async()=>{
 const f=fixture(true);await f.chat.send('Create the issue');assert.equal(f.chat.savedText.value,'Create the issue');
 assert.equal(f.stored.get(draftKey('fixture','outgoing')),'Create the issue');
 await f.chat.retry();assert.deepEqual(f.counts(),{sends:1,reloads:0});
 await f.chat.send('Create the issue');assert.equal(f.counts().sends,1,'Unresolved attempt blocks another send');
});
test('confirmed completion clears the saved outgoing copy',async()=>{
 const f=fixture(false);await f.chat.send('Hello');assert.equal(f.chat.savedText.value,'');assert.equal(f.stored.size,0);
});
test('rapid double submit invokes transport once; cancel/respond failures are visible',async()=>{
 const f=fixture(false);await Promise.all([f.chat.send('Hello'),f.chat.send('Hello')]);assert.equal(f.counts().sends,1);
 await f.chat.cancel();assert.match(f.chat.error.value.message,/cancel transport/);
 await f.chat.respond([]);assert.match(f.chat.error.value.message,/response transport/);
});

test('replayed delegation does not duplicate subscriptions and a new turn clears old workers',()=>{
 const f=fixture(false),event={type:'subagent.called',data:{childSessionId:'child-1',toolName:'repo',callId:'call-1'}};
 f.event(event);f.event(event);assert.equal(f.workers.value.length,1);
 assert.equal(f.workers.value[0].threadId,'fixture');assert.equal(f.counts().sends,0);
 f.event({type:'turn.started'});assert.equal(f.workers.value.length,0);
});

test('archived progress reconnects a settled stream without repeating the user action',async()=>{
 const f=fixture(false,{messages:[],cursors:[{sessionId:'root',eventId:'evt_002'}]});
 f.agent.session.value={sessionId:'root'};f.agent.events.value=[{meta:{id:'evt_001'}}];
 await f.mount();assert.equal(f.resumes(),1);assert.equal(f.chat.status.value,'streaming');assert.equal(f.counts().sends,0);
});

test('unchanged, foreign and already streaming sessions do not trigger catch-up',async()=>{
 for(const [sessionId,eventId,status]of [['root','evt_001','ready'],['other','evt_002','ready'],['root','evt_002','streaming']]){
  const f=fixture(false,{messages:[],cursors:[{sessionId,eventId}]});
  f.agent.session.value={sessionId:'root'};f.agent.events.value=[{meta:{id:'evt_001'}}];f.agent.status.value=status;
  await f.mount();assert.equal(f.resumes(),0);
 }
});

test('returning to an accepted send clears only its saved copy and preserves the composer draft',async()=>{
 const id=randomUUID(),f=fixture(false,{messages:[],cursors:[],acceptedMessageIds:[id]});
 f.stored.set(draftKey('fixture','outgoing'),'Create issue');
 f.stored.set(draftKey('fixture','attempt'),JSON.stringify({id,text:'Create issue',phase:'sent'}));
 f.stored.set(draftKey('fixture','draft'),'My next question');
 await f.mount();
 assert.equal(f.chat.savedText.value,'');assert.equal(f.stored.get(draftKey('fixture','draft')),'My next question');
 assert.equal(f.stored.has(draftKey('fixture','attempt')),false);assert.equal(f.counts().sends,0);
});

test('same text from an older turn or optimistic UI is not a receipt for a new attempt',async()=>{
 const f=fixture(false,{messages:[{sessionId:'root',at:'now',message:{id:'old',role:'user',parts:[{type:'text',text:'Again'}]}}],cursors:[],acceptedMessageIds:[randomUUID()]});
 f.stored.set(draftKey('fixture','outgoing'),'Again');
 f.stored.set(draftKey('fixture','attempt'),JSON.stringify({id:randomUUID(),text:'Again',phase:'sent'}));
 f.agent.data.value.messages=[{id:'optimistic',role:'user',parts:[{type:'text',text:'Again'}]}];
 await f.mount();assert.equal(f.chat.savedText.value,'Again');assert.equal(f.counts().sends,0);
});

test('legacy saved text is reconciled with the archive even after later turns; unknown text stays',async()=>{
 for(const [text,expected] of [['Last',''],['Older',''],['Unreceived','Unreceived']]){
  const f=fixture(false,{messages:['Older','Last'].map((text,i)=>({sessionId:'root',at:String(i),message:{id:String(i),role:'user',parts:[{type:'text',text}]}})),cursors:[]});
  f.stored.set(draftKey('fixture','outgoing'),text);await f.mount();assert.equal(f.chat.savedText.value,expected);
 }
});

test('live receipt retires the send before the agent finishes; old replay cannot acknowledge it',async()=>{
 const f=fixture(false);let finish;
 f.agent.events.value=[{meta:{id:'evt_002'}}];
 f.agent.send=()=>new Promise(resolve=>finish=resolve);
 const pending=f.chat.send('Hello');await new Promise(resolve=>setImmediate(resolve));
 assert.ok(f.headers()[recovery.CHAT_MESSAGE_HEADER]);
 f.event({type:'message.received',meta:{id:'evt_001'},data:{message:'Hello'}});
 assert.equal(f.chat.savedText.value,'Hello');
 f.event({type:'message.received',meta:{id:'evt_003'},data:{message:'Hello'}});
 assert.equal(f.chat.savedText.value,'');assert.equal(f.chat.isBusy.value,true);
 assert.equal(f.headers()[recovery.CHAT_MESSAGE_HEADER],undefined);
 f.unmount();finish();await pending;
});

test('navigation cancels only the local queued send and late completion preserves a newer attempt',async()=>{
 const waiting=fixture(false);waiting.agent.status.value='resuming';
 const queued=waiting.chat.send('Not yet sent');waiting.unmount();await queued;
 assert.equal(waiting.counts().sends,0);
 assert.equal(JSON.parse(waiting.stored.get(draftKey('fixture','attempt'))).phase,'waiting');
 const f=fixture(false);let finish;f.agent.send=()=>new Promise(resolve=>finish=resolve);
 const pending=f.chat.send('First');await new Promise(resolve=>setImmediate(resolve));f.unmount();
 f.stored.set(draftKey('fixture','outgoing'),'Second');
 f.stored.set(draftKey('fixture','attempt'),JSON.stringify({id:randomUUID(),text:'Second',phase:'sent'}));
 finish();await pending;assert.equal(f.stored.get(draftKey('fixture','outgoing')),'Second');
});

test('a session bound after leaving the page is picked up without creating another turn',async()=>{
 const f=fixture(false,{sessionId:'accepted-after-navigation',messages:[],cursors:[]});
 await f.mount();assert.equal(f.rebinds(),1);assert.equal(f.counts().sends,0);assert.equal(f.resumes(),0);
});

test('automatic transport recovery is bounded and listener cleanup stops it after navigation',async()=>{
 const f=fixture(false,{messages:[],cursors:[{sessionId:'root',eventId:'evt_002'}]});
 let attempts=0;f.agent.session.value={sessionId:'root'};f.agent.status.value='error';f.agent.error.value=Error('network');
 f.agent.resume=async()=>{attempts++;throw Error('network');};
 await f.mount();
 for(let n=0;n<6;n++){f.listeners.focus();await new Promise(resolve=>setImmediate(resolve));}
 assert.equal(attempts,3);assert.equal(f.counts().sends,0);
 f.listeners.online();await new Promise(resolve=>setImmediate(resolve));assert.equal(attempts,4,'A restored network allows another bounded reconnect');
 f.unmount();assert.equal(f.listeners.focus,undefined);
});

