import test from 'node:test';
import assert from 'node:assert/strict';
import { assertIsolatedRoundTrip } from './helpers/autonomy-isolation.mjs';
const expected={workspaceId:'11111111-1111-4111-8111-111111111111',threadId:'22222222-2222-4222-8222-222222222222',userId:'33333333-3333-4333-8333-333333333333'};
const observed=()=>({workspaces:[{id:expected.workspaceId,user_id:expected.userId}],threads:[{id:expected.threadId,workspace_id:expected.workspaceId,user_id:expected.userId}]});
test('requires the API-created workspace and thread in the observed isolated database',()=>assert.doesNotThrow(()=>assertIsolatedRoundTrip(expected,observed())));
test('empty local database does not certify an API writing elsewhere',()=>assert.throws(()=>assertIsolatedRoundTrip(expected,{workspaces:[],threads:[]})));
test('wrong workspace, owner or thread fails before model submission',()=>{
  for(const alter of [x=>x.workspaces[0].user_id=expected.threadId,x=>x.threads[0].workspace_id=expected.userId,x=>x.threads[0].id=expected.workspaceId,x=>x.threads=[]]){const rows=observed();alter(rows);assert.throws(()=>assertIsolatedRoundTrip(expected,rows));}
});
