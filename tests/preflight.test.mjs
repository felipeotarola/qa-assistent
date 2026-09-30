import test from 'node:test';
import assert from 'node:assert/strict';
import { executionPlan } from '../infra/repo-runner/preflight.mjs';
const request = { script: 'auto', mode: 'test' };
const node = (directory = '.', extra = {}) => ({ directory, kind: 'node', scripts: { typecheck: 'tsc --noEmit' }, lock: true, ...extra });
test('monorepo requires an explicit choice when there is no root project', () => {
  const projects = [node('apps/web'), node('apps/api')];
  assert.throws(() => executionPlan({ projects }, request), /Välj projektkatalog/);
  assert.equal(executionPlan({ projects }, { ...request, directory: 'apps/api' }).directory, 'apps/api');
});
test('auto uses existing checks; explicit scripts are never substituted', () => {
  const metadata = { projects: [node()] };
  assert.equal(executionPlan(metadata, request).operationKind, 'static-check');
  assert.throws(() => executionPlan(metadata, { ...request, script: 'test' }), /Inget körbart/);
});

test('Next 16 legacy lint is diagnosed before installation without substituting build', () => {
  const metadata = { projects: [node('package', { nextVersion: '^16.0.3', scripts: { dev: 'next dev', build: 'next build', lint: 'next lint' } })] };
  for (const script of ['auto', 'lint']) assert.throws(() => executionPlan(metadata, { ...request, script }), /next lint som togs bort i Next.js 16/);
  assert.equal(executionPlan(metadata, { ...request, script: 'build' }).selectedScript, 'build');
  assert.equal(executionPlan(metadata, { ...request, mode: 'inspect' }).project.scripts.dev, 'next dev');
  metadata.projects[0].nextVersion = '^15.0.3';
  assert.equal(executionPlan(metadata, request).selectedScript, 'lint');
  metadata.projects[0].nextVersion = '^16.0.3';
  metadata.projects[0].scripts.lint = 'eslint .';
  assert.equal(executionPlan(metadata, request).selectedScript, 'lint');
});

test('persistent service scripts are directed to the sandbox, not bounded test jobs', () => {
  for (const script of ['dev', 'start', 'serve']) {
    const metadata = { projects: [node('.', { scripts: { [script]: 'node server.js' } })] };
    assert.throws(() => executionPlan(metadata, { ...request, script }), /Eve-sandboxen/);
    assert.equal(executionPlan(metadata, { ...request, mode: 'inspect', script }).selectedScript, script);
  }
});
test('runtime ranges are not silently treated as compatible', () => {
  assert.equal(executionPlan({ projects: [node('.', { engines: { node: '^22.0.0' } })] }, request).runtime, 'node22');
  assert.throws(() => executionPlan({ projects: [node('.', { engines: { node: '>=18 <20' } })] }, request), /miljöprofil/);
});
test('Maven, Gradle wrapper and Python have distinct plans', () => {
  const java = executionPlan({ projects: [{ directory: '.', kind: 'java', buildSystem: 'maven' }] }, request);
  assert.deepEqual(java.command, ['mvn', '-B', '-Dmaven.repo.local=/workspace/.m2/repository', 'test']);
  assert.throws(() => executionPlan({ projects: [{ directory: '.', kind: 'java', buildSystem: 'gradle' }] }, request), /wrapper/);
  const python = executionPlan({ projects: [{ directory: '.', kind: 'python', requirements: true }] }, request);
  assert.equal(python.runtime, 'python3'); assert.ok(python.install.some(command => command.includes('requirements.txt')));
});
