import { JSONParseError, NoObjectGeneratedError, NoOutputGeneratedError, TypeValidationError, type FinishReason } from 'ai';
import { ZodError } from 'zod';

type SchemaIssueDiagnostic = { code: string; path: (string | number)[]; minimum?: number; maximum?: number };
type ValidationDiagnostic = { issues: SchemaIssueDiagnostic[]; omitted: boolean };

type ReviewFailureDiagnostic = {
  version: 1;
  type: 'AI_NoObjectGeneratedError' | 'AI_NoOutputGeneratedError' | 'Error' | 'unknown';
  category: 'output_json_invalid' | 'output_schema_invalid' | 'output_unclassified' | 'output_missing' | 'unexpected';
  finishReason: FinishReason | null;
  validationIssues?: string[];
  validationOmitted?: boolean;
  validatorCode?: keyof typeof validatorMessages;
};

// Exact, fixed messages emitted by the review/output validators. This is a
// diagnostic match, not proof of error origin; never echo the inspected text.
const validatorMessages = {
  assessment_requirement_coverage: 'Assessment must cover exactly the original requirements',
  assessment_unread_evidence: 'Assessment references unread or unknown evidence',
  assessment_evidence_missing: 'Conclusive finding needs evidence',
  assessment_independent_evidence_missing: 'Conclusive finding needs independent evidence from this run',
  assessment_unresolved_requirement: 'Unresolved requirement prevents supported finding',
  assessment_browser_gap_requirement: 'An unclear requirement cannot authorize a browser supplement',
  assessment_browser_gap_context: 'Unresolved evidence context cannot authorize a browser supplement',
  assessment_summary_conflict: 'Assessment summary contradicts its findings',
  subclaim_duplicate: 'Duplicate subclaim',
  subclaim_unread_evidence: 'Subclaim cites unread or foreign evidence',
  subclaim_independent_evidence_missing: 'Conclusive subclaim requires applicable independent evidence',
  subclaim_action_observation_missing: 'Declared action observation lacks a corresponding read action observation',
  read_observation_identity_conflict: 'Conflicting read observation identity',
  read_observation_context_capacity: 'Read observation index exceeds bounded context budget',
  report_check_capacity: 'Report check capacity exceeded',
  report_criterion_coverage: 'Report must cover every original criterion',
} as const;
function validatorCode(error: unknown): keyof typeof validatorMessages | undefined {
  // No SDK/provider subclasses, inherited messages, getters or cause traversal.
  if (!(error instanceof Error) || Object.getPrototypeOf(error) !== Error.prototype) return;
  const message = data(error, 'message');
  if (typeof message !== 'string' || message.length > 256) return;
  for (const code of Object.keys(validatorMessages) as (keyof typeof validatorMessages)[]) {
    if (message === validatorMessages[code]) return code;
  }
}

// These are code-owned fields in the current reviewer/report output schemas.
// Unknown/dynamic keys, issue messages, values and union payloads never escape.
const schemaFields = new Set(['findings', 'checkAssessments', 'criterionId', 'verdict', 'factualNotes', 'observations',
  'text', 'evidenceIds', 'checkRef', 'relation', 'summary', 'requirementId', 'explanation', 'suggestedNextStep',
  'gap', 'kind', 'wantedEvidence', 'capability', 'reportRelation']);
const issueCodes = new Set(['invalid_type', 'too_big', 'too_small', 'invalid_format', 'not_multiple_of',
  'unrecognized_keys', 'invalid_union', 'invalid_key', 'invalid_element', 'invalid_value', 'custom']);
function data(object: unknown, key: string | number): unknown {
  if (!object || typeof object !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function validationDiagnostic(error: unknown): ValidationDiagnostic | undefined {
  try {
    if (!TypeValidationError.isInstance(error)) return;
    const cause = data(error, 'cause');
    if (!(cause instanceof ZodError)) return;
    const issues = data(cause, 'issues');
    if (!Array.isArray(issues)) return;
    const count = data(issues, 'length');
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return;
    const output: SchemaIssueDiagnostic[] = [];
    let omitted = count > 8;
    for (let i = 0; i < Math.min(count, 8); i++) {
      const issue = data(issues, i), code = data(issue, 'code'), path = data(issue, 'path');
      const length = Array.isArray(path) ? data(path, 'length') : undefined;
      if (typeof code !== 'string' || !issueCodes.has(code) || typeof length !== 'number' || length > 8) { omitted = true; continue; }
      const safePath: (string | number)[] = [];
      for (let j = 0; j < length; j++) {
        const segment = data(path, j);
        if (typeof segment === 'string' && schemaFields.has(segment)
          || typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0 && segment <= 10000) safePath.push(segment);
        else break;
      }
      if (safePath.length !== length) { omitted = true; continue; }
      const safe: SchemaIssueDiagnostic = { code, path: safePath };
      // Only size constraints have a meaningful numeric bound here. No received
      // value, enum options, regexp, key list or custom message is diagnostic data.
      const boundKey = code === 'too_big' ? 'maximum' : code === 'too_small' ? 'minimum' : null;
      if (boundKey) {
        const bound = data(issue, boundKey);
        if (typeof bound === 'number' && Number.isSafeInteger(bound) && bound >= 0 && bound <= 1000000) safe[boundKey] = bound;
      }
      output.push(safe);
    }
    return { issues: output, omitted };
  } catch { return; }
}

function safeFinishReason(value: unknown): FinishReason | null {
  switch (value) {
    case 'stop': case 'length': case 'content-filter': case 'tool-calls': case 'error': case 'other':
      return value;
    default:
      return null;
  }
}

/** Log projection only. Never copy provider text, raw reasons, response metadata,
 * usage, arbitrary error names/messages or validation values into diagnostics. */
export function reviewFailureDiagnostic(error: unknown): ReviewFailureDiagnostic {
  try {
    if (NoObjectGeneratedError.isInstance(error)) {
      const cause = error.cause;
      const category = JSONParseError.isInstance(cause) ? 'output_json_invalid'
        : TypeValidationError.isInstance(cause) ? 'output_schema_invalid' : 'output_unclassified';
      const validation = category === 'output_schema_invalid' ? validationDiagnostic(cause) : undefined;
      return {
        version: 1,
        type: 'AI_NoObjectGeneratedError',
        category,
        finishReason: safeFinishReason(error.finishReason),
        // Existing console.warn callers have finite object-inspection depth.
        // Serialize only the safe projection, so nested paths remain visible.
        ...(validation ? { validationIssues: validation.issues.map(issue => JSON.stringify(issue)), validationOmitted: validation.omitted } : {}),
      };
    }
    if (NoOutputGeneratedError.isInstance(error)) {
      return { version: 1, type: 'AI_NoOutputGeneratedError', category: 'output_missing', finishReason: null };
    }
    const code = validatorCode(error);
    return { version: 1, type: error instanceof Error ? 'Error' : 'unknown', category: 'unexpected', finishReason: null,
      ...(code ? { validatorCode: code } : {}),
    };
  } catch {
    // Diagnostic inspection must not replace the original queue failure, even
    // if an arbitrary thrown value has a getter that itself throws.
    return { version: 1, type: 'unknown', category: 'unexpected', finishReason: null };
  }
}
