import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    for (const candidate of [`${specifier}.ts`, specifier.replace(/\.js$/, '.ts')]) {
      const url = new URL(candidate, context.parentURL);
      if (candidate !== specifier && existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
  }
  return next(specifier, context);
} });
const [{ default: tool }, { default: instructions }, { default: missions }] = await Promise.all([
  import('../agent/tools/qa_mission.ts'), import('../agent/instructions.ts'), import('../agent/instructions/missions.ts'),
]);
hooks.deregister();
const source = readFileSync(new URL('../server/utils/mission-repository-plan.ts', import.meta.url), 'utf8');
const exports = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports, require: () => ({}) });
const route = exports.inspectedRepositorySurface;
assert.equal(typeof route, 'function');
function inspected(scripts, overrides = {}) {
  const selectedScript = ['test', 'test:unit', 'typecheck', 'lint'].find(key => Object.hasOwn(scripts, key)) ?? 'auto';
  return { mode: 'inspect', package: { scripts }, projects: [{ directory: '.', kind: 'node' }],
    plan: { directory: '.', runtime: 'node24', operationKind: 'inspect', selectedScript, command: ['npm', 'run', selectedScript] }, ...overrides };
}

test('auto prefers actually identified checks over an available application entry', () => {
  for (const script of ['test', 'test:unit', 'typecheck', 'lint']) {
    assert.equal(route(inspected({ [script]: 'node verify.mjs', start: 'node server.mjs' }), 'auto'), 'checks');
  }
});
test('auto permits only the existing app preparation path for observed Node start/dev entries', () => {
  for (const script of ['start', 'dev']) assert.equal(route(inspected({ [script]: 'node application.mjs' }), 'auto'), 'application');
  assert.equal(route(inspected({ start: 'node application.mjs', dev: 'node dev.mjs' }), 'auto'), 'application');
});
test('explicit checks never becomes app or browser work when its command is absent', () => {
  assert.equal(route(inspected({ start: 'node application.mjs' }), 'checks'), 'blocked');
  assert.equal(route(inspected({ test: 'node --test', start: 'node application.mjs' }), 'checks'), 'checks');
});
test('explicit application is not replaced by a repository test suite', () => {
  assert.equal(route(inspected({ test: 'node --test', start: 'node application.mjs' }), 'application'), 'application');
});
test('unknown, unsupported or ambiguous auto inspections cannot guess application startup', () => {
  const valid = inspected({ start: 'node application.mjs' });
  for (const job of [
    inspected({}), inspected({ build: 'node build.mjs' }), inspected({ start: '' }), inspected({ dev: '   ' }),
    { ...valid, plan: null }, { ...valid, package: null }, { ...valid, projects: [] },
    { ...valid, projects: [...valid.projects, ...valid.projects] },
    { ...valid, projects: [{ directory: 'other', kind: 'node' }] },
    { ...valid, plan: { ...valid.plan, runtime: 'unknown' } },
    { ...valid, plan: { ...valid.plan, operationKind: 'test' } },
    ...['../escape', '/absolute', 'app/../../escape', 'C:\\outside'].map(directory => ({ ...valid, plan: { ...valid.plan, directory }, projects: [{ directory, kind: 'node' }] })),
  ]) assert.equal(route(job, 'auto'), 'blocked');
});
test('an inspected nested project may prepare its own existing app entry', () => {
  const job = inspected({ start: 'node app.mjs' });
  job.plan.directory = 'apps/site'; job.projects = [{ directory: 'apps/site', kind: 'node' }, { directory: 'packages/lib', kind: 'node' }];
  assert.equal(route(job, 'auto'), 'application');
});
test('installed Eve descriptor defaults general intake to auto and preserves explicit user scope', () => {
  const target = { kind: 'repository', url: 'https://github.com/example/project', ref: '' };
  const base = { intent: 'explore', target };
  assert.equal(tool.inputSchema.parse(base).target.surface, 'auto');
  for (const surface of ['checks', 'application']) assert.equal(tool.inputSchema.parse({ ...base, target: { ...target, surface } }).target.surface, surface);
  assert.match(tool.description, /suite that needs app startup as a prerequisite/);
  assert.match(tool.description, /never substitute browser QA for that suite/);
  assert.match(tool.description, /conditional startup needed for that behavior/);
  assert.doesNotMatch(tool.description, /checks \(the default/);
});
test('composed instructions distinguish unknown surface from explicit app behavior and suite prerequisites', async () => {
  const main = await instructions.events['session.started']({}, { session: { auth: { current: null } } });
  const missionInstructions = await missions.events['turn.started']({}, { session: { auth: { current: null } } });
  const root = main.content ?? main.markdown, specific = missionInstructions.content ?? missionInstructions.markdown;
  assert.match(root, /general repository QA with no chosen test surface/);
  assert.match(specific, /For general repository QA with no chosen test surface, use auto/);
  assert.match(specific, /test suite stays checks even when it mentions app startup as a prerequisite/);
  assert.match(specific, /never guess commands/);
  assert.doesNotMatch(specific, /surface checks \(or omit surface\)/);
});
