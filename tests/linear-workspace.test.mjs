import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLinearProject } from '../server/utils/linear-workspace.ts';
const destination = { provider: 'linear', targetId: 'team', projectId: 'project', label: 'Surdeg' };
const project = { id: 'project', name: 'Surdeg', teams: { nodes: [{ id: 'team' }] }, issues: { nodes: [] }, documents: { nodes: [] } };
test('project read scopes query to configured project/team and forwards pagination', async () => {
  const result = await readLinearProject('secret', destination, { issues: 'next', documents: 'docs' }, async (url, options) => {
    assert.equal(url, 'https://api.linear.app/graphql');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body).variables, { id: 'project', team: 'team', issues: 'next', documents: 'docs' });
    return Response.json({ data: { project } });
  });
  assert.equal(result.name, 'Surdeg');
  assert.equal(result.teams, undefined);
});
test('rejects moved projects, upstream partial errors and disconnected access', async () => {
  for (const response of [
    Response.json({ data: { project: { ...project, teams: { nodes: [] } } } }),
    Response.json({ data: { project }, errors: [{ message: 'partial' }] }),
    new Response('', { status: 401 }),
  ]) await assert.rejects(readLinearProject('secret', destination, {}, async () => response));
});
test('requires a configured project before any network request', async () => {
  await assert.rejects(readLinearProject('secret', { ...destination, projectId: undefined }, {}, async () => { assert.fail('must not call provider'); }));
});
