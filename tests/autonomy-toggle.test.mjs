import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validateManifest, assertRuntime, assertWindow, assertOff, cleanupConfirmed, reportResumed, runToggleWindow } from './helpers/autonomy-toggle-protocol.mjs';
const clone = v => structuredClone(v), now = Date.parse('2026-10-06T12:00:00Z'), later = new Date(now + 600000).toISOString();
function fixture() {
  const m = {
    scopeExclusions: [], protocol: 'syna-admission-toggle-contract-v1', sourceHash: 'a'.repeat(64), runtime: 'autonomy-test:synthetic', workflowStoreId: randomUUID(), modelRequestIntervalMs: 6000, userId: randomUUID(),
    browser: Object.fromEntries([
      'workspaceId', 'threadId', 'missionId', 'attemptId', 'jobId', 'irisSessionId', 'physicalSessionId'
    ].map(key => [key, randomUUID()])),
    report: Object.fromEntries([
      'workspaceId', 'threadId', 'missionId', 'attemptId', 'reportId'
    ].map(key => [key, randomUUID()])),
    features: { testCapability: true }, code: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [String(i), 'b'.repeat(64)]))
  };
  const state = {
    exclusive: true, missions: [m.browser, m.report].map((s, i) => ({
      id: s.missionId, user_id: m.userId, workspace_id: s.workspaceId, thread_id: s.threadId, runtime: m.runtime, controller_version: 1, lifecycle: 'running', plan_revision: 1, mandate_revision: 1, deadline_at: later, report_deadline_at: i ? later : null, report_latest_at: new Date(now + 1200000).toISOString(), binding_hash: 'c'.repeat(64), admission_intent: i ? 'report_only' : 'verify'
    })),
    attempts: [m.browser, m.report].map((s, i) => ({
      id: s.attemptId, mission_id: s.missionId, task_id: randomUUID(), runtime: m.runtime, kind: i ? 'report' : 'browser_tests', status: 'running', operation_id: randomUUID(), request_hash: 'd'.repeat(64), dispatch_id: i ? randomUUID() : s.jobId, executor_resource_id: i ? s.reportId : s.jobId, mandate_revision: 1, plan_revision: 1, deadline_at: later, tool_call_ids: i ? [] : ['server:iris-model:start:original'], usage: { tokens: null }
    })),
    jobs: [{
        id: m.browser.jobId, session_id: m.browser.irisSessionId, status: 'running', runtime: m.runtime, thread_id: m.browser.threadId
      }],
    browsers: [{
        workspace_id: m.browser.workspaceId, session_id: m.browser.physicalSessionId, agent_id: m.browser.irisSessionId, control: 'agent'
      }],
    claims: [{
        attempt_id: m.browser.attemptId, executor_resource_id: m.browser.physicalSessionId, owner: 'agent'
      }],
    reports: [{
        id: m.report.reportId, mission_id: m.report.missionId, status: 'queued', attempts: 0, item_id: null, finished_at: null, read_receipts: []
      }], events: []
  };
  state.scopeExclusions = [];
  state.tasks = state.attempts.map(a => ({
    id: a.task_id, mission_id: a.mission_id, kind: a.kind, purpose: a.kind === 'report' ? 'final' : null
  }));
  const built = {
    sourceSha256: m.sourceHash, dependencySha256: 'x', services: {
      web: 'x', eve: 'x'
    }, processIdentity: {
      web: { pid: 1 }, eve: {
        pid: 2, listener: 3
      }
    }, runtime: {
      sourceSha256: m.sourceHash, mode: 'application', web: { pid: 1 }, eve: { pid: 2 }, workflowStore: {
        id: m.workflowStoreId, sourceSha256: m.sourceHash
      }, modelRequestIntervalMs: 6000, features: { testCapability: true }
    }
  };
  const physical = {
    sessionId: m.browser.physicalSessionId, status: 404, serviceIdentity: 'physical-service', health: {
      ready: true, activeSessions: 0, startingSessions: 0
    }
  };
  return {
    m, state, built, physical
  };
}
function cleaned(state) {
  const s = clone(state);
  s.jobs[0].status = 'failed';
  s.claims = [];
  s.browsers = [];
  s.attempts[0].status = 'failed';
  return s;
}
function completed(m, state) {
  const s = cleaned(state);
  s.missions.forEach(r => {
    r.lifecycle = 'closed';
  });
  s.missions[0].report_deadline_at = later;
  Object.assign(s.reports[0], {
    status: 'completed', item_id: randomUUID(), item_present: true, finished_at: new Date(now + 240000).toISOString(), read_receipts: [{
        limited: false, hash: 'a', digest: 'a'
      }]
  });
  s.attempts[1].tool_call_ids.push(`server:queue-model:start:report:${m.report.reportId}:1`);
  s.attempts[1].usage.provider = { providerCalls: 1 };
  return s;
}
test('runtime receipt cannot accept a changed workflow, source, feature set or pacing', () => {
  const { m, built } = fixture();
  validateManifest(m);
  assertRuntime(m, built);
  for (const change of [
    v => {
      v.sourceSha256 = 'b';
    }, v => {
      v.processIdentity.eve.pid = 4;
    }, v => {
      v.runtime.workflowStore.id = randomUUID();
    }, v => {
      v.runtime.modelRequestIntervalMs = 0;
    }, v => {
      v.services.web = 'changed';
    }, v => {
      v.runtime.reportFault = {};
    }, v => {
      v.runtime.features.testCapability = false;
    }
  ]) {
    const changed = clone(built);
    change(changed);
    assert.throws(() => assertRuntime(m, changed, built));
  }
});
test('exact initial window rejects foreign scopes, missing claims, human control and already running writer', () => {
  const { m, state } = fixture();
  assertWindow(m, state, now);
  for (const mutate of [
    s => {
      s.exclusive = false;
    }, s => {
      s.missions[0].user_id = randomUUID();
    }, s => {
      s.attempts[1].deadline_at = new Date(now + 300000).toISOString();
    }, s => {
      s.claims = [];
    }, s => {
      s.browsers[0].control = 'human';
    }, s => {
      s.jobs[0].session_id = randomUUID();
    }, s => {
      s.reports[0].attempts = 1;
    }, s => {
      s.attempts[1].tool_call_ids = ['server:queue-model:start:report:bad:1'];
    }
  ]) {
    const changed = clone(state);
    mutate(changed);
    assert.throws(() => assertWindow(m, changed, now));
  }
});
test('late usage/FINISH receipts are history but every new model/tool admission fails', () => {
  const { m, state } = fixture(), late = cleaned(state);
  late.attempts[0].tool_call_ids.push('server:iris-model:usage:{"callId":"original"}', `test-receipt:${randomUUID()}`);
  late.attempts[0].usage.tokens = 120;
  assertOff(m, state, late);
  for (const marker of ['server:iris-model:start:other', 'server:queue-model:start:review:other:1', 'a'.repeat(64) + ':' + 'b'.repeat(64)]) {
    const next = clone(late);
    next.attempts[0].tool_call_ids.push(marker);
    assert.throws(() => assertOff(m, state, next));
  }
  const plan = clone(late);
  plan.events.push({
    mission_id: m.browser.missionId, event_key: 'planning-model:new', kind: 'planning_model_started', payload: { invocationId: 'new' }
  });
  assert.throws(() => assertOff(m, state, plan));
});
test('off observations cannot reset the epoch, deadline, attempt identity or job identity', () => {
  const { m, state } = fixture();
  for (const mutate of [
    s => {
      s.missions[0].deadline_at = new Date(now + 700000).toISOString();
    }, s => {
      s.missions[1].report_deadline_at = new Date(now + 700000).toISOString();
    }, s => {
      s.missions[0].report_deadline_at = new Date(now + 1300000).toISOString();
    }, s => {
      s.missions[0].mandate_revision++;
    }, s => {
      s.missions[0].plan_revision++;
    }, s => {
      s.missions[0].binding_hash = 'changed';
    }, s => {
      s.attempts[0].dispatch_id = randomUUID();
    }, s => {
      s.attempts.push({
        ...s.attempts[0], id: randomUUID()
      });
    }, s => {
      s.jobs[0].session_id = randomUUID();
    }
  ]) {
    const changed = clone(state);
    mutate(changed);
    assert.throws(() => assertOff(m, state, changed));
  }
});
test('missing transport or map row alone never confirms terminal physical cleanup', () => {
  const { m, state, physical } = fixture();
  const done = cleaned(state);
  assert.equal(cleanupConfirmed(m, done, physical), true);
  for (const mutate of [
    s => {
      s.jobs[0].status = 'cancelling';
    }, s => {
      s.claims = clone(state.claims);
    }, s => {
      s.browsers = clone(state.browsers);
    }, s => {
      s.jobs[0].session_id = randomUUID();
    }
  ]) {
    const changed = clone(done);
    mutate(changed);
    assert.equal(cleanupConfirmed(m, changed, physical), false);
  }
  assert.equal(cleanupConfirmed(m, done, {
    ...physical, status: 503
  }), false);
  assert.equal(cleanupConfirmed(m, done, {
    ...physical, health: {
      ...physical.health, activeSessions: 1
    }
  }), false);
});
test('on requires the same queued report, real writer admission, full reads, no duplicate artifact and both closures', () => {
  const { m, state } = fixture(), done = completed(m, state);
  assert.equal(reportResumed(m, state, done), true);
  for (const mutate of [
    s => {
      s.attempts[1].executor_resource_id = randomUUID();
    }, s => {
      s.attempts[1].tool_call_ids = [];
    }, s => {
      s.attempts[1].usage = { tokens: null };
    }, s => {
      s.reports[0].item_present = false;
    }, s => {
      s.reports[0].read_receipts[0].limited = true;
    }, s => {
      s.reports.push({
        ...s.reports[0], id: randomUUID(), item_id: randomUUID()
      });
    }
  ]) {
    const changed = clone(done);
    mutate(changed);
    assert.throws(() => reportResumed(m, state, changed));
  }
  done.missions[0].lifecycle = 'running';
  assert.equal(reportResumed(m, state, done), false);
});
function ports(f, failure) {
  let clock = now, phase = 'before', physicalReads = 0;
  const calls = [], saved = [];
  const p = {
    now: () => clock, wait: async (ms) => {
      clock += ms;
    }, save: async (stage, v) => {
      saved.push({
        stage, value: clone(v)
      });
    },
    verify: async () => {
      const b = clone(f.built);
      b.runtime.web.pid = phase === 'off' ? 5 : phase === 'on' ? 7 : 1;
      return b;
    },
    observe: async () => {
      let s = phase === 'off' ? cleaned(f.state) : phase === 'on' ? completed(f.m, f.state) : clone(f.state);
      if (failure === 'missed' && phase === 'stopped')
        s.reports[0].attempts = 1;
      if (failure === 'admitted' && phase === 'off')
        s.attempts[0].tool_call_ids.push('server:iris-model:start:unwanted');
      return s;
    },
    stopWeb: async () => {
      calls.push('stop');
      const pid = phase === 'off' ? 5 : phase === 'on' ? 7 : 1;
      phase = 'stopped';
      return { stoppedPids: [pid] };
    },
    startWeb: async (enabled) => {
      calls.push(enabled ? 'on' : 'off');
      phase = enabled ? 'on' : 'off';
    },
    probe: async (enabled) => ({
      status: enabled ? 400 : 503, reason: enabled ? 'empty_report_selection' : 'autonomy_disabled', insertedMissions: 0
    }), schedulerCursor: async () => ({}),
    schedulerSince: async () => failure === 'scheduler' ? [] : Array.from({ length: 2 }, () => [{
        path: '/api/internal/autonomy/drain', status: 200
      }, {
        path: '/api/internal/mission-reports/drain', status: 200
      }]).flat(),
    physical: async () => ({
      ...clone(f.physical), status: physicalReads++ === 0 ? 200 : 404, ...(failure === 'service' && physicalReads > 1 ? { serviceIdentity: 'changed' } : {})
    })
  };
  return {
    p, calls, saved
  };
}
test('whole fixed toggle sequence restores on, preserves an explicit pending final gate', async () => {
  const f = fixture(), { p, calls, saved } = ports(f);
  const result = await runToggleWindow(f.m, p);
  assert.equal(result.result, 'observed');
  assert.equal(result.gate, false);
  assert.equal(result.independentReview, 'pending');
  assert.deepEqual(calls, [
    'stop', 'off', 'stop', 'on'
  ]);
  assert.ok(saved.some(s => s.stage === 'off-complete'));
  assert.ok(saved.some(s => s.stage === 'final-physical'));
});
test('missed stop window, new admission, no scheduler or changed browser service stays failed and restores only original web', async () => {
  for (const failure of [
    'missed', 'admitted', 'scheduler', 'service'
  ]) {
    const f = fixture(), { p, calls, saved } = ports(f, failure);
    await assert.rejects(runToggleWindow(f.m, p));
    assert.equal(calls.at(-1), 'on');
    assert.ok(saved.some(s => s.stage === 'restored-after-failure'));
    assert.ok(!saved.some(s => s.stage === 'result'));
  }
});
test('a host suspension cannot extend the frozen deadline or produce an observed pass', async () => {
  const f = fixture(), { p, saved } = ports(f), wait = p.wait;
  p.wait = async () => wait(900000);
  await assert.rejects(runToggleWindow(f.m, p), /deadline expired/);
  assert.ok(saved.some(s => s.stage === 'restored-after-failure'));
  assert.ok(!saved.some(s => s.stage === 'result'));
});
test('a generic 503 is not evidence of disabled admission', async () => {
  const f = fixture(), { p, saved } = ports(f), probe = p.probe;
  p.probe = async (enabled) => enabled ? probe(enabled) : {
    status: 503, reason: 'unexpected_response', insertedMissions: 0
  };
  await assert.rejects(runToggleWindow(f.m, p));
  assert.ok(saved.some(s => s.stage === 'restored-after-failure'));
});
test('the original job runtime and thread remain exact through trigger, off and cleanup', () => {
  const { m, state, physical } = fixture();
  for (const field of ['runtime', 'thread_id']) {
    const changed = clone(state);
    changed.jobs[0][field] = field === 'runtime' ? 'autonomy-test:other' : randomUUID();
    assert.throws(() => assertWindow(m, changed, now));
    assert.throws(() => assertOff(m, state, changed));
    assert.equal(cleanupConfirmed(m, cleaned(changed), physical), false);
  }
});
test('only the original report-only final task/snapshot can arm or finish the window', () => {
  const { m, state } = fixture();
  for (const mutate of [
    s => {
      s.missions[1].admission_intent = 'verify';
    }, s => {
      s.tasks[1].purpose = 'interim';
    },
    s => {
      s.tasks[1].mission_id = m.browser.missionId;
    }, s => {
      s.tasks[1].id = randomUUID();
    },
    s => {
      s.tasks[1].kind = 'review';
    }, s => {
      s.reports[0].purpose = 'interim';
    }
  ]) {
    const changed = clone(state);
    mutate(changed);
    assert.throws(() => assertWindow(m, changed, now));
    assert.throws(() => assertOff(m, state, changed));
    assert.throws(() => reportResumed(m, state, completed(m, changed)));
  }
  const legacyFinal = clone(state);
  legacyFinal.tasks[1].purpose = null;
  assertWindow(m, legacyFinal, now);
});
test('late completion of an on-observation or final physical read cannot pass after host suspension', async () => {
  for (const edge of ['observe', 'physical', 'verify']) {
    const f = fixture(), { p, saved, calls } = ports(f), original = p[edge], advance = p.wait;
    p[edge] = async (...args) => {
      const result = await original(...args);
      if (calls.at(-1) === 'on')
        await advance(900000);
      return result;
    };
    await assert.rejects(runToggleWindow(f.m, p), /deadline expired/);
    assert.ok(!saved.some(s => s.stage === 'result'));
  }
});
test('generic gate never exempts any open scope, even if an observer says it is inert', async () => {
  const f = fixture();
  const input = clone(f.m);
  input.scopeExclusions = [randomUUID()];
  assert.throws(() => validateManifest(input));
  const missing = clone(f.state);
  delete missing.scopeExclusions;
  assert.throws(() => assertWindow(f.m, missing, now));
  for (const stage of ['off', 'on']) {
    const { p, calls, saved } = ports(f), observe = p.observe;
    p.observe = async () => {
      const state = await observe();
      if (calls.at(-1) === stage)
        state.scopeExclusions = [{
            id: randomUUID(), declaredInert: true
          }];
      return state;
    };
    await assert.rejects(runToggleWindow(f.m, p));
    assert.ok(!saved.some(s => s.stage === 'result'));
  }
});
test('ordinary denial probes must be exact and must never insert a row', async () => {
  for (const reason of ['wrong-status', 'inserted']) {
    const f = fixture(), { p, saved } = ports(f), original = p.probe;
    p.probe = async (enabled) => {
      const result = await original(enabled);
      if (!enabled) {
        if (reason === 'inserted')
          result.insertedMissions = 1;
        else
          result.status = 403;
      }
      return result;
    };
    await assert.rejects(runToggleWindow(f.m, p));
    assert.ok(!saved.some(s => s.stage === 'result'));
  }
});

test('physical writer count does not fabricate token totals or grant a semantic pass', async () => {
  const { m, state } = fixture();
  const done = completed(m, state);
  done.attempts[1].usage.provider = {
    providerCalls: 1,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null
  };
  assert.equal(reportResumed(m, state, done), true);
  assert.equal(done.attempts[1].usage.provider.totalTokens, null);
  const f = fixture();
  const { p } = ports(f);
  const result = await runToggleWindow(f.m, p);
  assert.equal(result.gate, false);
  assert.equal(result.semanticReview, 'not_evaluated');
  assert.equal(result.independentReview, 'pending');
});
