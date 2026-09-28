import { test } from 'node:test';import assert from 'node:assert/strict';
import { confirmedEvidence } from '../server/utils/confirmed-evidence.ts';
const result={id:'1',title:'Issue',body:'Private content',url:'https://linear.app/team/issue/QA-1'};
const items=[{id:'document',version:3}],context={operationId:'operation',workspaceId:'workspace',provider:'linear',threadId:'chat'};
test('only confirmed publication generates evidence, pinned to the source version',()=>{
 for(const state of ['pending','unknown','failed']) assert.deepEqual(confirmedEvidence(state,result,items,context),[]);
 assert.deepEqual(confirmedEvidence('complete',undefined,items,context),[]);
 const [link]=confirmedEvidence('complete',result,items,context);assert.equal(link.itemVersion,3);assert.equal(link.threadId,'chat');assert.equal(link.url,result.url);assert.equal(link.body,undefined);
 assert.deepEqual(confirmedEvidence('complete',result,items,context),[link],'Replay uses stable IDs');
});
test('untrusted provider URLs cannot become executable links',()=>{
 assert.throws(()=>confirmedEvidence('complete',{...result,url:'javascript:alert(1)'},items,context));
});
