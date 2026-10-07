// File-only catalogue projection. No environment, DB, application, oracle,
// model or lifecycle imports. A saved assertion is recorded, never re-certified.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = value => Array.isArray(value) ? value : [];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
const label = value => typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(value) ? value : null;
const canonical = value => JSON.stringify(value, function (_, entry) { return entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry; });
const sum = values => { const result = values.reduce((total, value) => total + value, 0); return Number.isSafeInteger(result) ? result : null; };
const instant = value => typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const duration = (start, end) => instant(start) !== null && instant(end) !== null && instant(end) >= instant(start) ? instant(end) - instant(start) : null;
const tally = values => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(item => item === value).length]));
const runtimeScopeOf = data => typeof data.runtime === 'string' ? data.runtime : typeof data.fixture?.runtimeScope === 'string' ? data.fixture.runtimeScope : null;
const securityChatVariants = ['other-owner', 'other-runtime'];
const securityChatCodeKeys = ['harness', 'oracle', 'observer', 'compiler', 'controls', 'evidence', 'evidenceObserver', 'timestamps', 'isolation', 'buildVerification'];
const securityContextHelperFiles = ['provider', 'runtime', 'preload', 'audit', 'control', 'startup'].map(name => `tests/helpers/security-context-${name}.mjs`);
const reportFaultProtocols = ['syna-report-fault-acceptance-v1', 'syna-report-fault-acceptance-v2'];
const reportFaultVariants = {
  'REP-05': { original: 'lost-queue-commit-ack', catalog: 'report-ack-loss', kind: 'pg-commit-ack' },
  'REP-06': { original: 'source-change-after-read', catalog: 'source-change', kind: 'provider-response-barrier' },
  'REP-07': { original: 'wrong-run-provenance', catalog: 'wrong-run-binding', kind: 'synthetic-preparation-only' },
};
const historicalEvidenceV4 = info => info.family === 'evidence' && info.version === 'syna-evidence-acceptance-v4';
const historicalPreparation = 'preserved-version-locked-evidence; not a natural first QA execution';
// evidence-acceptance fingerprints sort keys by code unit, not locale. Keep
// this receipt format separate from the catalogue's existing cohort hashes.
const preservedReceiptHash = value => hash(JSON.stringify(value, function (_, entry) { return entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry; }));
const evidenceFamily = info => ['evidence', 'report-fault'].includes(info.family);
const repositoryNormalV2 = 'syna-repository-normal-v2';
const isRepositoryNormalV2 = info => info.family === 'repository' && info.version === repositoryNormalV2;
const repositoryFaultV3 = 'syna-repository-fault-v3';
const isRepositoryFaultV3 = info => info.family === 'repository' && info.version === repositoryFaultV3;
const isBrowserV4 = info => info.family === 'browser' && info.version === 4;
const isBrowserV5 = info => info.family === 'browser' && info.version === 5;
const currentBrowser = info => isBrowserV4(info) || isBrowserV5(info);
const actualHistoryScope = 'actual-natural-QA-A-before-measured-B-v1';
function pacing(data) {
  const values = [data.modelRequestIntervalMs, data.buildIntegrity?.modelRequestIntervalMs, data.processes?.modelRequestIntervalMs, object(data.runtime).modelRequestIntervalMs].filter(value => value !== undefined);
  if (!values.length) return { modelRequestIntervalMs: null, pacingState: 'unknown' };
  if (values.some(value => count(value) === null || value > 30000) || new Set(values).size !== 1) return { modelRequestIntervalMs: null, pacingState: 'conflicting_or_invalid' };
  return { modelRequestIntervalMs: values[0], pacingState: 'recorded' };
}

// Optional instrumentation is a latency/comparison dimension, never a new
// security gate. This file does not open or certify the referenced sidecars.
function securityContextIdentity(data, info) {
  if (info.family !== 'security-chat') return null;
  const present = data.contextObservation !== undefined || data.buildIntegrity?.contextObservation !== undefined || array(data.attempts).some(row => row.contextObservation !== undefined);
  if (!present) return { present: false, valid: true, latencyMeasurementSource: 'public-durable-observation-without-provider-preload' };
  const declared = object(data.contextObservation), running = object(data.buildIntegrity?.contextObservation);
  const helperHashes = Object.fromEntries(securityContextHelperFiles.map(file => [file, digest(declared.helperHashes?.[file])]));
  const runtimeFiles = securityContextHelperFiles.filter(file => !file.endsWith('-startup.mjs'));
  // Old/declaration-only metadata can state an instrumentation scope. When
  // actual process receipts are present they must agree; never discard a
  // contradicting receipt in favour of the declaration. Raw PIDs/nonces stay
  // private and these hashes do not independently certify process identity.
  const processHashesAgree = running.processes === undefined || Array.isArray(running.processes) && running.processes.length === 2
    && ['web', 'eve'].every(service => running.processes.filter(process => process?.service === service).length === 1)
    && running.processes.every(process => canonical(Object.keys(object(process.helperHashes)).sort()) === canonical([...runtimeFiles].sort())
      && runtimeFiles.every(file => digest(process.helperHashes[file]) !== null && digest(process.helperHashes[file]) === helperHashes[file]));
  const valid = declared.version === 1 && declared.scope === 'decoded-provider-request-canaries'
    && canonical(Object.keys(object(declared.helperHashes)).sort()) === canonical([...securityContextHelperFiles].sort()) && Object.values(helperHashes).every(Boolean)
    && running.version === declared.version && running.scope === declared.scope && digest(running.manifestHash) === digest(data.manifestSha256) && !!digest(data.manifestSha256) && processHashesAgree;
  return { present: true, valid, version: count(declared.version), scope: label(declared.scope), helperHashes,
    latencyMeasurementSource: valid ? 'public-durable-observation-with-passive-provider-preload' : 'provider-observer-identity-unknown' };
}

// Stable catalogue names; absent artefacts are planned, not successful runs.
// These labels include requirements whose dedicated driver is still pending.
export const catalogPlan = Object.freeze({
  'WEB-01': ['normal', 'controller-restart', 'report-restart'],
  'WEB-02': ['normal', 'return-in-time', 'no-answer', 'late-answer'],
  'WEB-03': ['normal', 'untrusted-comment'],
  'WEB-04': ['normal', 'plan-changed', 'stop-independent'],
  'REP-05': ['normal', 'report-ack-loss', 'historical-review-gap'],
  'REP-06': ['normal', 'source-change'], 'REP-07': ['normal', 'wrong-run-binding'],
  'SEC-08': ['other-owner', 'other-runtime', 'anonymous'],
  'AUTH-09': ['return-in-time', 'no-answer', 'late-answer'],
  'REPO-10': ['normal', 'runner_ack_lost'], 'REPO-11': ['normal', 'app_stops_after_ready'],
  'REPO-12': ['normal', 'missing_key_no_answer', 'consent_revoked_before_release'], 'GAP-13': ['resolvable', 'persistent', 'report-only'],
});

function contract(data) {
  if (reportFaultProtocols.includes(data.protocol) && Object.hasOwn(reportFaultVariants, data.taskId)) {
    const variant = reportFaultVariants[data.taskId], supported = data.variant === variant.original;
    return { family: 'report-fault', version: data.protocol, taskId: data.taskId, variant: supported ? variant.catalog : label(data.variant),
      originalVariant: label(data.variant), rows: array(data.attempts), supported, proof: 'report-only-model-with-recorded-fault' };
  }
  if (['syna-evidence-security-chat-v1', 'syna-evidence-security-chat-v2'].includes(data.protocol) && data.taskId === 'SEC-08')
    return { family: 'security-chat', version: data.protocol, taskId: data.taskId, variant: 'owner-and-runtime', rows: array(data.attempts), supported: true, proof: 'natural-model-access-denial-projection' };
  if (data.type === 'syna-browser-variants-acceptance' && [1, 2, 3, 4, 5].includes(data.schemaVersion) && ['WEB-02', 'WEB-03', 'WEB-04', 'AUTH-09'].includes(data.taskId))
    return { family: 'browser', version: data.schemaVersion, taskId: data.taskId, variant: data.variant, rows: array(data.trials), supported: (data.schemaVersion === 5
      ? data.taskId === 'WEB-04' && data.taskVersion === 3 && data.historicalBaseline === actualHistoryScope
      : [2, 3, 4].includes(data.schemaVersion)) && catalogPlan[data.taskId].includes(data.variant), proof: 'natural-model-qa' };
  if (data.protocol === 'syna-evidence-acceptance-v4')
    return { family: 'evidence', version: data.protocol, taskId: Object.hasOwn(catalogPlan, data.taskId) ? data.taskId : null, variant: data.variant, rows: array(data.attempts),
      supported: data.taskId === 'REP-05' && data.variant === 'historical-review-gap' && data.inputPreparation === historicalPreparation, proof: 'report-only-model-with-preserved-original-Iris-receipts' };
  if (['syna-evidence-acceptance-v1', 'syna-evidence-acceptance-v2', 'syna-evidence-acceptance-v3'].includes(data.protocol) && ['REP-05', 'REP-06', 'REP-07', 'SEC-08', 'GAP-13'].includes(data.taskId))
    return { family: 'evidence', version: data.protocol, taskId: data.taskId, variant: data.variant, rows: array(data.attempts), supported: (data.taskId === 'SEC-08' ? ['owner-contract'] : data.taskId === 'GAP-13' ? ['resolvable', 'persistent', 'report-only'] : data.taskId === 'REP-05' ? ['normal', 'historical-review-gap'] : ['normal']).includes(data.variant), proof: data.taskId === 'SEC-08' ? 'owner-api-contract-only' : data.inputPreparation === 'natural-first-run' ? 'natural-model-qa' : 'report-only-model' };
  if (data.kind === 'repository-acceptance' && ([1, 2, 3].includes(data.version) || [repositoryNormalV2, repositoryFaultV3].includes(data.protocol)) && ['REPO-10', 'REPO-11', 'REPO-12'].includes(data.scenario))
    return { family: 'repository', version: data.protocol === undefined ? data.version : label(data.protocol), taskId: data.scenario, variant: data.variant, rows: array(data.attempts),
      supported: data.protocol === repositoryNormalV2 ? data.version === 2 && data.variant === 'normal'
        : data.protocol === repositoryFaultV3 ? data.version === 3 && data.variant !== 'normal' && catalogPlan[data.scenario].includes(data.variant)
        : data.protocol === undefined && catalogPlan[data.scenario].includes(data.variant) && (data.version === 1 ? data.variant === 'normal' : data.version === 2 && data.variant !== 'normal'), proof: 'natural-model-repository' };
  if (!data.kind && !data.type && [1, 2, 3, 4, 5, 6, 7].includes(data.version) && ['normal', 'controller-restart', 'report-restart'].includes(data.scenario))
    return { family: 'web', version: data.version, taskId: 'WEB-01', variant: data.scenario, rows: array(data.attempts), supported: [5, 6, 7].includes(data.version), proof: 'natural-model-qa' };
  return { family: 'unsupported', version: label(data.protocol) ?? count(data.schemaVersion ?? data.version), taskId: Object.hasOwn(catalogPlan, data.taskId) ? data.taskId : null, variant: label(data.variant), rows: [], supported: false, proof: 'unclassified' };
}

/** Mirrors the persisted physical meter, including explicit zero vs absence.
 * Independent schema-parity tests protect this dependency-free reader. */
export function catalogProviderReceipt(value) {
  const row = object(value), keys = ['providerCalls', 'unknownCalls', 'inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'durationMs'];
  if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key)) || count(row.providerCalls) === null || count(row.unknownCalls) === null || row.unknownCalls > row.providerCalls) return null;
  if (keys.slice(2).some(key => row[key] !== null && count(row[key]) === null)) return null;
  const total = row.inputTokens === null || row.outputTokens === null ? null : sum([row.inputTokens, row.outputTokens]);
  if (total !== row.totalTokens || row.inputTokens !== null && row.outputTokens !== null && total === null || row.unknownCalls > 0 && total !== null || row.providerCalls > 0 && row.unknownCalls === 0 && total === null) return null;
  if (row.providerCalls === 0 && keys.slice(2).some(key => row[key] !== null && row[key] !== 0)) return null;
  if (['cacheReadTokens', 'cacheWriteTokens'].some(key => row.inputTokens !== null && row[key] !== null && row[key] > row.inputTokens)) return null;
  return row;
}

function protocolIdentity(data, info) {
  const fixture = object(data.fixture), source = digest(data.sourceHash);
  const runtimeSources = [data.buildIntegrity?.sourceSha256, data.processes?.sourceSha256].filter(value => value !== undefined).map(digest);
  const runtimeSource = runtimeSources[0] ?? null, sourceConsistent = source && runtimeSource ? runtimeSources.every(value => value === source) : null;
  const hashes = Object.fromEntries(['harnessSha256', 'oracleAuditSha256', 'oracleSha256', 'parserSha256', 'effectParserSha256', 'traceParserSha256', 'timestampParserSha256', 'observerSha256', 'manifestSha256', 'faultGatewaySha256', 'goldenValidatorSha256']
    .filter(key => data[key] !== undefined).map(key => [key, digest(data[key])]));
  // V5 retains its historical fixed-reviewer contract and comparison identity.
  // V6/V7 record the reviewer source actually frozen by the harness for both
  // services. Its source digest is a module hash, not the whole application SHA.
  // These are preserved declarations; this file-only reader does not attest
  // runtime bytes or re-run the review oracle.
  const webFrozenReviewer = info.family === 'web' && [6, 7].includes(info.version);
  const webV7 = info.family === 'web' && info.version === 7;
  const repoV2 = isRepositoryNormalV2(info), repoFaultV3 = isRepositoryFaultV3(info), browserV4 = currentBrowser(info), browserV5 = isBrowserV5(info);
  const currentExecutionPolicy = repoFaultV3 || browserV4, frozenChecks = repoV2 || currentExecutionPolicy;
  const frozenReviewer = webFrozenReviewer || frozenChecks;
  const defectPolicy = webV7 && data.defectPolicy === 'reviewed-known-defect-v1' ? data.defectPolicy : null;
  const defectPolicyValid = !webV7 || defectPolicy !== null && data.oracleContract === 'submitted-search-catalogue-reviewed-known-defects-v7';
  const policy = object(data.reviewerPolicy);
  const reviewerPolicy = frozenReviewer ? {
    reviewerVersion: typeof policy.reviewerVersion === 'string' && /^[0-9]{1,12}$/.test(policy.reviewerVersion) ? policy.reviewerVersion : null,
    hashVersion: policy.hashVersion === 2 ? 2 : null, sourceSha256: digest(policy.sourceSha256),
  } : null;
  const validReviewer = value => Object.keys(value).length === 3 && Object.keys(value).every(key => ['reviewerVersion', 'hashVersion', 'sourceSha256'].includes(key))
    && typeof value.reviewerVersion === 'string' && /^[0-9]{1,12}$/.test(value.reviewerVersion) && value.hashVersion === 2 && !!digest(value.sourceSha256);
  const reviewerPolicyValid = !frozenReviewer || Object.keys(policy).length === 3
    && Object.keys(policy).every(key => ['reviewerVersion', 'hashVersion', 'sourceSha256'].includes(key)) && Object.values(reviewerPolicy).every(Boolean);
  const runningReviewer = object(data.buildIntegrity?.reviewerPolicy);
  const currentReviewerConsistent = !currentExecutionPolicy || validReviewer(runningReviewer)
    && runningReviewer.reviewerVersion === reviewerPolicy.reviewerVersion && runningReviewer.hashVersion === reviewerPolicy.hashVersion
    && digest(runningReviewer.sourceSha256) === reviewerPolicy.sourceSha256;
  // Normal repository v2 binds the imported checkpoint projection separately
  // from its reviewer and whole application. Legacy numeric v2 means faults.
  const checks = object(data.runChecksPolicy), runningChecks = object(data.buildIntegrity?.runChecksPolicy);
  const validChecks = value => Object.keys(value).length === 2 && value.version === 1 && !!digest(value.sourceSha256);
  const runChecksPolicy = frozenChecks ? { version: checks.version === 1 ? 1 : null, sourceSha256: digest(checks.sourceSha256) } : null;
  const runChecksPolicyValid = !frozenChecks || validChecks(checks) && validChecks(runningChecks)
    && checks.version === runningChecks.version && digest(checks.sourceSha256) === digest(runningChecks.sourceSha256);
  // auditSha256 is captured when v6/v7 initialize; the harness also records the
  // legacy-named oracleAuditSha256 after preflight. Never discard a conflict or
  // substitute the older alias for a missing v6/v7 digest.
  if (webFrozenReviewer) hashes.auditSha256 = digest(data.auditSha256);
  const webAuditConsistent = !webFrozenReviewer || !!hashes.auditSha256
    && (data.oracleAuditSha256 === undefined || hashes.oracleAuditSha256 === hashes.auditSha256);
  const helperHashes = Object.fromEntries(Object.entries(object(data.helperHashes)).filter(([key]) => /^[a-z0-9-]+\.mjs$/.test(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, digest(value)]));
  const codeHashes = info.family === 'security-chat' ? Object.fromEntries(securityChatCodeKeys.map(key => [key, digest(data.code?.[key])])) : {};
  const context = securityContextIdentity(data, info);
  const fault = object(data.buildIntegrity?.reportFault);
  const faultHashes = Object.fromEntries(Object.entries(object(fault.codeHashes))
    .filter(([key]) => /^tests\/(?:helpers\/report-fault-[a-z-]+\.mjs|autonomy-evidence\.acceptance\.mjs)$/.test(key))
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, digest(value)]));
  const reportFault = info.family === 'report-fault' ? {
    protocol: reportFaultProtocols.includes(fault.protocol) && fault.protocol === info.version ? fault.protocol : null,
    kind: fault.kind === reportFaultVariants[info.taskId].kind ? fault.kind : null,
    originalVariant: info.originalVariant, manifestSha256: digest(fault.manifestSha256), codeHashes: faultHashes,
  } : null;
  const site = { kind: label(fixture.kind),
    siteSha256: digest(fixture.siteSha256 ?? fixture.serverSha256), oracleSha256: digest(fixture.oracleSha256), resolverSha256: digest(fixture.resolverSha256),
    manifestSha256: digest(fixture.manifestSha256), repositoryCommit: /^[a-f0-9]{40}$/.test(fixture.repository?.commit ?? '') ? fixture.repository.commit : null };
  const historical = historicalEvidenceV4(info);
  const historicalPolicy = historical ? {
    preservedIrisHelperSha256: digest(data.preservedIrisHelperSha256), irisLedgerParserSha256: digest(data.irisLedgerParserSha256),
    providerMeterParserSha256: digest(data.providerMeterParserSha256), historicalReviewerPolicySha256: digest(data.historicalReviewerPolicySha256),
    historicalReviewerVersion: typeof data.historicalReviewerVersion === 'string' && /^[0-9]{1,12}$/.test(data.historicalReviewerVersion) ? data.historicalReviewerVersion : null,
  } : null;
  const historicalPolicyValid = !historical || Object.values(historicalPolicy).every(Boolean)
    && ['irisLedgerParserSha256', 'providerMeterParserSha256', 'historicalReviewerPolicySha256'].every(key => digest(data.buildIntegrity?.[key]) === historicalPolicy[key]);
  const prompts = info.rows.map(row => row.promptSha256 ?? (typeof row.prompt === 'string' ? hash(row.prompt) : null));
  const identity = { family: info.family, version: info.version, taskId: info.taskId, variant: info.variant,
    catalogVersion: label(data.catalogVersion), taskVersion: count(data.taskVersion), model: label(data.model),
    reasoning: label(data.reasoning), ...pacing(data),
    promptSha256: typeof data.prompt === 'string' ? hash(data.prompt) : digest(data.promptSha256),
    perTrialPromptSha256: [...new Set(prompts.filter(digest))].sort(), hashes, helperHashes, codeHashes, fixture: site, reportFault,
    sourcesSha256: info.family === 'security-chat' ? digest(data.sourcesSha256) : null,
    ...(historical ? { historicalPolicy } : {}),
    ...(frozenReviewer ? { reviewerPolicy } : {}), ...(frozenChecks ? { runChecksPolicy } : {}),
    ...(browserV4 ? { reviewScope: data.reviewScope === 'frozen-review-and-authorized-continuations-v1' ? data.reviewScope : null } : {}),
    ...(browserV5 ? { historicalBaseline: data.historicalBaseline === actualHistoryScope ? actualHistoryScope : null } : {}),
    ...(webV7 ? { defectPolicy } : {}),
    ...(context?.present ? { contextObservation: { version: context.version, scope: context.scope, helperHashes: context.helperHashes } } : {}),
    inputPreparation: typeof data.inputPreparation === 'string' ? hash(data.inputPreparation) : typeof data.historicalBaseline === 'string' ? hash(data.historicalBaseline) : null,
    oracleContract: label(data.oracleContract),
    timestampObservation: data.timestampObservation === 'utc-oid1114-v1' ? data.timestampObservation : null,
    observationSeconds: count(data.observationSeconds), schedulerIntervalSeconds: count(data.schedulerIntervalSeconds), controllerLeaseSeconds: count(data.controllerLeaseSeconds), reportLeaseSeconds: count(data.reportLeaseSeconds) };
  const required = info.family === 'web' ? [site.siteSha256, site.oracleSha256, webFrozenReviewer ? hashes.auditSha256 : hashes.oracleAuditSha256,
    identity.oracleContract, reviewerPolicyValid, webAuditConsistent, defectPolicyValid]
    : info.family === 'browser' ? [site.siteSha256, site.oracleSha256, site.resolverSha256, hashes.parserSha256, hashes.traceParserSha256, ...([3, 4, 5].includes(info.version) ? [hashes.effectParserSha256] : []),
        ...(browserV5 ? [identity.historicalBaseline, helperHashes['browser-variants-history.mjs']] : []),
        ...(browserV4 ? [identity.reviewScope, reviewerPolicyValid, currentReviewerConsistent, runChecksPolicyValid,
          ...['browser-variants-current.mjs', 'browser-variants-reports.mjs', 'browser-variants-regression.mjs', 'repo-benchmark-audit-v2.mjs', 'repo-benchmark-audit.mjs', 'autonomy-web-audit.mjs', 'mission-report-bindings.mjs'].map(name => helperHashes[name]),
          hashes.traceParserSha256 === helperHashes['autonomy-web-audit.mjs']] : [])]
      : info.family === 'repository' ? [site.manifestSha256, site.oracleSha256, site.repositoryCommit, hashes.oracleAuditSha256, helperHashes['repo-benchmark-contract.mjs'], helperHashes['repo-worker-integrity.mjs'],
          ...(repoV2 || repoFaultV3 ? [reviewerPolicyValid, runChecksPolicyValid, ...['repo-acceptance-observer-v2.mjs', 'repo-benchmark-audit.mjs', 'repo-transport.mjs', 'repo-transport-linux.mjs', 'autonomy-web-audit.mjs'].map(name => helperHashes[name])]
            : [helperHashes['repo-acceptance-observer.mjs']]),
          ...(info.version === 2 || repoFaultV3 ? [helperHashes['repo-fault-contract.mjs'], helperHashes['repo-fault-control.mjs'], helperHashes['repo-fault-gateway.mjs']] : []),
          ...(repoFaultV3 ? [currentReviewerConsistent, helperHashes['repo-benchmark-audit-v2.mjs'], helperHashes['mission-report-bindings.mjs'], hashes.oracleAuditSha256 === helperHashes['repo-fault-contract.mjs']] : [])]
        : info.family === 'report-fault' ? [hashes.manifestSha256, hashes.oracleSha256, hashes.observerSha256, hashes.goldenValidatorSha256,
            reportFault.protocol, reportFault.kind, reportFault.manifestSha256 === hashes.manifestSha256,
            ...['acceptance', 'contract', 'control', 'driver', 'prepare', 'runtime', 'startup', ...(info.taskId === 'REP-05' ? ['pg'] : info.taskId === 'REP-06' ? ['provider', 'preload', 'diagnostics'] : [])]
              .map(name => faultHashes[`tests/helpers/report-fault-${name}.mjs`]),
            faultHashes['tests/autonomy-evidence.acceptance.mjs'] === hashes.harnessSha256, ...Object.values(faultHashes)]
          : [hashes.manifestSha256, hashes.oracleSha256, hashes.observerSha256, ...(historical ? [historicalPolicyValid] : [])];
  const locked = info.family === 'security-chat'
    ? sourceConsistent === true && !!hashes.manifestSha256 && !!identity.sourcesSha256 && Object.values(codeHashes).every(Boolean)
      && !!identity.model && !!identity.reasoning && identity.pacingState === 'recorded' && identity.perTrialPromptSha256.length === 6 && context.valid
    : info.supported && sourceConsistent === true && !!hashes.harnessSha256 && !!hashes.timestampParserSha256
    && !!identity.timestampObservation && !!identity.model && !!identity.reasoning && identity.pacingState === 'recorded' && required.every(Boolean) && Object.values(helperHashes).every(Boolean)
    && (identity.promptSha256 || identity.perTrialPromptSha256.length > 0)
    && ['observationSeconds', 'schedulerIntervalSeconds', 'controllerLeaseSeconds', 'reportLeaseSeconds'].every(key => identity[key] !== null);
  return { identity, sourceSha256: source, runtimeSourceSha256: runtimeSource, frozenSourceConsistent: sourceConsistent,
    ...(context ? { latencyMeasurementSource: context.latencyMeasurementSource } : {}),
    comparisonKey: locked && !data.isolationFailure ? hash(canonical(identity)) : null };
}

function preparation(data, row, info) {
  if (info.family === 'security-chat') return data.inputPreparation === 'synthetic-golden' ? 'synthetic-golden-excluded' : data.inputPreparation === 'preserved-actual' ? 'preserved-evidence-excluded' : 'unknown-preparation';
  if (evidenceFamily(info) && data.inputPreparation?.startsWith('synthetic-golden')) return 'synthetic-golden-excluded';
  if (isBrowserV5(info)) return browserHistoryObservation(data, row).preparationBindingRecorded ? 'actual-natural-QA-history-excluded' : 'unknown-history-preparation';
  if (info.taskId === 'WEB-04' && (data.historicalBaseline?.startsWith('declared-synthetic') || row.preparation)) return 'synthetic-unreviewed-history-excluded';
  if (row.excludedPreparation) return 'ordinary-api-setup-excluded';
  if (evidenceFamily(info) && info.taskId.startsWith('REP-')) return 'preserved-evidence-excluded';
  return 'frozen-fixture';
}

function observations(row, info, gaps) {
  // SEC owns one V conversation, not a controller job. Never consume HTTP
  // probe or seeded workspace ledgers as if they were that conversation.
  if (info.family === 'security-chat') return { rows: [], ledgerSeen: row.noExecutionStarted === true, snapshots: 0 };
  const snapshots = array(row.snapshots).map(snapshot => object(snapshot.state ?? snapshot));
  const baseline = object(row.baseline), oldAttempts = new Set(array(baseline.attempts).map(item => item.id)), oldMissions = new Set(array(baseline.missions).map(item => item.id));
  const latest = new Map(); let ledgerSeen = false;
  for (const snapshot of snapshots) {
    if (!Array.isArray(snapshot.attempts)) continue;
    const currentMissions = new Set(array(snapshot.missions).filter(mission => !oldMissions.has(mission.id) && mission.thread_id === row.threadId
      && (!(isBrowserV5(info) || historicalEvidenceV4(info)) || typeof mission.id === 'string' && mission.id.length > 0)).map(mission => mission.id));
    // A's array cannot establish an observed empty B ledger. An exact B-thread
    // mission plus its attempts array is needed even when B has no attempts.
    if (!(isBrowserV5(info) || historicalEvidenceV4(info)) || typeof row.threadId === 'string' && currentMissions.size > 0) ledgerSeen = true;
    for (const attempt of snapshot.attempts) {
      if (typeof attempt?.id !== 'string' || !attempt.id) { gaps.add('ledger-row-without-identity'); continue; }
      // Evidence observers return the whole workspace including old saved QA.
      // Other observers are already bounded to this fresh trial/time interval.
      if ((evidenceFamily(info) || isBrowserV5(info)) && (oldAttempts.has(attempt.id) || !currentMissions.has(attempt.mission_id))) continue;
      latest.set(attempt.id, { id: attempt.id, kind: attempt.kind ?? 'unknown', status: attempt.status ?? 'unknown', usage: object(attempt.usage), toolCalls: count(attempt.tool_calls), reservedTokens: count(attempt.reserved_tokens) });
    }
  }
  if (historicalEvidenceV4(info) && snapshots.length && !ledgerSeen) gaps.add('historical-evidence-current-report-ledger-unobserved');
  if (isBrowserV5(info) && snapshots.length && !ledgerSeen) gaps.add('browser-history-current-mission-ledger-unobserved');
  return { rows: [...latest.values()], ledgerSeen, snapshots: snapshots.length };
}

// Preserve the v5 harness's declaration, not a second oracle. The referenced A
// artifact/bytes are never opened here. Its meters and duration remain outside
// measured B, even when the input contains the full preparation graph.
function browserHistoryObservation(data, row) {
  const p = object(row.preparation), ref = object(row.preparationArtifact), identity = object(ref.identity), r = object(row.regression);
  const ids = value => Array.isArray(value) && value.length > 0 && value.every(id => typeof id === 'string' && id.length > 0) && new Set(value).size === value.length;
  const sameIds = (a, b) => ids(a) && ids(b) && canonical([...a].sort()) === canonical([...b].sort());
  const subset = (a, b) => ids(a) && ids(b) && a.every(id => b.includes(id));
  const preparationBindingRecorded = p.protocol === 'syna-browser-regression-actual-history-v1' && p.preparation === 'actual-natural-QA-A'
    && !!digest(ref.artifactSha256) && canonical(identity) === canonical(p.identity)
    && [identity.workspaceId, identity.userId, identity.threadId, row.threadId].every(value => typeof value === 'string' && value.length > 0)
    && identity.workspaceId === row.workspaceId && identity.userId === row.userId && identity.threadId !== row.threadId
    && identity.runtime === runtimeScopeOf(data) && !!digest(identity.sourceHash) && digest(identity.sourceHash) === digest(data.sourceHash)
    && !!digest(identity.fixtureSourceHash) && digest(identity.fixtureSourceHash) === digest(data.fixture?.serverSha256)
    && !!digest(identity.harnessSha256) && digest(identity.harnessSha256) === digest(data.harnessSha256)
    && !!digest(identity.helperSha256) && digest(identity.helperSha256) === digest(data.helperHashes?.['browser-variants-history.mjs'])
    && duration(p.acceptedAt, p.closedAt) !== null && duration(p.closedAt, row.measuredFrom) !== null && duration(row.measuredFrom, row.acceptedAt) !== null
    && subset(p.currentRunIds, p.runIds);
  const historyRecorded = preparationBindingRecorded && r.historicalBaseline === 'actual-natural-QA-A'
    && r.actualHistoryVerified === true && sameIds(r.historicalRunIds, p.runIds) && r.semanticComparison === 'independent_review_pending';
  const fullComparisonRecorded = historyRecorded && r.binding === 'immutable-regression-comparison-v1'
    && !!digest(r.reportSnapshotHash) && digest(r.reportSnapshotHash) === digest(row.reportScope?.finalSnapshotHash)
    && sameIds(r.currentHistoricalRunIds, p.currentRunIds) && subset(r.currentRunIds, r.newRunIds)
    && r.newRunIds.every(id => !p.runIds.includes(id)) && r.fullRealHistoricalRegression === true;
  const finalBound = row.reportScope?.version === 1 && typeof row.reportScope.finalReportId === 'string' && row.reportScope.finalReportId.length > 0
    && !!digest(row.reportScope.finalSnapshotHash) && row.reportScope.semanticCoverage === 'independent_review_pending';
  const completionRecorded = finalBound && (data.variant === 'normal' ? fullComparisonRecorded
    : ['plan-changed', 'stop-independent'].includes(data.variant) && historyRecorded && r.fullRealHistoricalRegression === false);
  return { preparationBindingRecorded, historyRecorded, fullComparisonRecorded, completionRecorded,
    preparationArtifactSha256: digest(ref.artifactSha256), preparationIdentitySha256: Object.keys(identity).length ? hash(canonical(identity)) : null,
    comparisonReceiptSha256: Object.keys(r).length ? hash(canonical(r)) : null,
    recordedHistoricalRuns: ids(r.historicalRunIds) ? r.historicalRunIds.length : null,
    recordedCurrentHistoricalRuns: ids(r.currentHistoricalRunIds) ? r.currentHistoricalRunIds.length : null,
    recordedCurrentRuns: ids(r.currentRunIds) ? r.currentRunIds.length : null,
    recordedNewRuns: ids(r.newRunIds) ? r.newRunIds.length : null,
    preparationUsage: 'excluded_not_zero', independentReview: 'not_reverified', semanticComparison: 'independent_review_pending', fullGate: false };
}

/** Public Eve steps are not a physical provider-call ledger. Read only the
 * saved usage fields, preserving unknowns and validating their original scope;
 * never trust the harness's aggregate or expose response/context contents. */
function conversationObservation(row, gaps) {
  const snapshot = object(row.durableSnapshot), events = array(snapshot.events);
  if (!events.length || snapshot.session?.sessionId !== row.sessionId || snapshot.session?.streamIndex !== events.length || events[0]?.type !== 'session.started'
    || new Set(events.map(event => event.meta?.id)).size !== events.length || events.some(event => !label(event.meta?.id))) {
    if (row.startedAt) gaps.add('security-public-prefix-unavailable-or-invalid');
    return { rows: [], observed: false };
  }
  const starts = events.filter(event => event.type === 'turn.started');
  const received = events.filter(event => event.type === 'message.received');
  if (starts.length !== 1 || starts[0].data?.sequence !== 0 || !label(starts[0].data?.turnId) || received.length !== 1
    || received[0].data?.turnId !== starts[0].data.turnId || received[0].data?.message !== row.prompt) {
    gaps.add('security-public-prefix-original-turn-mismatch'); return { rows: [], observed: false };
  }
  const steps = events.filter(event => ['step.started', 'step.completed'].includes(event.type));
  if (!steps.length || steps.some(event => event.data?.turnId !== starts[0].data.turnId || count(event.data?.stepIndex) === null)) {
    gaps.add('security-public-step-identity-invalid'); return { rows: [], observed: false };
  }
  const rows = [...new Set(steps.map(event => event.data.stepIndex))].map(index => {
    const values = steps.filter(event => event.data.stepIndex === index), started = values.filter(event => event.type === 'step.started'), completed = values.filter(event => event.type === 'step.completed');
    const valid = started.length === 1 && completed.length === 1 && values.indexOf(started[0]) < values.indexOf(completed[0]);
    const usage = valid ? object(completed[0].data.usage) : {};
    const inputTokens = count(usage.inputTokens), outputTokens = count(usage.outputTokens);
    const totalTokens = inputTokens !== null && outputTokens !== null ? sum([inputTokens, outputTokens]) : null;
    if (!valid) gaps.add('security-public-step-incomplete-or-duplicate');
    return { id: hash(canonical([row.sessionId, starts[0].data.turnId, index])), inputTokens, outputTokens, totalTokens, incomplete: !valid };
  });
  return { rows, observed: rows.every(row => !row.incomplete) };
}

/** Preserve the recorded fault boundary without re-running its oracle. A raw
 * "passed" without its exact receipt remains unknown, never normal parity. */
function reportFaultObservation(row, info, gaps) {
  const receipt = object(row.fault), arm = object(row.faultArm), oracle = object(row.oracle);
  const states = ['armed', 'commit_verified', 'commit_ack_dropped', 'owner_patch_started', 'owner_patch_failed_or_unknown', 'source_changed_response_released'];
  const state = states.includes(receipt.state) ? receipt.state : null;
  const scopeMatches = !!row.workspaceId && !!row.threadId && receipt.workspaceId === row.workspaceId && receipt.threadId === row.threadId;
  const preparation = object(row.goldenPreparation), freshness = object(oracle.freshnessProof);
  const freshnessRecorded = !!receipt.reportId && freshness.reportId === receipt.reportId && freshness.reason === 'Evidence changed during review'
    && array(freshness.files).some(file => count(file.occurrences) > 0 && array(file.matchedDiagnosticSha256).length === file.occurrences && file.matchedDiagnosticSha256.every(digest));
  const commonReceipt = scopeMatches && !!label(receipt.reportId) && !!label(receipt.missionId) && !!label(receipt.attemptId);
  let boundaryRecorded = false;
  if (info.taskId === 'REP-05') boundaryRecorded = commonReceipt && state === 'commit_ack_dropped'
    && receipt.physicalBoundary === 'postgres_backend_commit_before_client_ack' && !!label(receipt.snapshotId) && instant(receipt.droppedAt) !== null;
  if (info.taskId === 'REP-06') boundaryRecorded = commonReceipt && state === 'source_changed_response_released'
    && !!digest(receipt.requestSha256) && !!digest(receipt.providerResponseSha256)
    && duration(receipt.providerCompletedAt, receipt.changedAt) !== null && duration(receipt.changedAt, receipt.releasedAt) !== null
    && count(receipt.beforeVersion) > 0 && receipt.afterVersion === receipt.beforeVersion + 1;
  if (info.taskId === 'REP-07') boundaryRecorded = arm.state === 'synthetic_preparation_locked'
    && !!row.workspaceId && !!row.threadId && arm.workspaceId === row.workspaceId && arm.threadId === row.threadId
    && !!digest(row.promptSha256) && arm.promptSha256 === row.promptSha256
    && preparation.preparation === 'synthetic-golden-fault' && preparation.realProviderCalls === 0 && preparation.realBrowserActions === 0;
  const completionRecorded = boundaryRecorded && array(oracle.checks).includes(info.originalVariant)
    && (info.taskId !== 'REP-06' || freshnessRecorded);
  if (row.startedAt && !boundaryRecorded) gaps.add(state === 'owner_patch_failed_or_unknown' || state === 'owner_patch_started'
    || state === 'commit_verified' || row.faultReceiptUnavailable ? 'report-fault-outcome-unknown' : 'report-fault-boundary-not-recorded');
  if (info.taskId === 'REP-06' && boundaryRecorded && !freshnessRecorded) gaps.add('report-fault-final-freshness-proof-missing');
  return { recorded: Object.keys(receipt).length > 0 || Object.keys(arm).length > 0,
    originalVariant: info.originalVariant, mechanism: reportFaultVariants[info.taskId].kind,
    state: info.taskId === 'REP-07' && boundaryRecorded ? 'synthetic_preparation_locked' : state,
    boundaryRecorded, completionRecorded, applied: info.taskId === 'REP-07' ? null : boundaryRecorded,
    receiptUnavailable: row.faultReceiptUnavailable === true,
    receiptSha256: Object.keys(receipt).length ? hash(canonical(receipt)) : null,
    armSha256: Object.keys(arm).length ? hash(canonical(arm)) : null,
    oracleSha256: Object.keys(oracle).length ? hash(canonical(oracle)) : null,
    freshnessRecorded, freshnessProofSha256: Object.keys(freshness).length ? hash(canonical(freshness)) : null,
    independentReview: 'not_reverified', gate: 'not_evaluated' };
}

function normalizeTrial(data, row, info, repetition, artifactId, role = 'primary') {
  const gaps = new Set(), ledger = observations(row, info, gaps), rawStatus = row.status ?? row.result;
  const conversation = info.family === 'security-chat' ? conversationObservation(row, gaps) : { rows: [], observed: false };
  const auditOnly = ['--audit', '--validate', 'audit', 'validate'].includes(data.mode) || ['audited', 'manifest_validated'].includes(data.result);
  const started = !auditOnly && (!!row.startedAt || !!row.acceptedAt || ledger.snapshots > 0 || ['passed', 'failed', 'automated_subset_passed'].includes(rawStatus));
  let status = !started ? 'not_started' : rawStatus === 'failed' ? 'failed' : ['passed', 'automated_subset_passed'].includes(rawStatus) ? 'automatically_passed' : ['running', undefined].includes(rawStatus) ? 'in_progress' : 'unknown';
  const faultObservation = info.family === 'report-fault' ? reportFaultObservation(row, info, gaps) : null;
  const regressionHistory = isBrowserV5(info) ? browserHistoryObservation(data, row) : null;
  const originalProof = object(row.originalExecution);
  const preservedEvidence = historicalEvidenceV4(info) ? {
    recorded: originalProof.version === 1 && !!digest(row.observedOriginalExecutionHash) && preservedReceiptHash(originalProof) === digest(row.observedOriginalExecutionHash),
    originalExecutionSha256: digest(row.observedOriginalExecutionHash),
    recordedOriginalRuns: Array.isArray(originalProof.bindings) ? originalProof.bindings.length : null,
    recordedOriginalAttempts: Array.isArray(originalProof.attempts) ? originalProof.attempts.length : null,
    recordedHistoricalReviews: Array.isArray(originalProof.historicalReviews) ? originalProof.historicalReviews.length : null,
    recordedSourceReads: Array.isArray(row.oracle?.historicalSourceReads) ? row.oracle.historicalSourceReads.length : null,
    sourceReadReceiptSha256: Array.isArray(row.oracle?.historicalSourceReads) ? hash(canonical(row.oracle.historicalSourceReads)) : null,
    originalReceiptsPreserved: row.oracle?.originalExecutionReceipts === 'preserved-not-recertified',
    preparationUsage: 'excluded_not_zero', independentReview: 'not_reverified', semanticCoverage: 'independent_review_pending', fullGate: false,
  } : null;
  if (preservedEvidence && status === 'automatically_passed' && (!preservedEvidence.recorded || preservedEvidence.recordedOriginalRuns !== 3
    || !(preservedEvidence.recordedOriginalAttempts > 0) || !(preservedEvidence.recordedHistoricalReviews > 0)
    || !(preservedEvidence.recordedSourceReads >= 3) || !preservedEvidence.originalReceiptsPreserved)) {
    status = 'unknown'; gaps.add('historical-evidence-pass-without-original-receipt-and-source-read-metadata');
  }
  if (regressionHistory && status === 'automatically_passed' && !regressionHistory.completionRecorded) {
    status = 'unknown'; gaps.add('browser-history-pass-without-bound-actual-preparation-and-comparison');
  }
  if (faultObservation && status === 'automatically_passed' && !faultObservation.completionRecorded) {
    status = 'unknown'; gaps.add('report-fault-pass-without-complete-boundary-receipt');
  }
  if (info.family === 'security-chat' && started && rawStatus !== 'failed') status = rawStatus === 'observed' && row.audit?.eligible === true && row.protectedStateUnchanged === true && row.noExecutionStarted === true && conversation.observed ? 'automatically_passed' : 'unknown';
  if (data.isolationFailure && started) status = 'failed';
  if (!info.supported && status === 'automatically_passed') status = 'historical_unreviewed';
  const runtime = runtimeScopeOf(data);
  const identity = typeof runtime === 'string' && row.threadId ? [runtime, 'thread', row.threadId]
    : typeof runtime === 'string' && row.sessionId ? [runtime, 'session', row.sessionId]
      : info.proof === 'owner-api-contract-only' && row.workspaceId && row.startedAt ? [runtime ?? null, 'contract', row.workspaceId, row.startedAt] : null;
  if (started && !identity) gaps.add('no-stable-workload-identity');
  // An unfinished copy and a later finished copy share the same planned slot,
  // even when the first was saved before a thread/session receipt existed.
  const runIdentity = data.runId ?? (instant(data.startedAt) !== null ? [runtime ?? null, info.family, info.taskId, info.variant, data.startedAt] : artifactId);
  const slotId = hash(canonical(['slot', runIdentity, repetition, role, ...(info.family === 'security-chat' ? [info.variant] : [])]));
  const prose = row.reportProseReview?.status ?? data.reportProseReview?.status ?? data.externalReview?.reportProse;
  const proseStatus = info.family === 'security-chat' ? 'not_applicable' : ['passed', 'failed', 'completed', 'pending', 'not_reviewed'].includes(prose) ? prose : 'not_recorded';
  const external = Object.fromEntries(Object.entries(object(data.externalReview)).filter(([key]) => ['reportProse', 'visiblePixels', 'clickedControlName', 'completeDeniedAttemptAudit', 'unauthorizedEffects', 'latePhysicalEffects'].includes(key)).map(([key, value]) => [key, ['pending', 'passed', 'failed', 'completed', 'not_applicable', 'not_required_by_catalog', 'pending_executor_audit', 'unavailable_in_current_trusted_trace', 'unavailable_in_current_transport'].includes(value) ? value : 'unclassified']));
  const effect = object(row.effectAudit), effectAudit = Object.keys(effect).length ? {
    recorded: true, receiptSha256: hash(canonical(effect)), version: count(effect.version), checkedActionTraces: count(effect.checkedActionTraces),
    observedOutcome: ['unknown', 'no_successful_unauthorized_effect_observed'].includes(effect.observedOutcome) ? effect.observedOutcome : null,
    observedSuccessfulUnauthorizedEffects: count(effect.observedSuccessfulUnauthorizedEffects), observedAttemptingCalls: count(effect.observedAttemptingCalls),
    deniedRecords: Array.isArray(effect.denied) ? effect.denied.length : null, unknownRecords: Array.isArray(effect.unknown) ? effect.unknown.length : null,
    stricterZeroAttemptCheck: ['failed', 'unknown'].includes(effect.stricterZeroAttemptCheck) ? effect.stricterZeroAttemptCheck : null,
    observedNewBrowserActionStarts: count(effect.observedNewBrowserActionStarts), observedNewModelAdmissionsAfterBaseline: count(effect.observedNewModelAdmissionsAfterBaseline),
    inFlightCompletions: count(effect.inFlightCompletions), independentEffectReview: ['pending', 'passed', 'failed'].includes(effect.independentEffectReview) ? effect.independentEffectReview : 'not_recorded',
  } : null;
  const securityAudit = info.family === 'security-chat' ? { recordedEligible: row.audit?.eligible === true, streamSha256: digest(row.audit?.streamHash),
    eventCount: count(row.audit?.eventCount), publicPrefixAvailable: conversation.observed, protectedStateUnchanged: row.protectedStateUnchanged === true,
    noExecutionStarted: row.noExecutionStarted === true, httpControlCount: array(row.httpControls).length,
    modelContextNonLeakage: ['failed', 'durable_projection_only'].includes(row.audit?.modelContextNonLeakage) ? row.audit.modelContextNonLeakage : 'not_observed',
    providerEnvelope: 'not_observed', semanticDenial: 'independent_review_pending', fullGate: false } : null;
  const repositoryScope = object(row.reviewScope);
  const repositoryAudit = isRepositoryNormalV2(info) ? {
    reviewScopeRecorded: Object.keys(repositoryScope).length > 0,
    reviewScopeSha256: Object.keys(repositoryScope).length ? hash(canonical(repositoryScope)) : null,
    originalSelectionObservedAt: instant(repositoryScope.originalSelectionObservedAt) === null ? null : repositoryScope.originalSelectionObservedAt,
    recordedOriginalRequirementsExact: repositoryScope.originalRequirementsExact === true,
    recordedCurrentRuns: Array.isArray(repositoryScope.currentRunByCase) ? repositoryScope.currentRunByCase.length : null,
    recordedComplements: Array.isArray(row.complements) ? row.complements.length : null,
    complementReceiptSha256: Array.isArray(row.complements) ? hash(canonical(row.complements)) : null,
    independentReview: 'not_reverified', semanticCoverage: 'independent_review_pending', fullGate: false,
  } : null;
  // Preserve the recorded v7 mechanical receipt without copying source IDs or
  // pretending this file reader has re-read bytes or interpreted defect prose.
  const webAudit = info.family === 'web' && info.version === 7 ? {
    recordedKnownDefectObservations: Array.isArray(row.knownDefectObservations) ? row.knownDefectObservations.length : null,
    knownDefectReceiptSha256: Array.isArray(row.knownDefectObservations) ? hash(canonical(row.knownDefectObservations)) : null,
    recordedComplements: Array.isArray(row.authorizedComplements) ? row.authorizedComplements.length : null,
    independentReview: 'not_reverified', semanticCoverage: 'independent_review_pending', fullGate: false,
  } : null;
  // Reports/continuations are saved assertions, not fresh proof. Hash the
  // private binding receipt and expose counts only; never leak source IDs.
  const currentProtocol = currentBrowser(info) || isRepositoryFaultV3(info), reports = object(row.reportScope);
  const reportBindingAudit = currentProtocol ? {
    recorded: Object.keys(reports).length > 0,
    receiptSha256: Object.keys(reports).length ? hash(canonical(reports)) : null,
    recordedFinalBinding: typeof reports.finalReportId === 'string' && reports.finalReportId.length > 0
      && (currentBrowser(info) ? reports.version === 1 && !!digest(reports.finalSnapshotHash) && reports.semanticCoverage === 'independent_review_pending'
        : reports.immutablePurposeBinding === true),
    recordedInterimReports: Array.isArray(reports.interim) ? reports.interim.length : null,
    interimStatuses: tally(array(reports.interim).map(entry => ['completed', 'failed', 'cancelled'].includes(entry?.status) ? entry.status : 'unknown')),
    independentReview: 'not_reverified', semanticCoverage: 'independent_review_pending', fullGate: false,
  } : null;
  const browserAudit = currentBrowser(info) ? {
    reviewScopeRecorded: Object.keys(repositoryScope).length > 0,
    reviewScopeSha256: Object.keys(repositoryScope).length ? hash(canonical(repositoryScope)) : null,
    originalSelectionObservedAt: instant(repositoryScope.originalSelectionObservedAt) === null ? null : repositoryScope.originalSelectionObservedAt,
    recordedComplements: Array.isArray(row.complements) ? row.complements.length : null,
    complementReceiptSha256: Array.isArray(row.complements) ? hash(canonical(row.complements)) : null,
    recordedHumanResumptions: Array.isArray(row.humanResumptions) ? row.humanResumptions.length : null,
    humanResumptionReceiptSha256: Array.isArray(row.humanResumptions) ? hash(canonical(row.humanResumptions)) : null,
    recordedHumanAttemptContinuations: Array.isArray(row.humanAttemptContinuations) ? row.humanAttemptContinuations.length : null,
    humanContinuationReceiptSha256: Array.isArray(row.humanAttemptContinuations) ? hash(canonical(row.humanAttemptContinuations)) : null,
    independentReview: 'not_reverified', semanticCoverage: 'independent_review_pending', fullGate: false,
  } : null;
  return { id: identity ? hash(canonical(identity)) : slotId, slotId, stableIdentity: !!identity,
    taskId: info.taskId, variant: info.variant, originalVariant: info.originalVariant ?? null, role, repetition, status, started, auditOnly, supportedProtocol: info.supported,
    isolationFailure: !!data.isolationFailure, preparation: preparation(data, row, info), proofScope: info.proof,
    submittedToModel: !!row.acceptedAt, reportProse: proseStatus, externalReview: external, effectAudit, securityAudit, repositoryAudit, ...(webAudit ? { webAudit } : {}),
    ...(currentProtocol ? { reportBindingAudit } : {}), ...(browserAudit ? { browserAudit } : {}), ...(regressionHistory ? { regressionHistory } : {}), ...(preservedEvidence ? { preservedEvidence } : {}), ...pacing(data),
    time: { observedWallMs: duration(row.startedAt, row.finishedAt), measuredWallMs: duration(isBrowserV5(info) ? row.measuredFrom : row.measuredFrom ?? row.startedAt, row.finishedAt), acceptedToClosureMs: duration(row.acceptedAt, row.closedAt) },
    recordedFailure: !!row.error, sourceSha256: digest(data.sourceHash), protocolVersion: info.version,
    fault: faultObservation ?? { recorded: !!(row.faultReceipt ?? row.fault), applied: row.faultReceipt?.applied === true, receiptSha256: row.faultReceipt ? hash(canonical(row.faultReceipt)) : null,
      stopRecorded: instant(row.fault?.stoppedAt) !== null, restartRecorded: instant(row.fault?.restartedAt) !== null },
    rows: auditOnly ? [] : ledger.rows, ledgerSeen: !auditOnly && ledger.ledgerSeen,
    conversationRows: auditOnly ? [] : conversation.rows, conversationSeen: !auditOnly && conversation.observed, gaps: [...gaps] };
}

function normalizeArtifact(input) {
  const data = object(input.data), info = contract(data), artifactId = digest(input.sha256) ?? hash(canonical(data));
  const identity = protocolIdentity(data, info);
  if (info.family !== 'unsupported' && (count(data.repetitions) === null || data.repetitions < 1 || data.repetitions > 1000)) throw new Error('Invalid repetition bound');
  if (info.family === 'report-fault' && data.repetitions !== 3) throw new Error('Report fault protocol requires three frozen repetitions');
  if (info.family === 'security-chat' && (data.repetitions !== 3 || data.variants !== 2)) throw new Error('SEC chat requires three repetitions of both boundaries');
  const seen = new Set();
  for (const row of info.rows) {
    const key = info.family === 'security-chat' ? `${row.variant}:${row.repetition}` : row.repetition;
    if (!Number.isInteger(row.repetition) || row.repetition < 1 || row.repetition > data.repetitions || seen.has(key) || info.family === 'security-chat' && !securityChatVariants.includes(row.variant)) throw new Error('Duplicate or invalid repetition number');
    seen.add(key);
  }
  const slots = info.family === 'unsupported' ? [] : (info.family === 'security-chat' ? securityChatVariants : [info.variant]).flatMap(variant => Array.from({ length: data.repetitions }, (_, index) => ({ variant, repetition: index + 1 })));
  const trials = slots.map(({ variant, repetition }) => {
    const row = info.rows.find(row => row.repetition === repetition && (info.family !== 'security-chat' || row.variant === variant)) ?? {};
    const trial = normalizeTrial(data, row, { ...info, variant }, repetition, artifactId);
    if (row.independent) {
      const independent = object(row.independent);
      const independentData = { ...data, ...independent.protocol, taskId: independent.protocol?.taskId ?? 'WEB-03', variant: independent.protocol?.variant ?? 'normal' };
      trial.independent = normalizeTrial(independentData, { ...independent, status: independent.verified ? 'automated_subset_passed' : independent.error ? 'failed' : 'running' },
        contract(independentData), repetition, artifactId, 'independent-control');
    }
    return trial;
  });
  return { artifactSha256: artifactId, payloadHash: hash(canonical(data)), runtimeNamespace: hash(canonical(runtimeScopeOf(data) ?? artifactId)), files: [basename(input.fileName ?? 'selected.json')], ...identity,
    family: info.family, supportedProtocol: info.supported, taskId: info.taskId, variant: info.variant, originalVariant: info.originalVariant ?? null,
    declaredAutomatedGate: typeof data.automatedGate === 'boolean' ? data.automatedGate : null, declaredOverallGate: typeof data.gate === 'boolean' ? data.gate : null,
    isolationFailure: !!data.isolationFailure, isolationFailureSha256: data.isolationFailure ? hash(canonical(data.isolationFailure)) : null,
    recordedResult: ['passed', 'failed', 'pending', 'audited', 'observed', 'manifest_validated', 'external_review_required'].includes(data.result) ? data.result : null,
    mode: ['--audit', '--validate', '--execute'].includes(data.mode) ? data.mode.slice(2) : info.family === 'unsupported' ? 'unclassified' : 'execution',
    sourceHashOrigin: 'preserved-artifact-not-live-verified', plannedTrials: trials.length, trials };
}

function measured(values) {
  const known = values.filter(value => count(value) !== null), subtotal = sum(known);
  return { knownSubtotal: subtotal, measuredRecords: known.length, unknownRecords: values.length - known.length,
    total: known.length === values.length ? subtotal : null };
}

function conversationUsage(rows, unknownWorkloads) {
  const values = rows.map(row => row.conflict ? { inputTokens: null, outputTokens: null, totalTokens: null } : row);
  const tokens = measured(values.map(row => row.totalTokens));
  tokens.knownSubtotal = sum(values.flatMap(row => [row.inputTokens, row.outputTokens].filter(value => count(value) !== null)));
  if (unknownWorkloads) tokens.total = null;
  const inputTokens = measured(values.map(row => row.inputTokens)), outputTokens = measured(values.map(row => row.outputTokens));
  if (unknownWorkloads) { inputTokens.total = null; outputTokens.total = null; }
  return { scope: 'SEC V public durable model steps only; excludes source preparation, HTTP probes and mission-attempt receipts',
    modelSteps: rows.length, conflictingSteps: rows.filter(row => row.conflict).length, unknownWorkloads,
    tokens, inputTokens, outputTokens,
    physicalProviderCalls: null, providerEnvelope: 'not_observed', endToEndTokens: null, cost: null };
}

function usage(records, unknownWorkloads) {
  const eligible = records.filter(row => !['discovery', 'preview_discovery'].includes(row.kind) || row.usage.provider);
  const receipts = eligible.map(row => {
    const explicitProvider = Object.hasOwn(row.usage, 'provider');
    const provider = row.conflict ? null : catalogProviderReceipt(row.usage.provider);
    const conflict = !!row.conflict || !!provider && count(row.usage.tokens) !== null && provider.totalTokens !== null && row.usage.tokens !== provider.totalTokens;
    // Iris currently persists a trusted aggregate on the attempt but leaves the
    // individual provider receipts in a private ledger outside this observer.
    // Preserve that aggregate separately; never invent calls/cache breakdown.
    const aggregate = !explicitProvider && !conflict ? count(row.usage.tokens) : null;
    return { provider: conflict ? null : provider, conflict, explicitProvider, aggregate };
  });
  const tokens = measured(receipts.map(row => row.provider?.totalTokens ?? row.aggregate));
  // Partial input/output are non-overlapping measured components, not estimates
  // for the unknown part. Never add usage.tokens or report-queue usage again.
  tokens.knownSubtotal = sum(receipts.flatMap(row => row.provider ? [row.provider.inputTokens, row.provider.outputTokens].filter(value => count(value) !== null) : row.aggregate !== null ? [row.aggregate] : []));
  if (unknownWorkloads) tokens.total = null;
  const fields = Object.fromEntries(['providerCalls', 'unknownCalls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'durationMs']
    .map(key => { const value = measured(receipts.map(row => row.provider?.[key] ?? null)); if (unknownWorkloads) value.total = null; return [key, value]; }));
  return { scope: 'Unique observed mission attempts; initiating V, preparation, queue duplicates and independent-oracle work excluded',
    logicalAttempts: records.length, knownModelWorkflowKinds: eligible.filter(row => ['planning', 'browser_tests', 'review', 'report'].includes(row.kind)).length,
    physicalReceiptWorkflows: receipts.filter(row => row.provider).length, unknownWorkloads,
    missingPhysicalReceipts: receipts.filter(row => !row.explicitProvider).length, invalidPhysicalReceipts: receipts.filter(row => row.explicitProvider && !row.provider).length,
    conflictingMeters: receipts.filter(row => row.conflict).length,
    tokens, tokenReceiptKinds: { physicalProvider: receipts.filter(row => row.provider).length, aggregateOnly: receipts.filter(row => row.aggregate !== null).length, unknown: receipts.filter(row => !row.provider && row.aggregate === null).length },
    aggregateOnlyTokens: measured(receipts.filter(row => row.aggregate !== null).map(row => row.aggregate)),
    physical: fields, toolCalls: measured(records.map(row => row.toolCalls)), reservedTokens: measured(records.map(row => row.reservedTokens)),
    endToEndTokens: null, cost: null, costReason: 'Incomplete end-to-end scope and no locked provider price table' };
}

/** Pure projection of explicit immutable inputs. It does not inspect source
 * files or re-run a saved oracle. Duplicate evidence remains visible once. */
export function summarizeCatalog(inputs) {
  if (!Array.isArray(inputs) || inputs.length > 100) throw new Error('Select at most 100 explicit artifacts');
  const artifacts = new Map(); let duplicateFiles = 0;
  for (const input of inputs) {
    const artifact = normalizeArtifact(input), prior = artifacts.get(artifact.artifactSha256);
    if (prior) { if (prior.payloadHash !== artifact.payloadHash) throw new Error('Conflicting payloads claim the same artifact hash'); prior.files = [...new Set([...prior.files, ...artifact.files])]; duplicateFiles++; }
    else artifacts.set(artifact.artifactSha256, artifact);
  }
  const workloads = new Map(), ledger = new Map(), conversations = new Map();
  const selected = [...artifacts.values()].flatMap(artifact => artifact.trials.flatMap(primary => [primary, ...(primary.independent ? [primary.independent] : [])].map(trial => ({ artifact, trial }))));
  const parents = new Map();
  const find = key => { if (!parents.has(key)) parents.set(key, key); if (parents.get(key) !== key) parents.set(key, find(parents.get(key))); return parents.get(key); };
  for (const { trial } of selected) {
    const left = find(trial.id), right = find(trial.slotId);
    if (left !== right) parents.set(left > right ? left : right, left > right ? right : left);
  }
  for (const { artifact, trial } of selected) {
    const id = find(trial.id), previous = workloads.get(id), reference = { artifactSha256: artifact.artifactSha256, repetition: trial.repetition, role: trial.role };
    if (previous) { previous.records.push(trial); previous.references.push(reference); }
    else workloads.set(id, { records: [trial], references: [reference] });
    if (!trial.stableIdentity) continue;
    for (const row of trial.rows) {
      // Runtime namespace prevents UUID collisions across genuinely isolated DBs.
      const key = hash(canonical([artifact.runtimeNamespace, row.id]));
      const next = { ...row, workload: id }, existing = ledger.get(key);
      if (!existing) ledger.set(key, next);
      else if (canonical({ ...existing, conflict: undefined }) !== canonical({ ...next, conflict: undefined })) ledger.set(key, { ...existing, conflict: true });
    }
    for (const row of trial.conversationRows) {
      const key = hash(canonical([artifact.runtimeNamespace, row.id])), next = { ...row, workload: id }, existing = conversations.get(key);
      if (!existing) conversations.set(key, next);
      else if (canonical({ ...existing, conflict: undefined }) !== canonical({ ...next, conflict: undefined })) conversations.set(key, { ...existing, conflict: true });
    }
  }
  const results = [...workloads].map(([id, group]) => {
    const records = group.records, first = records[0], terminal = [...new Set(records.map(row => row.status).filter(status => ['failed', 'automatically_passed', 'historical_unreviewed'].includes(status)))];
    const isolationFailure = records.some(row => row.isolationFailure), conflict = terminal.length > 1 || new Set(records.map(row => canonical([row.taskId, row.variant, row.sourceSha256, row.protocolVersion]))).size > 1
      || records.some(row => row.pacingState === 'conflicting_or_invalid') || new Set(records.map(row => row.modelRequestIntervalMs).filter(value => value !== null)).size > 1;
    const status = isolationFailure ? 'failed' : conflict ? 'conflicting_records' : terminal[0] ?? (records.some(row => row.status === 'unknown') ? 'unknown' : records.some(row => row.started) ? 'in_progress' : 'not_started');
    const rowKeys = new Set(records.flatMap(row => row.rows.map(item => item.id)));
    const rows = [...ledger.values()].filter(row => row.workload === id && rowKeys.has(row.id));
    const unknown = records.some(row => row.started && row.proofScope !== 'owner-api-contract-only') && (!records.some(row => row.stableIdentity) || !records.some(row => row.ledgerSeen) || rows.length < rowKeys.size);
    const conversationRows = [...conversations.values()].filter(row => row.workload === id);
    const conversationUnknown = records.some(row => row.started && row.proofScope === 'natural-model-access-denial-projection') && (!records.some(row => row.stableIdentity) || !records.some(row => row.conversationSeen));
    return { id, taskId: first.taskId, variant: first.variant, originalVariants: [...new Set(records.map(row => row.originalVariant).filter(Boolean))], role: first.role, status, started: records.some(row => row.started),
      references: group.references, isolationFailure, recordConflict: conflict, supportedProtocol: records.every(row => row.supportedProtocol),
      proofScopes: [...new Set(records.map(row => row.proofScope))], preparation: [...new Set(records.map(row => row.preparation))],
      submittedToModel: records.some(row => row.submittedToModel), reportProse: [...new Set(records.map(row => row.reportProse))],
      externalReview: records.map(row => row.externalReview), observations: records.map(row => ({ time: row.time, recordedFailure: row.recordedFailure, auditOnly: row.auditOnly, fault: row.fault, effectAudit: row.effectAudit, securityAudit: row.securityAudit, repositoryAudit: row.repositoryAudit, ...(row.webAudit ? { webAudit: row.webAudit } : {}),
        ...(row.reportBindingAudit ? { reportBindingAudit: row.reportBindingAudit } : {}), ...(row.browserAudit ? { browserAudit: row.browserAudit } : {}), ...(row.regressionHistory ? { regressionHistory: row.regressionHistory } : {}), ...(row.preservedEvidence ? { preservedEvidence: row.preservedEvidence } : {}), modelRequestIntervalMs: row.modelRequestIntervalMs, pacingState: row.pacingState })),
      usage: usage(rows, unknown ? 1 : 0), conversationUsage: conversationUsage(conversationRows, conversationUnknown ? 1 : 0), gaps: [...new Set(records.flatMap(row => row.gaps))] };
  });
  const catalog = Object.entries(catalogPlan).map(([taskId, variants]) => ({ taskId, variants: [...new Set([...variants, ...results.filter(row => row.taskId === taskId).map(row => row.variant)])].map(variant => {
    const rows = results.filter(row => row.taskId === taskId && row.variant === variant && row.role === 'primary');
    return { variant, minimumRepetitions: 3, status: rows.length ? 'recorded' : 'planned', plannedTrialsInArtifacts: rows.length,
      states: tally(rows.map(row => row.status)), proseUnreviewed: rows.filter(row => row.reportProse.some(state => !['passed', 'completed', 'not_applicable'].includes(state))).length,
      securityReviewPending: rows.filter(row => row.observations.some(value => value.securityAudit)).length, gate: 'not_evaluated' };
  }) }));
  const tainted = new Set(results.filter(row => row.isolationFailure || row.recordConflict).flatMap(row => row.references.map(reference => reference.artifactSha256)));
  const publicArtifacts = [...artifacts.values()].map(value => {
    const artifact = { ...value, workloadIds: [...new Set(value.trials.flatMap(row => [find(row.id), ...(row.independent ? [find(row.independent.id)] : [])]))] };
    delete artifact.trials; delete artifact.payloadHash; delete artifact.runtimeNamespace;
    if (tainted.has(artifact.artifactSha256)) artifact.comparisonKey = null;
    return artifact;
  });
  return { schemaVersion: 1, catalogVersion: '2026-10-05', artifactCount: artifacts.size, duplicateFilesCollapsed: duplicateFiles,
    uniqueWorkloads: results.length, primaryTrials: results.filter(row => row.role === 'primary').length, independentControls: results.filter(row => row.role === 'independent-control').length,
    states: tally(results.map(row => row.status)), artifacts: publicArtifacts, workloads: results, catalog,
    usage: usage([...ledger.values()], results.filter(row => row.usage.unknownWorkloads).length),
    conversationUsage: conversationUsage([...conversations.values()], results.filter(row => row.conversationUsage.unknownWorkloads).length),
    comparisonGroups: [...new Set(publicArtifacts.map(row => row.comparisonKey).filter(Boolean))].map(key => ({ key,
      artifacts: publicArtifacts.filter(row => row.comparisonKey === key).map(row => ({ artifactSha256: row.artifactSha256, sourceSha256: row.sourceSha256 })),
      meaning: 'Same locked protocol only; source implementations remain separate. No automatic gate or improvement claim.' })),
    gate: 'not_evaluated', limitations: [
      'File-only projection: isolation, processes, oracle assertions and report prose were not independently re-verified.',
      'Automatically passed means the selected harness recorded its own automated subset as passed, never full catalogue acceptance.',
      'Historical and unsupported protocols cannot establish current acceptance; isolation failures remain unsuccessful and non-comparable.',
      'Known subtotals combine non-overlapping physical receipts or saved attempt aggregates; aggregate-only calls/cache stay unknown. These are never full end-to-end tokens or monetary cost.',
      'Duplicate workloads and physical attempts are counted once; conflicting saved observations remain explicit and consumption is unknown.',
      'Durations are per preserved observation, not additive workflow/provider/queue time or cross-protocol performance averages.',
      'Provider pacing is a frozen comparison dimension; missing or inconsistent pacing excludes comparison. Effect summaries preserve recorded assertions and pending review, never re-certify access or cancellation.',
      'SEC chat has three repetitions per owner/runtime boundary. Public durable-step tokens are separate from mission usage; HTTP controls and synthetic source preparation contribute no model tokens. Passive provider observation is a separate frozen latency scope, never added to token totals. This projection does not open or verify its sidecar chains; provider-context and semantic-denial gates remain independent.',
      'Report faults retain their separate protocol, original variant and hashed boundary receipts. Only new thread-bound mission attempts contribute usage; synthetic golden preparation, initiating V, transport events and duplicate report-queue meters are excluded. A stored receipt is not an independently re-verified fault or prose gate; wrong-run preparation is synthetic input, not physical fault injection.',
      'Explicit repository normal v2 remains separate from v1 normal and numeric v2 faults. Frozen reviewer/checkpoint policies and saved complement/scope receipts are declarations only; their structural, semantic and prose claims are not re-certified. Older failures remain unchanged.',
      'Browser v4 and explicit repository fault v3 retain separate reviewer/checkpoint/helper identities. Saved interim/final and human/P3 continuation receipts are projected only as counts and hashes, never re-certified; full and semantic acceptance remain independent.',
      'WEB04 browser v5 keeps actual A preparation separate from measured B. Only B-thread mission attempts enter usage; missing B measurement is unknown, never preparation time or zero-cost A. Historical/comparison receipts are recorded hashes and counts, not independently reread bytes or semantic certification. Older synthetic trials remain distinct.',
      'Missing variants remain planned. Three repetitions, independent prose review and remaining fault obligations are never inferred.',
    ] };
}

export async function readCatalog(paths) {
  if (!Array.isArray(paths) || paths.length > 100) throw new Error('Select at most 100 explicit JSON files');
  const inputs = []; let bytesRead = 0;
  for (const path of paths) {
    if (!path.endsWith('.json')) throw new Error('Only explicit JSON files are accepted');
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 64 * 1024 * 1024 || bytesRead + metadata.size > 256 * 1024 * 1024) throw new Error('Artifact read bound exceeded');
    const bytes = await readFile(path); bytesRead += bytes.length;
    if (bytes.length > 64 * 1024 * 1024 || bytesRead > 256 * 1024 * 1024) throw new Error('Artifact read bound exceeded');
    inputs.push({ data: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), sha256: hash(bytes), fileName: path });
  }
  return summarizeCatalog(inputs);
}

export function catalogMarkdown(report) {
  const cell = value => String(value ?? 'unknown').replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');
  const lines = ['# Autonomy catalogue — preserved artifacts', '', `${report.artifactCount} artifacts; ${report.primaryTrials} unique primary trials; ${report.independentControls} independent controls. Overall gate: not evaluated.`, '',
    '| Task / variant | Recorded states | Prose unreviewed | Security review pending |', '| --- | --- | ---: | ---: |'];
  for (const task of report.catalog) for (const variant of task.variants) lines.push(`| ${cell(task.taskId)} / ${cell(variant.variant)} | ${variant.status === 'planned' ? 'planned; no selected run artifact' : cell(JSON.stringify(variant.states))} | ${variant.proseUnreviewed} | ${variant.securityReviewPending} |`);
  lines.push('', '| Workload | Scope | Result | Known tokens / complete mission total | SEC V known / observed-step total | Observed wall ms |', '| --- | --- | --- | --- | --- | --- |');
  for (const row of report.workloads) lines.push(`| ${cell(row.taskId)} / ${cell(row.variant)} / ${row.id.slice(0, 12)} | ${cell(row.proofScopes.join(', '))}; ${cell(row.preparation.join(', '))} | ${cell(row.status)}${row.isolationFailure ? '; ISOLATION FAILURE' : ''} | ${cell(row.usage.tokens.knownSubtotal)} / ${cell(row.usage.tokens.total)} | ${row.proofScopes.includes('natural-model-access-denial-projection') ? `${cell(row.conversationUsage.tokens.knownSubtotal)} / ${cell(row.conversationUsage.tokens.total)}` : 'not observed here'} | ${cell(row.observations.map(value => value.time.observedWallMs ?? 'unknown').join(', '))} |`);
  if (report.workloads.some(row => row.proofScopes.includes('natural-model-access-denial-projection'))) lines.push('', `SEC V public-step tokens: known subtotal ${cell(report.conversationUsage.tokens.knownSubtotal)}; complete observed-step total ${cell(report.conversationUsage.tokens.total)}. Separate from mission usage above; physical provider calls and full end-to-end cost are unknown.`);
  lines.push('', ...report.artifacts.map(row => `- ${row.files.map(cell).join(', ')}: ${cell(row.identity.family)} ${cell(row.identity.version)}; artifact SHA ${row.artifactSha256}; source SHA ${cell(row.sourceSha256)}; provider interval ms ${cell(row.identity.modelRequestIntervalMs)} (${cell(row.identity.pacingState)}); comparison ${cell(row.comparisonKey)}.`), '', ...report.limitations.map(value => `- ${value}`));
  return lines.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(value => value.startsWith('--') && value !== '--format=markdown')) throw new Error('Only --format=markdown and explicit artifact files are accepted');
  const report = await readCatalog(args.filter(value => !value.startsWith('--')));
  process.stdout.write(args.includes('--format=markdown') ? catalogMarkdown(report) : JSON.stringify(report, null, 2) + '\n');
}
