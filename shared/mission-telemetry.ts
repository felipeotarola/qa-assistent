import type { MissionAttemptState, MissionAttemptUsage, MissionClosureReason, MissionLifecycle, MissionTaskKind } from './mission-control';
import { irisModelUsage } from './browser-job.ts';
import { combineProviderUsage, providerUsageSchema, type ProviderUsage } from './provider-usage.ts';

type Time = Date | string | null;
type Attempt = {
  id: string; operationId: string; kind: MissionTaskKind; status: MissionAttemptState;
  reservedTokens: number; reservedToolCalls: number; toolCalls: number; toolCallIds: readonly string[];
  usage: MissionAttemptUsage | null; cancelRequestedAt?: Time;
};
type QueueJob = { id: string; status: string; createdAt: Time; usage?: { durationMs: number; queueMs: number } | null };
export type MissionTelemetryInput = {
  now: Date | string;
  mission: { lifecycle: MissionLifecycle | null; closureReason: MissionClosureReason | null; createdAt: Time; closedAt: Time; heartbeatAt: Time; deadlineAt: Time; reportDeadlineAt: Time };
  attempts: readonly Attempt[];
  tasks?: readonly { id: string; state: string | null }[];
  waits?: readonly { id: string; state: string; deadlineAt: Time }[];
  resources?: readonly { id: string; owner: string; state: string; expiresAt: Time }[];
  events?: readonly { id: string; kind: string }[];
  reports?: readonly QueueJob[];
  reviews?: readonly QueueJob[];
};
const active = new Set(['reserved', 'dispatching', 'dispatch_unknown', 'running']);
const prefix = 'server:queue-model:';
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const time = (value: Time | undefined) => { const result = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(result) ? result : null; };
const unique = <T extends { id: string }>(rows: readonly T[]) => [...new Map(rows.map(row => [row.id, row])).values()];
export type MissionTelemetryGap = 'invalid_timing' | 'missing_heartbeat' | 'missing_deadline' | 'unknown_tokens' | 'unknown_tool_usage' | 'invalid_usage'
  | 'invalid_model_ledger' | 'conservative_reservation_retained' | 'provider_calls_untracked' | 'phase_durations_unavailable'
  | 'cost_unpriced' | 'resource_inventory_unavailable' | 'wait_inventory_unavailable' | 'queue_usage_latest_only';

/** Legacy queue markers describe one reader/writer workflow, not individual
 * provider calls. Parse only numeric receipts; never project marker contents. */
function modelLedger(attempt: Attempt, gaps: Set<MissionTelemetryGap>) {
  const starts = new Set(attempt.toolCallIds.filter(id => id.startsWith(`${prefix}start:`)).map(id => id.slice(`${prefix}start:`.length)));
  const receipts = new Map<string, { tokens: number | null; provider?: ProviderUsage }>();
  const conflicts = new Set<string>();
  let invalid = false;
  for (const id of new Set(attempt.toolCallIds)) {
    if (!id.startsWith(`${prefix}usage:`)) continue;
    try {
      const receipt: unknown = JSON.parse(id.slice(`${prefix}usage:`.length));
      if (!receipt || typeof receipt !== 'object' || !('key' in receipt) || typeof receipt.key !== 'string' || !starts.has(receipt.key)
        || !('tokens' in receipt) || receipt.tokens !== null && !nonnegative(receipt.tokens)) throw new Error('Invalid receipt');
      const provider = 'provider' in receipt ? providerUsageSchema.parse(receipt.provider) : undefined;
      const value = { tokens: receipt.tokens, ...(provider ? { provider } : {}) };
      if (receipts.has(receipt.key) && JSON.stringify(receipts.get(receipt.key)) !== JSON.stringify(value)) {
        invalid = true; conflicts.add(receipt.key); receipts.delete(receipt.key);
      } else if (!conflicts.has(receipt.key)) receipts.set(receipt.key, value);
    } catch { invalid = true; }
  }
  if (invalid) gaps.add('invalid_model_ledger');
  const known = [...starts].filter(key => nonnegative(receipts.get(key)?.tokens));
  const measured = known.length ? known.reduce((sum, key) => sum + receipts.get(key)!.tokens!, 0) : null;
  if (measured !== null && !nonnegative(measured)) { invalid = true; gaps.add('invalid_model_ledger'); }
  return { invocations: starts.size, known: known.length, unknown: starts.size - known.length, invalid,
    measured: nonnegative(measured) ? measured : null,
    providers: [...receipts.values()].flatMap(receipt => receipt.provider ? [receipt.provider] : []),
    retainedUncertainty: attempt.toolCallIds.includes(`${prefix}unknown`) || attempt.toolCallIds.some(id => id.startsWith(`${prefix}charged-unknown:`)),
  };
}

const providerFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'durationMs'] as const;
type ProviderField = typeof providerFields[number];
type ProviderProjection = {
  providerCalls: number; knownCalls: number; unknownCalls: number; invalid: boolean; complete: boolean;
  measured: Record<ProviderField, number | null>;
};
const emptyMeasurements = (): ProviderProjection['measured'] => ({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, durationMs: null });
function providerLedger(attempt: Attempt, workflow: ReturnType<typeof modelLedger>, gaps: Set<MissionTelemetryGap>): ProviderProjection {
  const iris = irisModelUsage(attempt.toolCallIds);
  const aggregate = attempt.usage?.provider === undefined ? undefined : providerUsageSchema.safeParse(attempt.usage.provider);
  let invalid = aggregate?.success === false;
  if (iris.providerCalls || iris.invalid) {
    invalid ||= iris.invalid || workflow.invocations > 0 || attempt.kind !== 'browser_tests';
    if (invalid) gaps.add('invalid_model_ledger');
    // Iris already has one durable entry per physical call. An aggregate, if
    // present, is another projection of those calls, never additional usage.
    return { providerCalls: iris.providerCalls, knownCalls: invalid ? 0 : iris.knownCalls, unknownCalls: invalid ? iris.providerCalls : iris.unknownCalls,
      invalid, complete: !invalid, measured: invalid ? emptyMeasurements() : Object.fromEntries(providerFields.map(field => [field, iris.measurementCounts[field] ? iris[field] : null])) as ProviderProjection['measured'] };
  }
  let values: ProviderUsage[] = [];
  let complete = false;
  if (workflow.invocations || workflow.invalid) {
    values = workflow.providers;
    invalid ||= workflow.invalid;
    complete = values.length === workflow.invocations;
    // Queue summaries are the sum of these same receipts. Check their agreement
    // but use receipts so known earlier fields survive a later unknown call.
    try {
      if (aggregate?.success && JSON.stringify(combineProviderUsage(values)) !== JSON.stringify(aggregate.data)) invalid = true;
    } catch { invalid = true; }
  } else if (aggregate?.success) {
    values = [aggregate.data]; complete = true;
  } else if (['discovery', 'repository_check', 'environment_setup'].includes(attempt.kind) && attempt.usage?.tokens === 0) complete = true;
  const sum = (field: keyof ProviderUsage) => {
    const known = values.flatMap(value => value[field] === null ? [] : [value[field]]);
    if (!known.length) return null;
    const result = known.reduce((total, value) => total + value, 0);
    if (!nonnegative(result)) { invalid = true; return null; }
    return result;
  };
  const providerCalls = sum('providerCalls') ?? 0, unknownCalls = sum('unknownCalls') ?? 0;
  const measured = Object.fromEntries(providerFields.map(field => [field, sum(field)])) as ProviderProjection['measured'];
  if (invalid) gaps.add('invalid_model_ledger');
  return { providerCalls, knownCalls: invalid ? 0 : providerCalls - unknownCalls, unknownCalls: invalid ? providerCalls : unknownCalls,
    invalid, complete: complete && !invalid, measured: invalid ? emptyMeasurements() : measured };
}

function budget(attempts: Attempt[], gaps: Set<MissionTelemetryGap>) {
  const sum = (metric: 'tokens' | 'toolCalls', charged: boolean) => {
    let total = 0;
    for (const attempt of attempts) {
      const reserved = metric === 'tokens' ? attempt.reservedTokens : attempt.reservedToolCalls;
      const actual = attempt.usage?.[metric];
      if (!nonnegative(reserved) || actual != null && !nonnegative(actual) || metric === 'toolCalls' && !nonnegative(attempt.toolCalls)) { gaps.add('invalid_usage'); return null; }
      // Same conservative semantics as admission, without granting permission.
      const value = !charged ? reserved : actual == null ? reserved : active.has(attempt.status) ? Math.max(reserved, actual) : actual;
      total += charged && metric === 'toolCalls' ? Math.max(value, attempt.toolCalls) : value;
      if (!nonnegative(total)) { gaps.add('invalid_usage'); return null; }
    }
    return total;
  };
  return { reservedTokens: sum('tokens', false), chargedTokens: sum('tokens', true), reservedToolCalls: sum('toolCalls', false), chargedToolCalls: sum('toolCalls', true) };
}

function queueSummary(rows: readonly QueueJob[] | undefined, gaps: Set<MissionTelemetryGap>) {
  if (!rows) return null;
  const jobs = unique(rows), latest = jobs.filter(job => job.usage).sort((a, b) => (time(b.createdAt) ?? 0) - (time(a.createdAt) ?? 0))[0];
  if (latest) gaps.add('queue_usage_latest_only');
  const reported = (field: 'durationMs' | 'queueMs') => nonnegative(latest?.usage?.[field]) ? latest!.usage![field] : null;
  return { total: jobs.length, queued: jobs.filter(job => job.status === 'queued').length, running: jobs.filter(job => job.status === 'running').length,
    completed: jobs.filter(job => job.status === 'completed').length, failed: jobs.filter(job => job.status === 'failed').length,
    latestReportedDurationMs: reported('durationMs'), latestReportedQueueMs: reported('queueMs') };
}

/** Read-only drift projection. Call with a complete, already owner-scoped query.
 * No quality verdict, authorization decision or per-provider cost is inferred.
 * Queue usage is not added again to attempt usage. Output is an explicit numeric
 * allowlist: request/claim IDs, prompts, errors and marker strings stay private. */
export function missionTelemetry(input: MissionTelemetryInput) {
  const gaps = new Set<MissionTelemetryGap>(['phase_durations_unavailable', 'cost_unpriced']);
  const attempts = unique(input.attempts), now = time(input.now), createdAt = time(input.mission.createdAt), closedAt = time(input.mission.closedAt);
  const end = input.mission.lifecycle === 'closed' ? closedAt : now;
  const difference = (to: number | null, from: number | null) => to !== null && from !== null && to >= from ? to - from : null;
  const elapsedMs = difference(end, createdAt);
  if (elapsedMs === null) gaps.add('invalid_timing');
  const heartbeatAgeMs = difference(now, time(input.mission.heartbeatAt));
  if (heartbeatAgeMs === null) gaps.add('missing_heartbeat');
  const remaining = (value: Time) => { const until = time(value); return now !== null && until !== null ? Math.max(0, until - now) : null; };
  if (time(input.mission.deadlineAt) === null) gaps.add('missing_deadline');
  const ledgers = attempts.map(attempt => modelLedger(attempt, gaps));
  const providerLedgers = attempts.map((attempt, index) => providerLedger(attempt, ledgers[index]!, gaps));
  const providersComplete = attempts.length > 0 && providerLedgers.every(provider => provider.complete);
  if (!providersComplete) gaps.add('provider_calls_untracked');
  let measuredKnownTokens = 0, tokenMeasurements = 0, unknownTokenAttempts = 0, totalTokens = 0;
  let observedToolCalls = 0, totalToolCalls = 0, unknownToolAttempts = 0;
  for (const [index, attempt] of attempts.entries()) {
    const ledger = ledgers[index]!, provider = providerLedgers[index]!, tokens = attempt.usage?.tokens, tools = attempt.usage?.toolCalls;
    const providerSum = !provider.invalid && (provider.measured.inputTokens !== null || provider.measured.outputTokens !== null) ? (provider.measured.inputTokens ?? 0) + (provider.measured.outputTokens ?? 0) : null;
    const providerMeasured = nonnegative(providerSum) ? providerSum : null;
    if (providerSum !== null && providerMeasured === null) gaps.add('invalid_usage');
    const measured = ledger.measured === null && providerMeasured === null ? null : Math.max(ledger.measured ?? 0, providerMeasured ?? 0);
    if (ledger.retainedUncertainty) gaps.add('conservative_reservation_retained');
    if (nonnegative(tokens)) { measuredKnownTokens += Math.max(tokens, measured ?? 0); tokenMeasurements++; }
    else if (measured !== null) { measuredKnownTokens += measured; tokenMeasurements++; }
    if (nonnegative(tokens) && !ledger.retainedUncertainty && !ledger.invalid && !ledger.unknown && !provider.invalid && !provider.unknownCalls
      && (measured === null || measured <= tokens)) totalTokens += tokens;
    else unknownTokenAttempts++;
    if (nonnegative(attempt.toolCalls)) observedToolCalls += attempt.toolCalls;
    else gaps.add('invalid_usage');
    if (nonnegative(tools) && nonnegative(attempt.toolCalls)) totalToolCalls += Math.max(tools, attempt.toolCalls);
    else unknownToolAttempts++;
    if (tokens != null && !nonnegative(tokens) || tools != null && !nonnegative(tools)) gaps.add('invalid_usage');
    if (nonnegative(tokens) && measured !== null && measured > tokens) gaps.add('invalid_model_ledger');
  }
  if (unknownTokenAttempts) gaps.add('unknown_tokens');
  if (unknownToolAttempts) gaps.add('unknown_tool_usage');
  const waits = input.waits && unique(input.waits), resources = input.resources && unique(input.resources), events = input.events && unique(input.events), tasks = input.tasks && unique(input.tasks);
  if (!resources) gaps.add('resource_inventory_unavailable');
  if (!waits) gaps.add('wait_inventory_unavailable');
  const due = (deadline: Time) => { const value = time(deadline); return now !== null && value !== null ? value <= now : null; };
  const reportBudget = budget(attempts.filter(attempt => attempt.kind === 'report'), gaps), workBudget = budget(attempts.filter(attempt => attempt.kind !== 'report'), gaps);
  const reports = queueSummary(input.reports, gaps), reviews = queueSummary(input.reviews, gaps);
  const providerCount = (field: 'providerCalls' | 'knownCalls' | 'unknownCalls') => {
    const value = providerLedgers.reduce((sum, ledger) => sum + ledger[field], 0);
    if (!nonnegative(value)) { gaps.add('invalid_usage'); return null; }
    return value;
  };
  const providerMeasurement = (field: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'durationMs') => {
    const valid = providerLedgers.filter(ledger => !ledger.invalid && ledger.measured[field] !== null);
    const value = valid.length ? valid.reduce((sum, ledger) => sum + ledger.measured[field]!, 0) : null;
    if (value !== null && !nonnegative(value)) { gaps.add('invalid_usage'); return null; }
    return value;
  };
  const checkedTotal = (value: number) => {
    if (!nonnegative(value)) { gaps.add('invalid_usage'); return null; }
    return value;
  };
  return {
    schemaVersion: 1 as const,
    timing: { elapsedMs, heartbeatAgeMs, workDeadlineRemainingMs: remaining(input.mission.deadlineAt), reportDeadlineRemainingMs: remaining(input.mission.reportDeadlineAt),
      workDeadlineExceeded: due(input.mission.deadlineAt), reportDeadlineExceeded: due(input.mission.reportDeadlineAt), queueMs: null, modelMs: null, executionMs: null },
    attempts: { logical: attempts.length, operations: new Set(attempts.map(attempt => attempt.operationId)).size,
      retries: attempts.length - new Set(attempts.map(attempt => attempt.operationId)).size,
      active: attempts.filter(attempt => active.has(attempt.status)).length, dispatchUnknown: attempts.filter(attempt => attempt.status === 'dispatch_unknown').length,
      cancelRequested: attempts.filter(attempt => !!attempt.cancelRequestedAt).length },
    tokens: { measuredKnown: tokenMeasurements || !attempts.length ? checkedTotal(measuredKnownTokens) : null, total: unknownTokenAttempts ? null : checkedTotal(totalTokens), unknownAttempts: unknownTokenAttempts },
    toolCalls: { observed: gaps.has('invalid_usage') && attempts.some(attempt => !nonnegative(attempt.toolCalls)) ? null : checkedTotal(observedToolCalls),
      total: unknownToolAttempts ? null : checkedTotal(totalToolCalls), unknownAttempts: unknownToolAttempts },
    budget: { work: workBudget, report: reportBudget },
    model: {
      // Queue invocations may contain several provider calls. Never merge these counters.
      workflows: { tracked: ledgers.reduce((sum, ledger) => sum + ledger.invocations, 0), knownTokens: ledgers.reduce((sum, ledger) => sum + ledger.known, 0),
        unknownTokens: ledgers.reduce((sum, ledger) => sum + ledger.unknown, 0) },
      providers: { tracked: providerCount('providerCalls'), knownTokens: providerCount('knownCalls'), unknownTokens: providerCount('unknownCalls'), total: providersComplete ? providerCount('providerCalls') : null },
      // Measured subtotals of the instrumented provider path only. Null is not zero;
      // cached tokens are a subset of input, and duration is not mission wall time.
      measured: { inputTokens: providerMeasurement('inputTokens'), outputTokens: providerMeasurement('outputTokens'),
        cacheReadTokens: providerMeasurement('cacheReadTokens'), cacheWriteTokens: providerMeasurement('cacheWriteTokens'), durationMs: providerMeasurement('durationMs') },
    },
    tasks: tasks ? { total: tasks.length, completed: tasks.filter(task => task.state === 'completed').length, blocked: tasks.filter(task => task.state === 'blocked').length, waiting: tasks.filter(task => task.state === 'waiting').length } : null,
    waits: waits ? { pending: waits.filter(wait => wait.state === 'waiting').length, overdue: waits.filter(wait => wait.state === 'waiting' && due(wait.deadlineAt)).length,
      unknownDeadlines: waits.filter(wait => wait.state === 'waiting' && due(wait.deadlineAt) === null).length,
      expired: waits.filter(wait => wait.state === 'expired').length } : null,
    resources: resources ? { pending: resources.length, humanOwned: resources.filter(resource => resource.owner === 'human').length,
      uncertain: resources.filter(resource => resource.state === 'uncertain').length, expired: resources.filter(resource => due(resource.expiresAt)).length,
      unknownExpiries: resources.filter(resource => due(resource.expiresAt) === null).length,
      remainingAfterClosure: input.mission.lifecycle === 'closed' ? resources.length : 0, clean: resources.length === 0 } : null,
    events: events ? { lateReceipts: events.filter(event => event.kind === 'late_executor_receipt').length, dispatchUnknown: events.filter(event => event.kind === 'dispatch_unknown').length,
      expiredWaits: events.filter(event => event.kind === 'wait_expired').length } : null,
    reports, reviews,
    monetaryCost: null,
    gaps: [...gaps],
  };
}
export type MissionTelemetry = ReturnType<typeof missionTelemetry>;
