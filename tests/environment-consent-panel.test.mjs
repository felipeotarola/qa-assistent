import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as vue from 'vue';
import { parse, compileScript } from 'vue/compiler-sfc';
import * as environment from '../shared/project-environment.ts';
import { createEnvironmentConsentClient, usableEnvironmentConsent } from '../app/composables/useEnvironmentConsent.ts';

// Execute the actual SFC setup/render/event code with a memory-only Vue host.
// Nuxt controls are represented by their normal semantic elements; these tests
// verify product events and state, not the library's browser implementation.
function compile(path, dependencies, globals) {
  const filename = new URL(path, import.meta.url).pathname;
  const { descriptor } = parse(readFileSync(new URL(path, import.meta.url), 'utf8'), { filename });
  const compiled = compileScript(descriptor, { id: 'environment-consent-test', inlineTemplate: true });
  const code = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, ...vue, ...globals, require: name => {
    if (name === 'vue') return vue;
    if (name in dependencies) return dependencies[name];
    throw new Error(`Unexpected component dependency: ${name}`);
  } });
  return exports.default;
}
function node(tag, text = '') { return { tag, text, props: {}, children: [], parent: null }; }
function detach(child) {
  if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
  child.parent = null;
}
const renderer = vue.createRenderer({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (target, text) => { target.text = text; }, setElementText: (target, text) => { target.text = text; target.children = []; },
  patchProp: (target, key, previous, value) => { target.props[key] = value; }, parentNode: target => target.parent,
  nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
  remove: detach, insert: (child, parent, anchor = null) => {
    detach(child); child.parent = parent;
    parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, child);
  },
});
const button = { props: ['label', 'disabled'], setup: (props, { attrs, slots }) => () => vue.h('button', { ...attrs, disabled: props.disabled }, props.label || slots.default?.()) };
const field = { props: ['label', 'description'], setup: (props, { slots }) => () => vue.h('label', [props.label, slots.default?.(), props.description]) };
const select = { props: ['modelValue', 'disabled', 'items'], setup: (props, { attrs }) => () => vue.h('select', { ...attrs, disabled: props.disabled, value: props.modelValue }, props.items?.map(item => vue.h('option', { value: item.value }, item.label))) };
const checkbox = { props: ['label', 'description', 'modelValue', 'disabled'], setup: (props, { slots }) => () => vue.h('label', [vue.h('input', { type: 'checkbox', checked: props.modelValue, disabled: props.disabled, name: props.label }), slots.label?.() ?? props.label, props.description]) };
function mount(component, props) {
  const root = node('root'), reactiveProps = vue.reactive(props);
  const app = renderer.createApp({ setup: () => () => vue.h(component, reactiveProps) });
  app.component('UButton', button); app.component('UFormField', field); app.component('USelect', select); app.component('UCheckbox', checkbox);
  app.component('UInput', { props: ['modelValue', 'disabled', 'type'], setup: (props, { attrs }) => () => vue.h('input', { ...attrs, value: props.modelValue, disabled: props.disabled, type: props.type }) });
  app.component('UModal', { setup: (_, { slots }) => () => vue.h('section', [slots.body?.(), slots.footer?.()]) });
  app.component('UIcon', { setup: () => () => vue.h('i') });
  app.mount(root);
  return { root, props: reactiveProps, close: () => app.unmount() };
}
function text(root) { return root.tag === '#comment' ? '' : root.text + root.children.map(text).join(' '); }
function all(root, predicate) { return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))]; }
function findButton(root, label) { return all(root, item => item.tag === 'button' && text(item) === label)[0]; }
async function settle() { await new Promise(resolve => setImmediate(resolve)); await vue.nextTick(); }
async function click(root, label) {
  const element = findButton(root, label); assert.ok(element, `Missing ${label}`); assert.ok(!element.props.disabled, `Disabled ${label}`);
  await element.props.onClick(); await settle();
}
const plan = { version: 1, repoUrl: 'https://github.com/owner/project', root: '/workspace/project', directory: '/workspace/project/app', commit: 'a'.repeat(40), command: 'npm run start -- --host 0.0.0.0', port: 3000,
  variables: [{ name: 'REQUIRED_KEY', required: true }, { name: 'OPTIONAL_KEY', required: false }] };
const status = (extra = {}) => ({ setupJobId: 'job', plan, planHash: 'b'.repeat(64), vaultRevision: 3, configuredNames: ['REQUIRED_KEY', 'OPTIONAL_KEY'], missingNames: [], consents: [], ...extra });
const receipt = (extra = {}) => ({ id: 'confirmed-consent', revision: 1, grantSetupJobId: 'job', repoUrl: plan.repoUrl, environment: 'test', plan, planHash: 'b'.repeat(64), allowedNames: ['REQUIRED_KEY'], vaultRevision: 3,
  expiresAt: '2099-01-01T00:00:00Z', revokedAt: null, createdAt: '2026-10-05T00:00:00Z', status: 'active', ...extra });
function panel(extraStatus = {}, extraState = {}, extraProps = {}) {
  const state = vue.reactive({ status: status(extraStatus), loading: false, generation: 0, notice: '', ...extraState });
  const reads = [], grants = [], retries = [], approved = [], vault = [];
  const behavior = { grant: async () => receipt(), retry: async () => receipt() };
  const component = compile('../app/components/EnvironmentConsentPanel.vue', {
    '~/composables/useEnvironmentConsent': { usableEnvironmentConsent, useEnvironmentConsent: () => ({ state: () => state,
      load: async (...args) => { reads.push(args); }, grant: async (...args) => { grants.push(args); return behavior.grant(); },
      retry: async (...args) => { retries.push(args); return behavior.retry(); },
    }) },
  }, { useWorkspaceVault: () => ({ open: (...args) => vault.push(args) }) });
  return { ...mount(component, { workspaceId: 'workspace', setupJobId: 'job', deadlineAt: '2098-01-01T00:00:00Z', onApproved: value => approved.push(value), ...extraProps }), state, reads, grants, retries, approved, vault, behavior };
}

function deferredPanel() {
  // Intentionally do not call client.state before mount: the immediate watcher
  // must create the entry before the first render, exactly like a fresh panel.
  const states = vue.ref({}), reads = [], writes = [], approved = [];
  const client = createEnvironmentConsentClient({ states, makeId: () => 'request', now: () => Date.now(),
    read: (url, options) => new Promise((resolve, reject) => reads.push({ url, options, resolve, reject })),
    post: async (...args) => { writes.push(args); return receipt(); },
  });
  const component = compile('../app/components/EnvironmentConsentPanel.vue', {
    '~/composables/useEnvironmentConsent': { usableEnvironmentConsent, useEnvironmentConsent: () => client },
  }, { useWorkspaceVault: () => ({ open() {} }) });
  return { ...mount(component, { workspaceId: 'workspace', setupJobId: 'job', deadlineAt: '2098-01-01T00:00:00Z', onApproved: value => approved.push(value) }), states, reads, writes, approved };
}

test('first deferred load renders the plan and clears loading through actual Vue reactivity without precreating state', async t => {
  const p = deferredPanel(); t.after(p.close); await settle();
  assert.equal(p.reads.length, 1); assert.match(text(p.root), /Hämtar aktuell startplan/);
  assert.equal(findButton(p.root, 'Godkänn och fortsätt'), undefined);
  p.reads[0].resolve(status()); await settle();
  assert.doesNotMatch(text(p.root), /Hämtar aktuell startplan/);
  assert.match(text(p.root), /npm run start/);
  assert.equal(findButton(p.root, 'Godkänn och fortsätt').props.disabled, false);
  assert.equal(all(p.root, item => item.tag === 'input' && item.props.name === 'REQUIRED_KEY')[0].props.checked, true);
  assert.equal(p.writes.length, 0); assert.deepEqual(p.approved, []);
});

test('first deferred failure renders the error and explicit refresh can load the same fresh panel', async t => {
  const p = deferredPanel(); t.after(p.close); await settle();
  p.reads[0].reject(new Error('Unavailable')); await settle();
  assert.doesNotMatch(text(p.root), /Hämtar aktuell startplan/);
  assert.match(text(p.root), /Startplanen kunde inte hämtas/);
  assert.equal(findButton(p.root, 'Godkänn och fortsätt'), undefined);
  const refreshed = findButton(p.root, 'Hämta aktuell status').props.onClick(); await settle();
  assert.equal(p.reads.length, 2); assert.match(text(p.root), /Hämtar aktuell startplan/);
  p.reads[1].resolve(status()); await refreshed; await settle();
  assert.equal(findButton(p.root, 'Godkänn och fortsätt').props.disabled, false);
  assert.equal(p.writes.length, 0); assert.deepEqual(p.approved, []);
});

test('same workspace/job props preserve selection without reloading; navigation resets it and ignores the old deferred read', async t => {
  const p = deferredPanel(); t.after(p.close); await settle();
  p.reads[0].resolve(status()); await settle();
  const duration = () => all(p.root, item => item.tag === 'select')[0];
  duration().props['onUpdate:modelValue'](168); await settle(); assert.equal(duration().props.value, 168);
  Object.assign(p.props, { workspaceId: 'workspace', setupJobId: 'job', deadlineAt: '2098-01-02T00:00:00Z' }); await settle();
  assert.equal(p.reads.length, 1); assert.equal(duration().props.value, 168);
  p.props.setupJobId = 'next-job'; await settle();
  assert.equal(p.reads.length, 2); assert.equal(findButton(p.root, 'Godkänn och fortsätt'), undefined);
  p.props.workspaceId = 'other-workspace'; await settle(); assert.equal(p.reads.length, 3);
  p.reads[2].resolve(status({ setupJobId: 'next-job', plan: { ...plan, command: 'correct-new-command' } })); await settle();
  assert.equal(duration().props.value, 24); assert.match(text(p.root), /correct-new-command/);
  p.reads[1].resolve(status({ setupJobId: 'next-job', plan: { ...plan, command: 'late-old-command' } })); await settle();
  assert.match(text(p.root), /correct-new-command/); assert.doesNotMatch(text(p.root), /late-old-command/);
  assert.equal(p.writes.length, 0); assert.deepEqual(p.approved, []);
});

test('opening shows the complete current plan, requires explicit approval and defaults optional names off', async t => {
  const p = panel(); t.after(p.close); await settle();
  assert.equal(p.reads.length, 1); assert.equal(p.grants.length, 0); assert.deepEqual(p.approved, []);
  for (const value of [plan.repoUrl, plan.commit, plan.root, plan.directory, plan.command, '3000', '2098']) assert.ok(text(p.root).includes(value));
  const inputs = all(p.root, item => item.tag === 'input');
  assert.equal(inputs.find(input => input.props.name === 'REQUIRED_KEY').props.checked, true);
  assert.equal(inputs.find(input => input.props.name === 'OPTIONAL_KEY').props.checked, false);
  await click(p.root, 'Godkänn och fortsätt');
  assert.deepEqual(JSON.parse(JSON.stringify(p.grants)), [['workspace', 'job', ['REQUIRED_KEY'], 24]]);
  assert.deepEqual(p.approved, ['confirmed-consent']);
});

test('existing valid receipt is selectable only through an explicit click and never grants again', async t => {
  const p = panel({ consents: [receipt(), receipt({ id: 'expired-consent', status: 'expired' })] }); t.after(p.close); await settle();
  assert.equal(p.approved.length, 0); assert.equal(p.grants.length, 0);
  assert.ok(findButton(p.root, 'Använd medgivandet och fortsätt'));
  assert.equal(all(p.root, item => item.tag === 'option' && item.props.value === 'expired-consent').length, 0);
  await click(p.root, 'Använd medgivandet och fortsätt');
  assert.deepEqual(p.approved, ['confirmed-consent']); assert.equal(p.grants.length, 0);
});

test('uncertain grant displays its frozen plan/names/expiry and exposes only same-request retry', async t => {
  const pending = { state: 'uncertain', plan: { ...plan, command: 'original-command' }, body: { allowedNames: ['REQUIRED_KEY'], expiresAt: '2097-01-02T00:00:00Z' } };
  const p = panel({ plan: { ...plan, command: 'replacement-command' } }, { pending }); t.after(p.close); await settle();
  assert.match(text(p.root), /original-command/); assert.doesNotMatch(text(p.root), /replacement-command/);
  assert.match(text(p.root), /2097/); assert.equal(findButton(p.root, 'Godkänn och fortsätt'), undefined);
  await click(p.root, 'Försök samma godkännande igen');
  assert.equal(p.retries.length, 1); assert.equal(p.grants.length, 0);
});

test('expired wait and missing required keys cannot approve; Vault opens the exact prepared job', async t => {
  const p = panel({ configuredNames: ['OPTIONAL_KEY'], missingNames: ['REQUIRED_KEY'] }); t.after(p.close); await settle();
  assert.equal(findButton(p.root, 'Godkänn och fortsätt').props.disabled, true);
  assert.match(text(p.root), /saknade obligatoriska variablerna/);
  await click(p.root, 'Öppna Vault'); assert.deepEqual(p.vault, [['workspace', 'job']]);
  p.state.status = status(); p.props.deadlineAt = '2020-01-01T00:00:00Z'; await settle();
  const approve = findButton(p.root, 'Godkänn och fortsätt'); assert.equal(approve.props.disabled, true);
  await approve.props.onClick(); assert.equal(p.grants.length, 0);
  p.state.pending = { state: 'uncertain', plan, body: { allowedNames: ['REQUIRED_KEY'], expiresAt: '2097-01-01T00:00:00Z' } }; await settle();
  const retry = findButton(p.root, 'Försök samma godkännande igen'); assert.equal(retry.props.disabled, true);
  await retry.props.onClick(); assert.equal(p.retries.length, 0);
});

test('a late grant receipt cannot answer a different workspace/job after navigation', async t => {
  const p = panel(); t.after(p.close); await settle();
  let release; p.behavior.grant = () => new Promise(resolve => { release = resolve; });
  const operation = findButton(p.root, 'Godkänn och fortsätt').props.onClick();
  p.props.workspaceId = 'other-workspace'; p.props.setupJobId = 'other-job'; await settle();
  release(receipt()); await operation; assert.deepEqual(p.approved, []);
});

test('Vault saves autonomous job keys without rendering or invoking the legacy continue endpoint', async t => {
  const request = vue.ref(null), calls = [];
  const entry = { repoUrl: plan.repoUrl, configuredNames: ['REQUIRED_KEY'], revision: 3 };
  const component = compile('../app/components/WorkspaceVault.vue', { '#shared/project-environment': environment }, {
    useWorkspaceVault: () => ({ request }), useWorkspaces: () => ({ activeId: vue.ref('workspace') }),
    $fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/setup-jobs')) return { jobs: [{ id: 'job', status: 'needs_configuration', autonomous: true, result: { environment: plan } }] };
      if (url.endsWith('/vault')) return options ? { ...entry, revision: 4 } : { entries: [entry] };
      throw new Error('Autonomous Vault must never invoke legacy continue');
    },
  });
  const p = mount(component, {}); t.after(p.close);
  request.value = { workspaceId: 'workspace', jobId: 'job' }; await settle();
  assert.equal(findButton(p.root, 'Spara och fortsätt'), undefined);
  assert.match(text(p.root), /uppdragets startplan/);
  await click(p.root, 'Spara i Vault');
  assert.equal(calls.filter(call => call.options?.method === 'PUT').length, 1);
  assert.equal(calls.find(call => call.options?.method === 'PUT').url, '/api/workspaces/workspace/vault');
  assert.equal(calls.some(call => call.options?.body.continue === true), false);
});
