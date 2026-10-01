import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repositoryMapTask, repositoryMapTarget, parseRepositoryMapReport } from '../shared/repository-map.ts';
import { diagramSchema, repositoryCodeUrl } from '../shared/diagram.ts';

const url = 'https://github.com/felipeotarola/surdeg';
const task = repositoryMapTask(url, 'Map authentication');
const report = () => ({ kind: 'diagram', repository: { url, commit: 'a'.repeat(40) }, nodes: [{ id: 'auth', label: 'Auth', code: [{ path: 'apps/web/auth.ts', line: 12 }] }], edges: [] });
test('map jobs preserve target and require a bounded canonical repository', () => {
  assert.equal(repositoryMapTarget(task), url);
  assert.equal(repositoryMapTarget('Start app'), null);
  assert.throws(() => repositoryMapTask('https://user:secret@github.com/o/r', 'map'));
  assert.throws(() => repositoryMapTask(url, 'x'.repeat(9001)));
});
test('map results require a commit, code references and matching repository', () => {
  assert.equal(parseRepositoryMapReport(task, JSON.stringify(report())).repository.commit, 'a'.repeat(40));
  for (const mutate of [r => r.repository.commit = 'main', r => r.repository.url = 'https://github.com/other/repo', r => r.nodes = [], r => r.nodes[0].code = [], r => r.nodes[0].code[0].path = '../.env', r => r.nodes[0].code[0].path = '/etc/passwd', r => r.nodes[0].code[0].line = 0]) {
    const value = report(); mutate(value); assert.throws(() => parseRepositoryMapReport(task, JSON.stringify(value)));
  }
  assert.throws(() => parseRepositoryMapReport(task, '```json\n{}\n```'));
});
test('code links use fixed commits and encode filenames; old diagrams still parse', () => {
  assert.equal(repositoryCodeUrl(report().repository, { path: 'apps/a b.ts', line: 4 }), `${url}/blob/${'a'.repeat(40)}/apps/a%20b.ts#L4`);
  assert.equal(diagramSchema.parse({ kind: 'diagram', nodes: [], edges: [] }).repository, undefined);
});
test('worker Git provenance never becomes a workspace foreign-key reference', () => {
  assert.deepEqual(parseRepositoryMapReport(task, JSON.stringify({...report(), sources:[{type:'git',commit:'a'.repeat(40)}]})).sources, []);
  assert.throws(() => parseRepositoryMapReport(task, JSON.stringify({...report(),sources:[{itemId:'4a050d1e-8008-497c-8047-bc683d46488c',version:1}]})));
});
