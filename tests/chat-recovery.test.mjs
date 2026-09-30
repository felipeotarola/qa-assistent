import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { ref, computed, watch } from 'vue';
import { draftKey } from '../shared/chat-recovery.ts';

function fixture(fail, history = { messages: [], cursors: [] }) {
  let sends=0,reloads=0,resumes=0,callbacks;const mounted=[],stored=new Map(),failures={},workers=ref([]);
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
    '#shared/browser':{BROWSER_THREAD_HEADER:'thread'}, '#shared/chat-recovery':{draftKey},
  };
  const source=fs.readFileSync(new URL('../app/composables/chat/useChatSession.ts',import.meta.url),'utf8').replaceAll('import.meta.client','true').replaceAll('import.meta.dev','false');
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};vm.runInNewContext(js,{Error,exports,require:name=>{assert.ok(imports[name],name);return imports[name];},ref,computed,watch,
    useAgentActivity:()=>({workers}),useChatModel:()=>ref('test'),useChatReasoning:()=>ref('low'),useEveAgent:options=>{callbacks=options;return agent;},useState:(_key,init)=>ref(init()),onMounted(fn){mounted.push(fn);},onBeforeUnmount(){},$fetch:async()=>history,
    sessionStorage:{getItem:k=>stored.get(k),setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k)},window:{location:{reload(){reloads++;}}},setTimeout:()=>0,clearTimeout});
  const chat=exports.useChatSession({id:'fixture',sessionId:null,history:[]});
  return { chat,stored,agent,workers,event:e=>callbacks.onEvent(e),counts:()=>({sends,reloads}),resumes:()=>resumes,mount:async()=>{mounted.forEach(fn=>fn());await new Promise(resolve=>setImmediate(resolve));} };
}
test('lost acknowledgement preserves outgoing text; reconnect never resubmits the action',async()=>{
 const f=fixture(true);await f.chat.send('Create the issue');assert.equal(f.chat.savedText.value,'Create the issue');
 assert.equal(f.stored.get(draftKey('fixture','outgoing')),'Create the issue');
 f.chat.retry();assert.deepEqual(f.counts(),{sends:1,reloads:1});
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

