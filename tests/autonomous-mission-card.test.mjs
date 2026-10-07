import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as vue from 'vue';
import { parse, compileScript } from 'vue/compiler-sfc';
import { renderToString } from 'vue/server-renderer';

function component(path, dependencies, globals, inlineTemplate = true) {
  const filename = new URL(path, import.meta.url).pathname;
  const { descriptor } = parse(readFileSync(new URL(path, import.meta.url), 'utf8'), { filename });
  const script = compileScript(descriptor, { id: 'mission-card-test', inlineTemplate });
  const code = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, ...vue, ...globals, require: name => {
    if (name === 'vue') return vue;
    if (name in dependencies) return dependencies[name];
    throw new Error(`Unexpected component dependency: ${name}`);
  } });
  return exports.default;
}
const mission = (extra = {}) => ({ version: 1, id: 'public-mission', threadId: 'original-thread', title: 'Granska kundflödet', intent: 'explore', lifecycle: 'running', phase: 'execute', mandateRevision: 2,
  closureReason: null, deadlineAt: '2026-10-05T14:00:00Z', reportDeadlineAt: null, closedAt: null, observedAt: '2026-10-05T13:00:00Z', allowedActions: ['pause', 'cancel'], waits: [],
  nextStep: { code: 'continue', text: 'Uppdraget fortsätter. Chatten behöver inte vara öppen.' }, cleanupPending: false,
  resources: { held: 1, humanControlled: 0, uncertain: 0 }, execution: { active: 1, overdue: 0, unconfirmedDispatch: 0 },
  scheduler: { state: 'recent_observation', lastObservedAt: '2026-10-05T12:59:00Z' }, workers: { state: 'receipt_observed', lastReceiptAt: '2026-10-05T12:59:30Z' }, report: null, ...extra });
function controls(extra = {}) {
  return { operation: () => undefined, notice: () => '', detail: () => undefined, detailLoading: () => false, detailError: () => '',
    command: async () => { throw new Error('Rendering must not write'); }, retry: async () => { throw new Error('Rendering must not retry'); },
    loadDetails: async () => { throw new Error('Collapsed details must not fetch during render'); }, refresh: async () => {}, ...extra };
}
const button = { props: ['label', 'icon', 'to', 'disabled', 'loading', 'type'], setup(props, { attrs, slots }) {
  return () => vue.h(props.to ? 'a' : 'button', { ...attrs, type: props.type, disabled: props.disabled, href: props.to ? `${props.to.path}?workspaceView=${props.to.query.workspaceView}` : undefined }, props.label || slots.default?.());
} };
async function render(m, extraControls = {}, compact = false) {
  const card = component('../app/components/AutonomousMissionCard.vue', {
    '~/composables/useAutonomousMissions': { useAutonomousMissions: () => controls(extraControls) },
    './EnvironmentConsentPanel.vue': { setup() { throw new Error('Closed consent panel must not mount or fetch'); } },
  },
    { useWorkspaceVault: () => ({ open() { throw new Error('Render must not open Vault'); } }), useAgentActivity: () => ({ requestedItem: vue.ref(null) }) });
  const app = vue.createSSRApp(card, { mission: m, workspaceId: 'workspace', compact });
  app.component('UButton', button);
  app.component('UBadge', { setup(_, { slots }) { return () => vue.h('span', slots.default?.()); } });
  app.component('UIcon', { setup() { return () => vue.h('i'); } });
  app.component('UFormField', { props: ['label', 'description'], setup(props, { slots }) { return () => vue.h('div', [vue.h('label', props.label), vue.h('p', props.description), slots.default?.()]); } });
  app.component('UTextarea', { props: ['modelValue', 'disabled', 'maxlength'], setup(props) { return () => vue.h('textarea', { disabled: props.disabled, maxlength: props.maxlength }, props.modelValue); } });
  return renderToString(app);
}
test('running card shows server phase/actions without exposing private fields or asserting test success', async () => {
  const html = await render(mission({ leaseToken: 'PRIVATE-LEASE', attempts: [{ id: 'PRIVATE-ATTEMPT' }] }));
  assert.match(html, /Granska kundflödet/); assert.match(html, /Utför arbetet/); assert.match(html, /Pausa/); assert.match(html, /Avbryt uppdrag/);
  assert.doesNotMatch(html, /Återuppta|Godkänt|PRIVATE-/);
  assert.match(html, /Uppdateras automatiskt/);
  assert.doesNotMatch(html, /Uppdatera mätvärden|Försök hämta igen/);
});

test('failed automatic telemetry read offers an explicit read retry', async () => {
  const html = await render(mission(), { detailError: () => 'Uppdragets mätvärden kunde inte hämtas.' });
  assert.match(html, /Försök hämta igen/);
  assert.match(html, /role="alert"/);
});

test('queued mission names the resource wait instead of claiming it is starting', async () => {
  const html = await render(mission({ lifecycle: 'accepted', nextStep: { code: 'resource_wait', text: 'Väntar på körplats. Tidigare resurser behöver frigöras.' } }));
  assert.match(html, /Väntar på körplats/); assert.doesNotMatch(html, /Startar/);
  assert.match(html, /Tidigare resurser behöver frigöras/);
});
test('closed report stays distinct from test success and stale evidence is never presented as current', async () => {
  const html = await render(mission({ lifecycle: 'closed', closureReason: 'investigated', allowedActions: [], nextStep: { code: 'read_report', text: 'Öppna rapporten.' },
    report: { id: 'report', itemId: 'item', status: 'completed', freshness: 'stale', deleted: false } }), {}, true);
  assert.match(html, /Rapport sparad/); assert.match(html, /Underlaget har ändrats/); assert.match(html, /inte ett testgodkännande/);
  assert.match(html, /Öppna rapport/); assert.doesNotMatch(html, /underlag är aktuellt|Pausa|Avbryt uppdrag|Återuppta/);
});
test('deleted report cannot be opened and retained human resources remain visible after closure', async () => {
  const html = await render(mission({ lifecycle: 'closed', allowedActions: [], cleanupPending: true, resources: { held: 1, humanControlled: 1, uncertain: 1 },
    report: { id: 'report', itemId: null, status: 'completed', freshness: 'not_applicable', deleted: true } }));
  assert.match(html, /Rapporten är borttagen/); assert.match(html, /under mänsklig kontroll/); assert.doesNotMatch(html, /Öppna rapport/);
});
test('only clarification exposes a text answer; browser and Vault actions never invent a return/consent receipt', async () => {
  const waits = [
    { id: 'clarify', reason: 'clarification', question: 'Vilket flöde?', allowedAnswers: ['text', 'decline'] },
    { id: 'browser', reason: 'human_browser', question: 'Lämna tillbaka webbläsaren.', allowedAnswers: ['browser_returned', 'decline'] },
    { id: 'keys', reason: 'configuration', question: 'Testmiljön behöver nycklar.', allowedAnswers: ['environment_consent', 'decline'] },
  ].map(wait => ({ ...wait, status: 'waiting', deadlineAt: '2026-10-05T13:15:00Z' }));
  const html = await render(mission({ waits }));
  assert.equal((html.match(/<textarea/g) ?? []).length, 1); assert.match(html, /Skriv inga lösenord/);
  assert.match(html, /href="\/chat\/original-thread\?workspaceView=material"/); assert.match(html, /Öppna Vault/);
  assert.doesNotMatch(html, /Bekräfta återlämning|Spara och fortsätt|sessionId|consentId/);
});
test('expired questions expose no send/decline controls and unknown freshness is explicit', async () => {
  const html = await render(mission({ waits: [{ id: 'expired', reason: 'clarification', question: 'För sent', allowedAnswers: [], status: 'deadline_passed', deadlineAt: '2026-10-05T12:00:00Z' }],
    report: { id: 'report', itemId: 'item', status: 'completed', freshness: 'unknown', deleted: false } }));
  assert.match(html, /Svarstiden har gått ut/); assert.match(html, /aktualitet är inte verifierad/);
  assert.doesNotMatch(html, /<textarea|Skicka svar|Avstå från denna del/);
});

test('verified environment wait exposes an explicit plan opener without mounting or fetching consent on card render', async () => {
  const html = await render(mission({ waits: [{ id: 'environment', reason: 'configuration', question: 'Godkänn startplanen', setupJobId: 'verified-job',
    allowedAnswers: ['environment_consent', 'decline'], status: 'waiting', deadlineAt: '2099-01-01T00:00:00Z' }] }));
  assert.match(html, /Granska och godkänn testmiljön/);
  assert.doesNotMatch(html, /Öppna Vault|verified-job|Spara och fortsätt/);
});
test('uncertain command disables new control actions and exposes only explicit same-request retry', async () => {
  const html = await render(mission(), { operation: () => ({ state: 'uncertain', input: { action: 'pause', requestId: 'PRIVATE-REQUEST' } }), notice: () => 'Svaret kunde inte bekräftas.' });
  assert.match(html, /Skicka samma begäran igen/); assert.match(html, /Hämta status/);
  assert.match(html, /<button[^>]*disabled[^>]*>Pausa/); assert.match(html, /<button[^>]*disabled[^>]*>Avbryt uppdrag/); assert.doesNotMatch(html, /PRIVATE-REQUEST/);
});
test('telemetry keeps missing measurements unknown and never invents monetary cost', async () => {
  const m = mission(), telemetry = { timing: { elapsedMs: null }, attempts: { logical: 2, retries: 1 }, tokens: { measuredKnown: null, total: null, unknownAttempts: 2 }, toolCalls: { observed: 0 }, monetaryCost: null };
  const html = await render(m, { detail: () => ({ mission: m, telemetry }) });
  assert.match(html, /Okänd/); assert.match(html, /Okänt · ofullständig mätning/); assert.match(html, /Observerade verktygsanrop<\/dt><dd[^>]*>0<\/dd>/);
  assert.match(html, /Inte uppmätt/); assert.doesNotMatch(html, /0 kr|0 USD/);
});
test('workspace composition separates legacy report controls and never renders a controlled mission twice', async () => {
  const controlled = mission(), legacy = { id: 'legacy', threadId: 'legacy-thread', controllerVersion: null, status: 'active', revision: 2,
    config: { title: 'Tidigare rapportuppdrag', goal: 'Historiskt mål', scope: 'Underlag', criteria: [], caseKeys: [] }, reports: [] };
  const autonomous = { data: vue.ref({ missions: [controlled], hasMore: false }), error: vue.ref(null), pending: vue.ref(false), refresh: async () => {} };
  const view = component('../app/components/WorkspaceMissions.vue', {
    '~/composables/useAutonomousMissions': { useAutonomousMissions: () => autonomous },
    './AutonomousMissionCard.vue': { props: ['mission'], setup(props) { return () => vue.h('article', `autonomous:${props.mission.title}`); } },
  }, {
    useWorkspaces: () => ({ activeId: vue.ref('workspace') }), useWorkspaceAgent: () => vue.ref({ available: false }),
    useAgentActivity: () => ({ requestedItem: vue.ref(null) }),
    useMissions: () => ({ data: vue.ref({ missions: [legacy, { ...legacy, id: controlled.id, controllerVersion: 1, config: { ...legacy.config, title: 'Duplicate controlled card' } }] }), error: vue.ref(null), refresh: async () => {} }),
  });
  const app = vue.createSSRApp(view, { compact: true });
  app.component('UButton', button); app.component('UIcon', { setup() { return () => vue.h('i'); } });
  const html = await renderToString(app);
  assert.equal((html.match(/autonomous:Granska kundflödet/g) ?? []).length, 1);
  assert.match(html, /Tidigare rapportuppdrag/); assert.match(html, /Övriga rapportuppdrag · 1/);
  assert.doesNotMatch(html, /Duplicate controlled card/);
  assert.equal((html.match(/Uppdatera rapport/g) ?? []).length, 1);
});

test('real reactive polling preserves consent expansion and draft answers until mission/workspace identity changes', async () => {
  const card = component('../app/components/AutonomousMissionCard.vue', {
    '~/composables/useAutonomousMissions': { useAutonomousMissions: () => controls() },
    './EnvironmentConsentPanel.vue': {},
  }, { useWorkspaceVault: () => ({ open() {} }), useAgentActivity: () => ({ requestedItem: vue.ref(null) }) }, false);
  // The real compiled setup, actual component props, Vue watchers and scheduling
  // run in a minimal host renderer. No DOM library or copied watcher is involved.
  card.render = () => vue.h('div');
  const renderer = vue.createRenderer({
    createElement: tag => ({ tag }), createText: text => ({ text }), createComment: text => ({ text }),
    setText() {}, setElementText() {}, patchProp() {}, insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null,
  });
  const currentMission = vue.ref(mission()), currentWorkspace = vue.ref('workspace');
  const app = renderer.createApp({ setup: () => () => vue.h(card, { workspaceId: currentWorkspace.value, mission: currentMission.value }) });
  app.mount({});
  const state = app._instance.subTree.component.setupState;
  try {
    state.expandedConsent = 'environment-wait'; state.answers = { clarify: 'A draft answer' };
    currentMission.value = { ...currentMission.value, observedAt: '2026-10-05T13:00:01Z' };
    await vue.nextTick();
    assert.equal(state.expandedConsent, 'environment-wait'); assert.equal(state.answers.clarify, 'A draft answer');
    currentMission.value = { ...currentMission.value, id: 'different-mission' };
    await vue.nextTick();
    assert.equal(state.expandedConsent, null); assert.equal(Object.keys(state.answers).length, 0);
    state.expandedConsent = 'new-wait'; state.answers = { next: 'Another draft' };
    currentWorkspace.value = 'different-workspace'; await vue.nextTick();
    assert.equal(state.expandedConsent, null); assert.equal(Object.keys(state.answers).length, 0);
  } finally { app.unmount(); }
});
