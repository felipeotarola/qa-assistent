import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    for (const candidate of [`${specifier}.ts`, specifier.replace(/\.js$/, '.ts')]) {
      const url = new URL(candidate, context.parentURL);
      if (candidate !== specifier && existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
  }
  return next(specifier, context);
} });
const [{ default: instructions }, { default: codexInstructions }, { default: codex }, { default: repository }] = await Promise.all([
  import('../agent/instructions.ts'), import('../agent/instructions/codex.ts'),
  import('../agent/tools/codex.ts'), import('../agent/tools/repository.ts'),
]);
hooks.deregister();
const text = definition => definition.content ?? definition.markdown;

// These exercise installed Eve definitions and their actual dynamic resolvers.
// They verify authored routing contracts, not an external model's tool choice.
test('root session instructions scope the startup recipe to standalone work', async () => {
  const previousFetch = globalThis.fetch; let reads = 0;
  globalThis.fetch = async () => { reads++; throw new Error('No profile or service request is part of this descriptor test'); };
  try {
    const value = text(await instructions.events['session.started']({}, { session: { auth: { current: null } } }));
    assert.match(value, /QA of app or browser behavior, including any necessary startup, is one autonomous assignment/);
    assert.match(value, /Do not split off its setup into codex or bash/);
    assert.match(value, /direct setup recipe applies only.*standalone app start or preview without a QA assignment/);
    assert.match(value, /surface checks for repository or CLI functions, test suites or static checks that do not require exercising a running app or browser/);
    assert.match(value, /behavior that requires a running app even when the user did not explicitly ask to start it/);
    assert.match(value, /Use surface application when the requested behavior requires a running app or browser/);
    assert.doesNotMatch(value, /First distinguish the user's goal: a repository check\/build is a bounded job/);
    assert.equal(reads, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('enabled Otto instructions keep QA delegation and standalone setup mutually exclusive', async t => {
  const previous = process.env.CODEX_ACCESS_MODE; process.env.CODEX_ACCESS_MODE = 'shared';
  t.after(() => { if (previous === undefined) delete process.env.CODEX_ACCESS_MODE; else process.env.CODEX_ACCESS_MODE = previous; });
  const value = text(await codexInstructions.events['turn.started']({}, { session: { auth: { current: { authenticator: 'app', principalId: '11111111-1111-4111-8111-111111111111', attributes: {} } } } }));
  assert.match(value, /qa_mission with repository surface application/);
  assert.match(value, /Do not start its setup separately with codex/);
  assert.match(value, /only for an explicitly requested standalone installation, app start, setup diagnosis or read-only repository architecture map/);
  assert.match(value, /For a map, use mode repository_map; never install or start an app merely to map it/);
  assert.doesNotMatch(value, /After verified HTTP readiness, continue only the originally authorized tests/);
  assert.match(value, /do not append a QA pipeline to this direct setup job/);
});

test('model-visible direct tool descriptions advertise the same boundary without changing their schemas', () => {
  assert.match(codex.description, /standalone repository setup\/start\/diagnosis/);
  assert.match(codex.description, /QA of app or browser behavior must use qa_mission with repository surface application/);
  assert.match(codex.description, /read-only repository architecture map/);
  assert.match(codex.description, /never install or start an app merely to map it/);
  assert.ok(codex.inputSchema.safeParse({ action: 'start', mode: 'repository_map', repositoryUrl: 'https://github.com/example/project', task: 'Map the architecture without running the app' }).success);
  assert.match(repository.description, /do not require exercising a running app or browser, use qa_mission with repository surface checks/);
  assert.match(repository.description, /standalone app start without QA, use codex/);
  assert.match(repository.description, /requested behavior requires a running app or browser, use surface application even without an explicit start request/);
  assert.match(codex.description, /including necessary startup even without an explicit start request/);
  assert.ok(codex.inputSchema.safeParse({ action: 'start', task: 'Start the app so I can inspect it myself' }).success);
  assert.ok(codex.inputSchema.safeParse({ action: 'status', jobId: '11111111-1111-4111-8111-111111111111' }).success);
  assert.ok(repository.inputSchema.safeParse({ action: 'connect', url: 'https://github.com/example/project', script: 'test' }).success);
});
