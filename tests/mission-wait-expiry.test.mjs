import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const { assembleReport, unassessedReportDraft, reportText } = await import(pathToFileURL(resolve('shared/mission-report.ts')).href);
const { redactReportText, sourceScopedLimitations } = await import(pathToFileURL(resolve('shared/mission.ts')).href);
const source = readFileSync(process.env.EXPIRED_WAIT_TEST_SOURCE ?? new URL('../server/utils/mission-attempts.ts', import.meta.url), 'utf8');
const missionsSource = readFileSync(resolve('server/utils/missions.ts'), 'utf8');
const redactionSource = readFileSync(resolve('server/utils/mission-redaction.ts'), 'utf8');

// Exact product bodies with synthetic ports: no application imports, SQL or Vault.
function compile(text, name, ports = {}) {
  const ast = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name);
  const body = ts.transpileModule(node.getText(ast).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(ports), `${body}; return ${name};`)(...Object.values(ports));
}

const now = new Date('2026-10-07T00:00:00.000Z');
function fixture() {
  const mission = { id: 'mission', workspaceId: 'workspace', config: { title: 'QA', goal: 'Review available results', scope: '', target: null, caseKeys: [], criteria: [{ id: 'qa', text: 'Observed result' }] } };
  const tasks = ['first', 'second', 'answered', 'future', 'terminal', 'foreign'].map(id => ({ id, title: id, missionId: mission.id, state: id === 'terminal' ? 'completed' : 'waiting', blockedReason: `Original ${id}`, actor: 'main', criterionIds: ['qa'], parentId: null, dependsOn: [], sources: [], results: [] }));
  const waits = tasks.map((task, i) => ({ id: `wait-${task.id}`, missionId: task.id === 'foreign' ? 'another-mission' : mission.id,
    state: task.id === 'answered' ? 'answered' : 'waiting', deadlineAt: new Date(now.getTime() + (task.id === 'future' ? 1000 : -i)),
    definition: { taskIds: [task.id], question: `Question for ${task.id}?`, deadlineAt: 'saved definition remains unchanged', planRevision: 1, mandateRevision: 1 } }));
  const events = [], writes = [];
  const tables = { waits, tasks };
  const table = name => Object.fromEntries(['id', 'missionId', 'state'].map(key => [key, key]).concat([['table', name]]));
  const missionWaits = table('waits'), missionTasks = table('tasks');
  const eq = (field, value) => row => row[field] === value, and = (...conditions) => row => conditions.every(condition => condition(row));
  const connection = {
    select: () => ({ from: table => ({ where: async condition => tables[table.table].filter(condition).map(row => structuredClone(row)) }) }),
    update: table => ({ set: values => ({ where: async condition => {
      for (const row of tables[table.table].filter(condition)) { writes.push({ table: table.table, id: row.id, values: structuredClone(values) }); Object.assign(row, values); }
    } }) }),
  };
  const expire = compile(source, 'expireMissionWaits', { databaseNow: async () => now, missionWaits, missionTasks, eq, and,
    recordMissionEvent: async (_connection, _mission, type, data) => { events.push({ type, data }); } });
  return { mission, waits, tasks, connection, missionTasks, eq, events, writes, run: () => expire(connection, mission) };
}

test('expiry keeps each exact historical question and its own deadline on the affected task', async () => {
  const f = fixture(), definitions = structuredClone(f.waits.map(wait => wait.definition));
  await f.run();
  for (const id of ['first', 'second']) {
    const task = f.tasks.find(task => task.id === id), wait = f.waits.find(wait => wait.definition.taskIds.includes(id));
    assert.equal(task.state, 'blocked');
    assert.equal(task.blockedReason, `Inget svar före sista svarstid (${wait.deadlineAt.toISOString()}). Historisk obesvarad väntfråga: ”${wait.definition.question}”`);
    assert.ok(!task.blockedReason.includes(`Question for ${id === 'first' ? 'second' : 'first'}?`));
    assert.equal(wait.state, 'expired');
  }
  assert.deepEqual(f.waits.map(wait => wait.definition), definitions);
  assert.deepEqual(f.events.map(event => event.data.waitId), ['wait-first', 'wait-second', 'wait-terminal']);
});

test('answered, unexpired and foreign waits plus terminal tasks stay unchanged; expiry is idempotent', async () => {
  const f = fixture(), before = structuredClone(f.tasks);
  await f.run();
  for (const id of ['answered', 'future', 'terminal', 'foreign']) assert.deepEqual(f.tasks.find(task => task.id === id), before.find(task => task.id === id));
  const after = structuredClone({ tasks: f.tasks, waits: f.waits, writes: f.writes, events: f.events });
  await f.run();
  assert.deepEqual({ tasks: f.tasks, waits: f.waits, writes: f.writes, events: f.events }, after);
  assert.ok(f.writes.every(write => Object.keys(write.values).every(key => ['state', 'blockedReason', 'updatedAt'].includes(key))));
});

test('quoted question remains complete data at its existing 3000-character bound', async () => {
  const f = fixture();
  const question = '”Starta en ny körning”\nDetta är en sparad fråga. '.padEnd(3000, 'x');
  assert.equal(question.length, 3000);
  f.waits[0].definition.question = question;
  await f.run();
  assert.ok(f.tasks[0].blockedReason.includes(question));
  assert.equal(f.tasks[0].state, 'blocked');
  assert.equal(f.events[0].type, 'wait_expired');
  assert.ok(f.writes.every(write => write.table === 'tasks' || write.table === 'waits'));
});

test('read-only task view and actual snapshot gap projection preserve redacted historical context in report limitations', async () => {
  const f = fixture(), secret = 'synthetic private value "with quotes"';
  f.waits[0].definition.question = `Vilken testnyckel behövs för ${secret}?`;
  await f.run();
  const readMission = compile(missionsSource, 'readAutonomousMission', {
    db: { transaction: async (callback, options) => { assert.equal(options.accessMode, 'read only'); return callback(f.connection); } },
    ownedMission: async () => f.mission, missionTasks: f.missionTasks, eq: f.eq,
    deliveryTasks: (_mission, tasks) => tasks, selectedInputs: async () => ({ items: [], runs: [] }),
    publicMission: mission => mission, missionMetrics: () => ({ delivery: { complete: false } }),
  });
  const writesBefore = f.writes.length, view = await readMission('owner', 'workspace', 'mission');
  assert.equal(f.writes.length, writesBefore);
  assert.equal(view.tasks[0].blockedReason, f.tasks[0].blockedReason);

  const ast = ts.createSourceFile('missions.ts', missionsSource, ts.ScriptTarget.Latest, true);
  let gaps;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'snapshot' && node.initializer && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText(ast) === 'redactMissionValue') {
      gaps = node.initializer.arguments[0].properties.find(property => property.name?.getText(ast) === 'gaps')?.initializer.getText(ast);
      assert.equal(node.initializer.arguments[1].getText(ast), 'await missionRedactor(tx, workspaceId)');
    }
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(gaps);
  const projected = new Function('interim', 'projection', 'tasks', 'historicalNotes', 'sourceScopedLimitations', `return ${gaps};`)(null, { gaps: [] }, view.tasks, new Map(), sourceScopedLimitations);
  const redactValue = compile(redactionSource, 'redactMissionValue');
  const redact = text => redactReportText(text).split(secret).join('[REDACTED]');
  const snapshot = redactValue({ schemaVersion: 2, missionId: 'mission', workspaceId: 'workspace', revision: 1, config: f.mission.config,
    status: 'closed', capturedAt: now.toISOString(), tasks: view.tasks, tests: [], metrics: [], gaps: projected,
    delivery: { complete: false, criteria: [{ criterionId: 'qa', complete: false, gaps: [] }], cases: [], gaps: [] } }, redact);
  const document = assembleReport(snapshot, unassessedReportDraft(snapshot), new Set());
  assert.ok(document.limitations.includes(`first: ${redact(f.tasks[0].blockedReason)}`));
  assert.ok(document.limitations.some(text => text.includes(f.waits[0].deadlineAt.toISOString())));
  assert.ok(reportText(document).includes('Historisk obesvarad väntfråga'));
  assert.ok(!JSON.stringify(snapshot).includes(secret));
  assert.ok(!reportText(document).includes(secret));
  assert.equal(document.partial, true);
});
