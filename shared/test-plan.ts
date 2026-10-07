import { z } from "zod";

export const testEntryUrlSchema = z.string().max(2000).refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}, 'Startadressen måste vara HTTP(S) utan inloggningsuppgifter.');

// Planning rationale is not execution evidence. Legacy/manual cases may omit it.
export const testCaseBasisSchema = z.object({
  kind: z.enum(['explicit_requirement', 'exploratory']),
  quote: z.string().max(2000),
  source: z.object({ itemId: z.string().uuid(), version: z.number().int().positive() }).strict().nullable(),
}).strict();

export const testCaseSchema = z.object({
  id: z.string().uuid(),
  title: z.string().max(300),
  type: z.enum(["browser", "api", "manual"]).default("manual"),
  preconditions: z.string().max(5000).default(""),
  steps: z.string().max(10000).default(""),
  expected: z.string().max(5000).default(""),
  basis: testCaseBasisSchema.optional(),
  // Navigation within the existing browser session, never a clean-session claim.
  // Older/manual cases intentionally remain valid without an inferred address.
  entryUrl: testEntryUrlSchema.optional(),
  // Absent on immutable legacy cases; never upgrade their parser on read.
  checksVersion: z.literal(2).optional(),
});
export const testPlanSchema = z.object({
  kind: z.literal("test_plan"),
  summary: z.string().max(20000).default(""),
  cases: z.array(testCaseSchema).max(500).refine(cases => new Set(cases.map(c => c.id)).size === cases.length, "Test IDs must be unique"),
  sources: z.array(z.object({ itemId: z.string().uuid(), version: z.number().int().positive() })).max(20).default([]),
});
export type TestPlan = z.infer<typeof testPlanSchema>;
export type TestCase = z.infer<typeof testCaseSchema>;
export function caseReady(testCase: TestCase) {
  return Boolean(testCase.title.trim() && testCase.steps.trim() && testCase.expected.trim());
}
export function newTestCase(): TestCase {
  return { id: crypto.randomUUID(), title: "", type: "manual", preconditions: "", steps: "", expected: "", checksVersion: 2 };
}
export function renderTestPlan(title: string, plan: TestPlan, version: number) {
  return [`# ${title}`, `Testplan · version ${version}. Detta är en plan, inte ett testresultat.`, plan.summary,
    ...plan.cases.map((c, index) => `## ${index + 1}. ${c.title || "Namnlöst test"}\n\nTest-ID: ${c.id}\nTyp: ${c.type}\nPlanstatus: ${caseReady(c) ? "Redo att planera körning" : "Behöver kompletteras"}${c.basis ? `\nGrund: ${c.basis.kind === 'exploratory' ? 'Utforskande hypotes, inte ett fastställt produktkrav' : 'Uttryckligt krav'}${c.basis.quote ? ` — ${c.basis.quote}` : ''}` : ''}\n\nFörutsättningar:\n${c.preconditions || "Ej angivna"}\n\nSteg:\n${c.steps || "Saknas"}\n\nFörväntat resultat:\n${c.expected || "Saknas"}`),
  ].filter(Boolean).join("\n\n");
}

export function planSection(itemId: string, markdown: string) {
  // Plain Markdown survives editors that strip HTML comments on import.
  return `Testplan-ID: ${itemId} — början\n\n${markdown}\n\nTestplan-ID: ${itemId} — slut`;
}
export function updatePlanSection(body: string, itemId: string, markdown: string) {
  const start = `Testplan-ID: ${itemId} — början`, end = `Testplan-ID: ${itemId} — slut`;
  const a = body.indexOf(start), b = body.indexOf(end);
  if (a < 0 || b < a || body.indexOf(start, a + start.length) !== -1 || body.indexOf(end, b + end.length) !== -1) throw new Error("Published section markers were changed. Resolve the external document before updating.");
  return body.slice(0, a) + planSection(itemId, markdown) + body.slice(b + end.length);
}
