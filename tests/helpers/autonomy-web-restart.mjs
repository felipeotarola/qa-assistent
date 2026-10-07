import assert from 'node:assert/strict';

/** The observation deadline is fixed by the original submission. Restoring a
 * process after a failed injection is cleanup, never extra observation time. */
export function requireWebDeadline(deadlineAt, now = Date.now()) {
  assert.ok(Number.isFinite(deadlineAt) && Number.isFinite(now), 'Invalid WEB observation deadline');
  if (now >= deadlineAt) {
    const error = new Error('Fixed WEB observation deadline expired');
    error.code = 'WEB_OBSERVATION_EXPIRED';
    throw error;
  }
}

export async function observeWebBeforeDeadline(deadlineAt, observe, now = Date.now) {
  requireWebDeadline(deadlineAt, now());
  const state = await observe();
  requireWebDeadline(deadlineAt, now());
  return state;
}

/** Stop may clear only the owned web PID. A replacement, different Eve,
 * workflow store, preload or configuration must never be overwritten. */
export function assertWebRestartConfiguration(before, current) {
  for (const field of ['sourceSha256', 'mode', 'workflowStore', 'modelRequestIntervalMs', 'extraVariantsFixture', 'evidenceGapFixture', 'reportFault', 'reportFaultConfigFile', 'securityContext']) {
    assert.deepEqual(current[field] ?? null, before[field] ?? null, `Restart changed ${field}`);
  }
  assert.deepEqual(current.eve, before.eve, 'Independent scheduler identity changed');
}

export function assertWebRestartBinding(before, current) {
  assertWebRestartConfiguration(before, current);
  assert.ok(current.web?.pid === null || current.web?.pid === before.web.pid, 'Another web process replaced the original');
  const { pid: beforePid, ...beforeWeb } = before.web;
  const { pid: currentPid, ...currentWeb } = current.web;
  assert.ok(Number.isSafeInteger(beforePid) && beforePid > 0);
  assert.ok(currentPid === null || Number.isSafeInteger(currentPid));
  assert.deepEqual(currentWeb, beforeWeb, 'Original web process binding changed');
}

/** Ports retain the actual runtime's integrity/process guards. This helper
 * owns only ordering and failure preservation; it cannot attest real effects. */
export async function restartWebAtBoundary({ deadlineAt, observed, record, ports, now = Date.now }) {
  requireWebDeadline(deadlineAt, now());
  const beforeRuntime = await ports.verify();
  requireWebDeadline(deadlineAt, now());
  Object.assign(record, { triggeredAt: new Date(now()).toISOString(), before: observed, beforeRuntime });
  await ports.persist();
  requireWebDeadline(deadlineAt, now());

  let failure, restoreFailure;
  // Once stop is invoked its outcome can be ambiguous even if it throws.
  // The restore port must prove the original process still runs OR prove it
  // stopped before making exactly one same-configuration start attempt.
  try {
    record.stopReceipt = await ports.stop(beforeRuntime);
    requireWebDeadline(deadlineAt, now());
    assert.ok(record.stopReceipt.stoppedPids.includes(beforeRuntime.web.pid), 'Actual worker was not terminated');
    record.stoppedAt = new Date(now()).toISOString();
    record.stoppedState = await observeWebBeforeDeadline(deadlineAt, ports.observeStopped, now);
    await ports.persist();
    requireWebDeadline(deadlineAt, now());
  } catch (error) {
    failure = error;
  } finally {
    try {
      const restored = await ports.restore(beforeRuntime);
      assert.ok(['restarted', 'original_running'].includes(restored.status), 'Unknown restoration outcome');
      record.restoration = { status: restored.status, finishedAt: new Date(now()).toISOString() };
      record.afterRuntime = restored.runtime;
      if (restored.status === 'restarted') record.restartedAt = record.restoration.finishedAt;
    } catch (error) {
      restoreFailure = error;
      record.restoration = { status: 'failed', errorType: error?.name || 'Error', finishedAt: new Date(now()).toISOString() };
    }
    try { await ports.persist(); } catch (error) { failure ??= error; }
  }
  if (restoreFailure) throw new AggregateError([failure, restoreFailure].filter(Boolean), 'WEB restoration failed; original trial failure is preserved');
  if (failure) throw failure;
  requireWebDeadline(deadlineAt, now());
  assert.equal(record.restoration.status, 'restarted', 'Required process restart did not occur');
  await ports.audit(record);
  requireWebDeadline(deadlineAt, now());
  return record;
}
