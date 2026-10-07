import { z } from 'zod';
import { testCaseBasisSchema, testCaseSchema, type TestCase } from './test-plan.ts';
import { testTargetSchema } from './test-target.ts';

export const MISSION_PLANNER_VERSION = '21';
export const MISSION_PLANNER_MODEL = 'glm-5.3-flash';
// Bounded output allowance; the caller still supplies the original attempt deadline.
export const MISSION_PLANNER_TIMEOUT_MS = 75_000;
export const MISSION_PLANNER_MAX_OUTPUT_TOKENS = 12_000;
export const DEFAULT_NEW_MISSION_CASES = 4;
export const MAX_PLANNING_CONTEXT_CHARS = 100_000;
export const MAX_PLANNED_STEPS = 24;
const httpUrl = z.string().max(2000).refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
});
export const planningSourceSchema = z.object({
  itemId: z.string().uuid(), version: z.number().int().positive(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  url: httpUrl, title: z.string().max(300), text: z.string().max(12_000),
  links: z.array(z.object({ url: httpUrl, label: z.string().max(160) }).strict()).max(40), limited: z.boolean(),
}).strict();
// Describes the existing autonomous browser guards; it grants no authority.
export const MISSION_PLANNING_BROWSER_EXECUTION = Object.freeze({ version: 1 as const, readOnly: true as const,
  agentHttpMethods: Object.freeze(['GET', 'HEAD', 'OPTIONS'] as const), authenticationControls: 'inspect-only' as const, authenticationAccess: 'human-takeover' as const });
const planningBrowserExecutionSchema = z.object({
  version: z.literal(1), readOnly: z.literal(true), agentHttpMethods: z.tuple([z.literal('GET'), z.literal('HEAD'), z.literal('OPTIONS')]),
  authenticationControls: z.literal('inspect-only'), authenticationAccess: z.literal('human-takeover'),
}).strict();
export const missionPlanningInputSchema = z.object({
  schemaVersion: z.literal(1), goal: z.string().trim().min(1).max(10_000), intent: z.enum(['explore', 'verify', 'regression']),
  target: testTargetSchema, allowedOrigins: z.array(httpUrl).min(1).max(20), maxCases: z.number().int().min(1).max(8),
  browserExecution: planningBrowserExecutionSchema,
  sources: z.array(planningSourceSchema).max(4),
  selectedCases: z.array(z.object({ key: z.string(), version: z.number().int().positive(), sourceHash: z.string(), testCase: testCaseSchema }).strict()).max(8),
  limitations: z.array(z.string().max(500)).max(20),
}).strict();
export type MissionPlanningInput = z.infer<typeof missionPlanningInputSchema>;
export const missionPlanningDraftSchema = z.object({
  schemaVersion: z.literal(1), title: z.string().trim().min(1).max(200), summary: z.string().trim().min(1).max(3000),
  cases: z.array(z.object({
    title: z.string().trim().min(1).max(300), entryUrl: httpUrl,
    steps: z.array(z.object({
      action: z.string().trim().min(1).max(600).describe('Konkret handling inom detta fall, inklusive hur uttryckliga villkor för tillstånd, identitet eller tillåtna testdata fastställs inom mandatet. Nödvändiga data hämtas i egna steg eller anges uttryckligen; hänvisa inte till andra falls resultat.'),
      expected: z.string().trim().min(1).max(600).describe('Kort, fullständigt observerbart utfall för just handlingen, med konkreta referensvärden och samtliga uttryckliga villkor. Beskriv själva kontrollen, inte allmän granskningspolicy. Ett okänt eller ouppfyllt villkor lämnar originalkravet overifierat. Kod sammanställer stegens expected ordagrant; inget separat case.expected finns. Numrerad sammanställning får vara högst 5000 tecken per fall, och hela sparade stegtexten inklusive ingång, handlingar och förväntningar högst 10000. Skriv inom gränserna utan avhuggna meningar.'),
    }).strict()).min(1).max(12),
    basis: testCaseBasisSchema,
  }).strict()).min(1).max(8),
  limitations: z.array(z.string().trim().min(1).max(500)).max(8).describe('Kända startfakta, okända tillstånd och begränsningar i underlag eller urval. Dessa får inte skapa nya verifieringskrav; uttryckliga användarvillkor ska samtidigt bevaras som observerbara kontroller i respektive stegs action och expected, aldrig bara som en begränsning.'),
}).strict();
export type MissionPlanningDraft = z.infer<typeof missionPlanningDraftSchema>;

/** Normalized SDK finish reason and measured output only; cap equality is not a diagnosis of truncation. */
export const planningOutputDiagnosticSchema = z.object({
  finishReason: z.enum(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other']).nullable(),
  maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  capReached: z.boolean().nullable(),
}).strict().superRefine((value, context) => {
  const expected = value.outputTokens === null ? null : value.outputTokens >= value.maxOutputTokens;
  if (value.capReached !== expected) context.addIssue({ code: 'custom', path: ['capReached'], message: 'Output cap status must match measured output' });
});
export type PlanningOutputDiagnostic = z.infer<typeof planningOutputDiagnosticSchema>;

/** Safe telemetry only: never provider text, raw errors, values or reasoning. */
export const missionPlanningFailureSchema = z.object({
  version: z.literal(1), code: z.enum(['input_invalid', 'input_not_plannable', 'context_budget', 'configuration_missing',
    'admission_denied', 'cancelled', 'timeout', 'provider_rate_limited', 'provider_rejected',
    'output_json_invalid', 'output_schema_invalid', 'output_missing', 'entry_url_unobserved',
    'source_reference_invalid', 'explicit_requirement_invalid', 'plan_case_budget', 'duplicate_case_title', 'unexpected']),
  output: planningOutputDiagnosticSchema.optional(),
}).strict();
export type MissionPlanningFailure = z.infer<typeof missionPlanningFailureSchema>;
export function planningFailureAllowsRepair(failure: MissionPlanningFailure) {
  return ['output_json_invalid', 'output_schema_invalid', 'output_missing', 'entry_url_unobserved',
    'source_reference_invalid', 'explicit_requirement_invalid', 'plan_case_budget', 'duplicate_case_title'].includes(failure.code);
}
export function planningFailureMessage(failure: MissionPlanningFailure) {
  const messages: Record<MissionPlanningFailure['code'], string> = {
    input_invalid: 'Planeringens indata följer inte det aktuella kontraktet.', input_not_plannable: 'Planeringens underlag kan inte användas för nya testfall.',
    context_budget: 'Planeringsunderlaget ryms inte inom kontextbudgeten.', configuration_missing: 'Planeringens modelltjänst är inte tillgänglig.',
    admission_denied: 'Planeringsförsöket har inte längre ett giltigt mandat.', cancelled: 'Planeringsförsöket avbröts.', timeout: 'Planeringsförsökets tidsgräns tog slut.',
    provider_rate_limited: 'Modelltjänsten begränsade planeringsanropet.', provider_rejected: 'Modelltjänsten kunde inte slutföra planeringsanropet.',
    output_json_invalid: 'Planeringssvaret kunde inte läsas som JSON.', output_schema_invalid: 'Planeringssvaret följer inte det föreskrivna schemat.',
    output_missing: 'Modelltjänsten lämnade ingen färdig plan.', entry_url_unobserved: 'Planen anger en testadress som inte motsvarar en tillåten sparad observation.',
    source_reference_invalid: 'Planen hänvisar till ett annat källunderlag eller en annan version.', explicit_requirement_invalid: 'Planens uttryckliga krav saknar ett giltigt ordagrant citat från uppdraget.',
    plan_case_budget: 'Planen överskrider antalet tillåtna testfall eller steg.', duplicate_case_title: 'Planen innehåller testfall med samma namn.',
    unexpected: 'Planeringen kunde inte slutföras; felkategorin är okänd.',
  };
  return messages[failure.code];
}
export class MissionPlanningValidationError extends Error {
  diagnostic: MissionPlanningFailure;
  constructor(code: MissionPlanningFailure['code']) {
    const diagnostic = missionPlanningFailureSchema.parse({ version: 1, code });
    super(planningFailureMessage(diagnostic)); this.name = 'MissionPlanningValidationError'; this.diagnostic = diagnostic;
  }
}
/** Browser URL semantics, not a fuzzy match: retain path case, query order and
 * fragment. A successful comparison binds back to the saved observed string. */
function observedUrlIdentity(value: string) {
  const url = new URL(httpUrl.parse(value));
  return url.href;
}

export function validateMissionPlanningDraft(input: MissionPlanningInput, value: unknown): MissionPlanningDraft {
  const parsed = missionPlanningDraftSchema.safeParse(value);
  if (!parsed.success) throw new MissionPlanningValidationError('output_schema_invalid');
  const draft = parsed.data;
  if (input.selectedCases.length) throw new MissionPlanningValidationError('input_not_plannable');
  if (!input.sources.length) throw new MissionPlanningValidationError('input_not_plannable');
  if (draft.cases.length > input.maxCases || draft.cases.reduce((sum, c) => sum + c.steps.length, 0) > MAX_PLANNED_STEPS) throw new MissionPlanningValidationError('plan_case_budget');
  if (new Set(draft.cases.map(c => c.title.toLocaleLowerCase())).size !== draft.cases.length) throw new MissionPlanningValidationError('duplicate_case_title');
  // The authorized entry survives discovery redirects. Permission to open it
  // does not assert anything about its destination content or authentication.
  const authorizedTarget = input.target.url && input.allowedOrigins.includes(new URL(input.target.url).origin) ? [input.target.url] : [];
  const entryUrls = new Map([...input.sources.flatMap(s => [s.url, ...s.links.map(l => l.url)]), ...authorizedTarget].map(url => [observedUrlIdentity(url), url]));
  for (const testCase of draft.cases) {
    const observed = entryUrls.get(observedUrlIdentity(testCase.entryUrl));
    if (!observed || !input.allowedOrigins.includes(new URL(testCase.entryUrl).origin)) throw new MissionPlanningValidationError('entry_url_unobserved');
    testCase.entryUrl = observed;
    const basis = testCase.basis;
    if (basis.source && !input.sources.some(s => s.itemId === basis.source!.itemId && s.version === basis.source!.version)) throw new MissionPlanningValidationError('source_reference_invalid');
    // A fetched page is observation, not an approved specification. Selected
    // pre-existing requirements are handled unchanged by the server path.
    if (basis.kind === 'explicit_requirement' && (basis.source || !basis.quote.trim() || !input.goal.includes(basis.quote))) throw new MissionPlanningValidationError('explicit_requirement_invalid');
    // Check the exact stored representation after entry URL normalization.
    // Never clip a requirement or generate a second acceptance text.
    const text = plannedCaseText(testCase);
    if (!testCaseSchema.shape.steps.safeParse(text.steps).success || !testCaseSchema.shape.expected.safeParse(text.expected).success) throw new MissionPlanningValidationError('output_schema_invalid');
  }
  return draft;
}
export function plannedTestCase(value: MissionPlanningDraft['cases'][number], id: string): TestCase {
  return testCaseSchema.parse({ id, title: value.title, type: 'browser', basis: value.basis, preconditions: '', entryUrl: value.entryUrl, checksVersion: 2,
    ...plannedCaseText(value) });
}
function plannedCaseText(value: MissionPlanningDraft['cases'][number]) {
  return {
    steps: value.steps.map((step, index) => `${index + 1}. ${index === 0 ? `Utgå från ${value.entryUrl}. ` : ''}${step.action} Förväntat: ${step.expected}`).join('\n'),
    expected: value.steps.map((step, index) => `${index + 1}. ${step.expected}`).join('\n'),
  };
}
