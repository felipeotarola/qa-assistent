import { and, eq, isNull, desc } from 'drizzle-orm';
import { db } from '@nuxthub/db';
import type { Page } from 'playwright-core';
import { testRuns } from '../db/schema/test-runs';
import { testCaptures } from '../db/schema/test-captures';
import { saveFile } from './workspaces';

const captureActions = new Set(['open', 'inspect', 'click', 'press', 'select', 'back', 'forward', 'reload', 'scroll']);
// Called while the workspace browser lock is held. Captures are associated with
// the execution, never inferred from whichever plan happens to be visible.
export async function captureTestStep(userId: string, workspaceId: string, threadId: string, action: string, page: Page, runId?: string, connection: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0] = db) {
  if (!captureActions.has(action)) return {};
  const active = (await connection.select().from(testRuns).where(and(eq(testRuns.workspaceId, workspaceId), eq(testRuns.threadId, threadId), isNull(testRuns.finishedAt), runId ? eq(testRuns.id, runId) : undefined)).orderBy(desc(testRuns.startedAt))).filter(r => r.snapshot.type === 'browser');
  if (!active.length) return runId ? { captureWarning: 'No active browser test run with that ID in this chat.' } : {};
  if (active.length !== 1) return { captureWarning: 'Multiple test runs are active. Supply runId on browser actions to attach screenshots to the correct run.' };
  const run = active[0]!;
  const previous = await connection.select().from(testCaptures).where(eq(testCaptures.runId, run.id));
  if (previous.length >= 30) return { captureWarning: 'Screenshot limit (30 per run) reached. Split longer tests into separate runs.' };
  const id = crypto.randomUUID();
  let url = '', title = '';
  try {
    url = page.url(); title = await page.title();
    // Full-page images cover each visited page, including content below fold.
    // Very large pages fall back to a viewport image to respect Blob limits.
    const options = { type: 'png' as const, timeout: 15000, mask: [page.locator('input[type="password"]')] };
    let bytes = await page.screenshot({ ...options, fullPage: true });
    if (bytes.length > 4 * 1024 * 1024) bytes = await page.screenshot(options);
    const item = await saveFile(userId, workspaceId, `Test-${run.caseId.slice(0,8)}-${previous.length + 1}-${action}.png`, 'image/png', bytes, threadId, connection);
    await connection.insert(testCaptures).values({ id, runId: run.id, itemId: item.id, url, title, action });
    return { capture: { runId: run.id, itemId: item.id, url, title, action } };
  }
  catch {
    const error = 'Skärmbilden kunde inte sparas. Teststeget kan ha utförts; kör inte om handlingen bara för att bilden saknas.';
    await connection.insert(testCaptures).values({ id, runId: run.id, url, title, action, error }).onConflictDoNothing();
    return { captureWarning: error };
  }
}
