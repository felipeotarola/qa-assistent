import { and, eq, isNull, desc, sql } from 'drizzle-orm';
import { db } from '@nuxthub/db';
import type { Page } from 'playwright-core';
import { testRuns } from '../db/schema/test-runs';
import { testCaptures } from '../db/schema/test-captures';
import { saveFile } from './workspaces';
import { sanitizeEvidenceUrl } from '../../shared/evidence-provenance';
import { redactReportText } from '../../shared/mission';
import { runtimeScope } from '../../shared/runtime-scope';
import { traceUrl, savedFieldObservation, savedNavigationObservation, type BrowserActionTrace } from './browser-action-trace';
import type { BrowserExecution } from './browser-mission-guard';
import { assertBrowserLock } from './browser-lock';

const captureActions = new Set(['open', 'inspect', 'click', 'press', 'select', 'back', 'forward', 'reload', 'scroll']);
// Called while the workspace browser lock is held. Captures are associated with
// the execution, never inferred from whichever plan happens to be visible.
export async function captureTestStep(userId: string, workspaceId: string, threadId: string, action: string, page: Page, runId?: string, connection: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0] = db, options: { execution?: BrowserExecution; trace?: BrowserActionTrace } = {}) {
  if (!captureActions.has(action) && !options.trace) return {};
  if (options.trace && (!options.execution || options.trace.execution.attemptId !== options.execution.attemptId || options.trace.execution.dispatchId !== options.execution.dispatchId || options.trace.browserJobId !== options.execution.dispatchId)) throw createError({ statusCode: 403, statusMessage: 'Handlingsspåret saknar rätt körförsök.' });
  if (options.execution && !runId) return { captureWarning: 'Autonoma handlingar kräver explicit runId för att spara underlag till rätt test.' };
  const executionScope = options.execution ? and(eq(testRuns.missionAttemptId, options.execution.attemptId), eq(testRuns.runtime, runtimeScope())) : isNull(testRuns.missionAttemptId);
  const active = (await connection.select().from(testRuns).where(and(eq(testRuns.workspaceId, workspaceId), eq(testRuns.threadId, threadId), isNull(testRuns.finishedAt), executionScope, runId ? eq(testRuns.id, runId) : undefined)).orderBy(desc(testRuns.startedAt))).filter(r => r.snapshot.type === 'browser');
  if (!active.length) return runId ? { captureWarning: 'No active browser test run with that ID in this chat.' } : {};
  if (active.length !== 1) return { captureWarning: 'Multiple test runs are active. Supply runId on browser actions to attach screenshots to the correct run.' };
  const run = active[0]!;
  const previous = await connection.select().from(testCaptures).where(eq(testCaptures.runId, run.id));
  if (previous.length >= 30) return { captureWarning: 'Screenshot limit (30 per run) reached. Split longer tests into separate runs.' };
  const id = crypto.randomUUID();
  let url = '', title = '';
  async function persist(bytes?: Buffer, observedAt?: string) {
    // The browser lock is already held by the caller. Keep that lock order and
    // acquire the shared content lock only after taking the screenshot. Finish
    // and review commits use this same lock, so a late capture cannot change
    // the evidence behind an already finalized run or assessment.
    return connection.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspaceId}`}, 0))`);
      await assertBrowserLock();
      const result = await (async () => {
        const [current] = await tx.select({ id: testRuns.id }).from(testRuns).where(and(eq(testRuns.id, run.id), eq(testRuns.workspaceId, workspaceId), eq(testRuns.threadId, threadId), isNull(testRuns.finishedAt), executionScope));
        if (!current) return { captureWarning: 'Testkörningen avslutades innan skärmbilden kunde sparas. Webbläsarhandlingen kan ha utförts; kör inte om den bara för att bilden saknas.' };
        const saved = await tx.select({ id: testCaptures.id }).from(testCaptures).where(eq(testCaptures.runId, run.id));
        if (saved.length >= 30) return { captureWarning: 'Screenshot limit (30 per run) reached. Split longer tests into separate runs.' };
        let actionTrace: { runId: string; itemId: string; action: string; navigation: ReturnType<typeof savedNavigationObservation>; filledField?: ReturnType<typeof savedFieldObservation> } | undefined;
        if (options.trace) {
          const content = Buffer.from(JSON.stringify(options.trace));
          const trace = await saveFile(userId, workspaceId, `Test-${run.caseId.slice(0,8)}-${saved.length + 1}-${action}.json`, 'application/json', content, threadId, tx, { provenance: { version: 1, origin: 'tool', producer: 'browser-action', sourceType: 'test', sourceId: run.id, observedAt: options.trace.finishedAt, url: options.trace.toUrl } });
          await tx.insert(testCaptures).values({ id: crypto.randomUUID(), runId: run.id, itemId: trace.id, url, title, action: `trace:${action}` });
          actionTrace = { runId: run.id, itemId: trace.id, action, navigation: savedNavigationObservation(options.trace), ...(action === 'fill' ? { filledField: savedFieldObservation(options.trace) } : {}) };
          if (saved.length + 1 >= 30) return { actionTrace, captureWarning: 'Underlagsgränsen (30 per test) nådd. Handlingsspåret sparades, men ingen ytterligare skärmbild.' };
        }
        if (bytes) {
          const item = await saveFile(userId, workspaceId, `Test-${run.caseId.slice(0,8)}-${saved.length + 1}-${action}.png`, 'image/png', bytes, threadId, tx, { provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: run.id, observedAt: observedAt!, url: sanitizeEvidenceUrl(redactReportText(url)) } });
          await tx.insert(testCaptures).values({ id, runId: run.id, itemId: item.id, url, title, action });
          return { ...(actionTrace ? { actionTrace } : {}), capture: { runId: run.id, itemId: item.id, url, title, action } };
        }
        const error = 'Skärmbilden kunde inte sparas. Teststeget kan ha utförts; kör inte om handlingen bara för att bilden saknas.';
        await tx.insert(testCaptures).values({ id, runId: run.id, url, title, action, error }).onConflictDoNothing();
        return { ...(actionTrace ? { actionTrace } : {}), captureWarning: error };
      })();
      // Losing the independent browser lock cannot publish a late capture.
      // This final fence throws inside the transaction and rolls it back.
      await assertBrowserLock();
      return result;
    });
  }
  try {
    url = options.execution ? traceUrl(page.url()) || '' : page.url(); title = options.execution ? options.trace?.observation?.title || '' : await page.title();
    // Full-page images cover each visited page, including content below fold.
    // Very large pages fall back to a viewport image to respect Blob limits.
    const screenshotOptions = { type: 'png' as const, timeout: 15000, mask: [page.locator(options.execution ? 'input,textarea,[contenteditable=true]' : 'input[type="password"]')] };
    let bytes = await page.screenshot({ ...screenshotOptions, fullPage: true });
    if (bytes.length > 4 * 1024 * 1024) bytes = await page.screenshot(screenshotOptions);
    return await persist(bytes, new Date().toISOString());
  }
  catch {
    return persist();
  }
}
