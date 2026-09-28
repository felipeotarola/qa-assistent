import type { WorkspaceItem } from "./workspace";
import type { TestPlan } from "./test-plan";
import { newTestCase } from "./test-plan.ts";

// Only map named columns. Missing information stays empty; a URL inventory is
// source material, not evidence that a functional test has been defined.
export function testPlanFromItem(item: WorkspaceItem): TestPlan {
  const tables = item.content.kind === "table" ? [item.content] : item.content.kind === "text" ? (item.content.blocks ?? []).filter(b => b.kind === "table") : [];
  const cases = tables.flatMap(table => {
    const names = table.columns.map(c => c.trim().toLowerCase());
    const column = (choices: string[]) => names.findIndex(n => choices.includes(n));
    const title = column(["test", "testfall", "namn", "title", "name", "test case"]);
    const steps = column(["steg", "steps"]);
    const expected = column(["förväntat resultat", "expected", "expected result"]);
    const preconditions = column(["förutsättningar", "preconditions"]);
    if (title < 0) return [];
    return table.rows.map(row => {
      const value = (i: number) => typeof row[i] === "string" ? row[i] as string : "";
      return { ...newTestCase(), title: value(title).slice(0, 300), steps: value(steps), expected: value(expected), preconditions: value(preconditions) };
    });
  }).slice(0, 500);
  return { kind: "test_plan", summary: `Utkast från ${item.title} (version ${item.version}). Granska testfall och komplettera saknade uppgifter. Tidigare testresultat importeras inte som nya resultat.`, cases, sources: [{ itemId: item.id, version: item.version }] };
}
