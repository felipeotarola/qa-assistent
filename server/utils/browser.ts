/// <reference lib="dom" />
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import Browserbase from "@browserbasehq/sdk";
import { chromium, type Browser, type Page, type Response, type Request, type BrowserContext, type CDPSession } from "playwright-core";
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import type { BrowserAction, BrowserView } from "../../shared/browser";
import { getThreadForUser } from "./threads";
import { requireWorkspace } from "./workspaces";
import { captureTestStep } from './test-captures';
import { vpsBrowserRequest, type VpsBrowserSession } from './vps-browser';
import { bindBrowserPhysicalSession, guardBrowserOperation, type BrowserActor, type BrowserPolicy, policyDigest } from './browser-mission-guard';
import { traceFilledField, traceUrl, type BrowserActionTrace } from './browser-action-trace';
import { registerBrowserTraceValues, readBrowserTraceObservation } from './browser-trace-privacy';
import { autonomyEnabled } from './mission-control';
import { browserActorAssignment } from './mission-browser-return';
import { captureBrowserTakeover, recordBrowserTakeover } from './mission-browser-takeover';
import { runtimeScope } from '../../shared/runtime-scope';
import { openMissionPreview } from './mission-preview';
import { withBrowserLock, assertBrowserLock, browserLockSignal } from './browser-lock';

const IDLE_MS = 10 * 60 * 1000;
type Row = typeof schema.browserAssignments.$inferSelect;
type Tx = typeof db;
const connections = new Map<string, Browser>();
const previewId = (row: Row) => row.projectId?.startsWith('vps-preview-policy-v1:') ? row.projectId.split(':')[1] : row.projectId?.startsWith('vps-preview:') ? row.projectId.slice('vps-preview:'.length) : undefined;
const autonomousPolicy = (row: Row) => row.projectId?.startsWith('vps-preview-policy-v1:') ? row.projectId.split(':')[2] : row.projectId?.startsWith('self-hosted-policy-v1:') ? row.projectId.slice('self-hosted-policy-v1:'.length) : undefined;
const selfHosted = (row: Row) => row.projectId === 'self-hosted-v1' || !!autonomousPolicy(row) || !!previewId(row);

async function connect(row: Row) {
  await assertBrowserLock();
  const existing = connections.get(row.sessionId!);
  if (existing?.isConnected()) { disconnectOnLockLoss(existing); return existing; }
  const browser = await chromium.connectOverCDP(row.connectUrl!, { timeout: 15000 });
  const id = row.sessionId!;
  connections.set(id, browser);
  browser.on("disconnected", () => { if (connections.get(id) === browser) connections.delete(id); });
  disconnectOnLockLoss(browser); await assertBrowserLock();
  return browser;
}
function disconnectOnLockLoss(browser: Browser) {
  // Disconnect this app's CDP client. A command already accepted remotely can
  // still complete; admission receipts therefore retain an unknown outcome.
  const signal = browserLockSignal();
  const abort = () => { void browser.close().catch(() => {}); };
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
}

export async function disconnectBrowsers() {
  await Promise.allSettled([...connections.values()].map(browser => browser.close()));
  connections.clear();
}

function provider() {
  if (!process.env.BROWSERBASE_API_KEY) throw createError({ statusCode: 503, statusMessage: "Browserbase is not configured" });
  return new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY, timeout: 20000, maxRetries: 0 });
}

export async function requireBrowserThread(userId: string, threadId: string) {
  if (!await getThreadForUser(userId, threadId)) throw createError({ statusCode: 404, statusMessage: "Chat not found" });
}

async function locked<T>(userId: string, threadId: string, fn: (tx: Tx, row: Row) => Promise<T>, options: { agentId?: string; sessionId?: string } = {}) {
  const thread = await getThreadForUser(userId, threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: 'Workspace not found' });
  await requireWorkspace(userId, thread.workspaceId);
  let ownerThread = threadId, agentId = options.agentId || 'main';
  if (options.sessionId) {
    const [selected] = await db.select().from(schema.browserAssignments).where(and(eq(schema.browserAssignments.workspaceId, thread.workspaceId), eq(schema.browserAssignments.userId, userId), eq(schema.browserAssignments.sessionId, options.sessionId)));
    if (!selected) throw createError({ statusCode: 404, statusMessage: 'Browser assignment not found' });
    ownerThread = selected.threadId; agentId = selected.agentId;
  }
  return lockedWorkspace(userId, thread.workspaceId, ownerThread, agentId, fn, options.sessionId);
}

async function lockedWorkspace<T>(userId: string, workspaceId: string, threadId: string, agentId: string, fn: (tx: Tx, row: Row) => Promise<T>, expectedSession?: string) {
  return withBrowserLock('browser:' + workspaceId + ':' + threadId + ':' + agentId, async () => {
    // Commit assignment/FK locks before any admission or browser network await.
    // The separate lock-only connection serializes across app processes.
    const row = await db.transaction(async tx => {
      const scope = and(eq(schema.browserAssignments.workspaceId, workspaceId), eq(schema.browserAssignments.threadId, threadId), eq(schema.browserAssignments.agentId, agentId));
      let [row] = await tx.select().from(schema.browserAssignments).where(scope).for('update');
      if (!row) {
        // Adopt the old default exactly once. Other assignments always start fresh.
        let legacy: Partial<Row> = {};
        if (agentId === 'main') {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'browser-legacy:' + workspaceId}, 0))`);
          const [old] = await tx.select().from(schema.workspaceBrowsers).where(and(eq(schema.workspaceBrowsers.workspaceId, workspaceId), eq(schema.workspaceBrowsers.userId, userId)));
          if (old?.sessionId) {
            legacy = old;
            await tx.update(schema.workspaceBrowsers).set({ sessionId: null, connectUrl: null, liveUrl: null, expiresAt: null }).where(eq(schema.workspaceBrowsers.workspaceId, workspaceId));
          }
        }
        [row] = await tx.insert(schema.browserAssignments).values({ ...legacy, id: randomUUID(), userId, workspaceId, threadId, agentId }).returning();
      }
      if (!row || row.userId !== userId || (expectedSession && row.sessionId !== expectedSession)) throw createError({ statusCode: 404, statusMessage: 'Browser not found' });
      await assertBrowserLock();
      return row;
    });
    await assertBrowserLock();
    return fn(db, row);
  });
}

function view(row: Row): BrowserView | null {
  if (!row.sessionId || !row.liveUrl || !row.expiresAt || row.expiresAt.getTime() <= Date.now()) return null;
  return { assignmentId: row.id, threadId: row.threadId, agentId: row.agentId, preview: !!previewId(row), sessionId: row.sessionId, liveUrl: row.liveUrl, url: row.url, title: row.title, control: row.control === "human" ? "human" : "agent", expiresAt: row.expiresAt.toISOString() };
}

async function patch(tx: Tx, row: Row, changes: Partial<Row>) {
  await assertBrowserLock();
  await tx.transaction(async write => {
    await write.update(schema.browserAssignments).set(changes).where(eq(schema.browserAssignments.id, row.id));
    // UPDATE may have waited behind a row lock. Losing browser ownership while
    // waiting must roll this write back, not publish a late assignment state.
    await assertBrowserLock();
  });
  Object.assign(row, changes);
}

async function release(tx: Tx, row: Row) {
  await assertBrowserLock();
  if (row.sessionId && row.projectId) {
    try {
      if (selfHosted(row)) await vpsBrowserRequest(`/sessions/${row.sessionId}`, 'DELETE', previewId(row));
      else await provider().sessions.update(row.sessionId, { projectId: row.projectId, status: "REQUEST_RELEASE" });
    }
    catch (error) {
      // An expired or already deleted session has nothing left to release.
      if (!(error instanceof Browserbase.APIError) || ![404, 410].includes(error.status ?? 0)) throw error;
    }
    await connections.get(row.sessionId)?.close().catch(() => {});
    connections.delete(row.sessionId);
  }
  await patch(tx, row, { sessionId: null, connectUrl: null, liveUrl: null, expiresAt: null, control: "agent" });
}

export async function getBrowserView(userId: string, threadId: string, sessionId?: string) {
  return locked(userId, threadId, async (tx, row) => {
    if (!row.sessionId) return null;
    if (selfHosted(row)) {
      const current = await vpsBrowserRequest<{ status: string } | undefined>('/sessions/' + row.sessionId, 'GET', previewId(row));
      if (!current || current.status === 'closed') { await release(tx, row); return null; }
    }
    if (row.activeAt.getTime() < Date.now() - IDLE_MS || (row.expiresAt?.getTime() ?? 0) <= Date.now()) { await release(tx, row); return null; }
    return view(row);
  }, { sessionId });
}
export async function listBrowserViews(userId: string, threadId: string) {
  const thread = await getThreadForUser(userId, threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: 'Workspace not found' });
  const rows = await db.select().from(schema.browserAssignments).where(and(eq(schema.browserAssignments.workspaceId, thread.workspaceId), eq(schema.browserAssignments.userId, userId)));
  return rows.map(view).filter((value): value is BrowserView => value !== null);
}

export async function controlBrowser(userId: string, threadId: string, control: "human" | "agent" | "close" | "heartbeat", sessionId?: string, options: { requireAgentControl?: boolean } = {}) {
  return locked(userId, threadId, async (tx, row) => {
    // Ownership is independent of whether an expired session still has a
    // displayable view. Recheck under the same lock as the physical close.
    if (options.requireAgentControl && row.control === 'human') throw createError({ statusCode: 409, statusMessage: 'Användaren styr webbläsaren; bakgrundsstädning får inte stänga den.' });
    if (control === "close") { await release(tx, row); return null; }
    if (!view(row)) return null;
    if (control === "heartbeat") {
      // Watching a preview also uses its sandbox, within the provider's hard cap.
      if (previewId(row)) await vpsBrowserRequest('/heartbeat', 'POST', previewId(row));
      if (row.control === "human" || previewId(row)) await patch(tx, row, { activeAt: new Date() });
    }
    else {
      const takeover = control === 'human' ? await captureBrowserTakeover(tx, row) : null;
      if (selfHosted(row)) {
        const result = await vpsBrowserRequest<{ liveUrl?: string }>(`/sessions/${row.sessionId}/${control}?scoped=1`, 'POST', previewId(row));
        if (result.liveUrl) await patch(tx, row, { liveUrl: result.liveUrl });
      }
      await patch(tx, row, { control, activeAt: new Date() });
      if (control === 'human') await recordBrowserTakeover(tx, row, takeover);
    }
    return view(row);
  }, { sessionId });
}

export async function assignPreviewBrowser(userId: string, threadId: string, agentId: string, session: VpsBrowserSession & { sandboxId: string; previewUrl: string }) {
  return locked(userId, threadId, async (tx, row) => {
    if (row.sessionId === session.sessionId) return view(row);
    if (row.sessionId && row.sessionId !== session.sessionId) await release(tx, row);
    await patch(tx, row, { sessionId: session.sessionId, projectId: 'vps-preview:' + session.sandboxId, connectUrl: session.connectUrl, liveUrl: session.liveUrl, expiresAt: new Date(session.expiresAt), activeAt: new Date(), control: 'agent', url: session.previewUrl, title: 'Lokal app på VPS' });
    return view(row);
  }, { agentId });
}

export async function captureWorkspaceBrowser(userId: string, threadId: string, options: { agentId?: string; sessionId?: string } = {}) {
  return locked(userId, threadId, async (tx, row) => {
    if (row.control === "human" || !view(row)) throw createError({ statusCode: 409, statusMessage: "Return browser control before capturing" });
    if (previewId(row)) await vpsBrowserRequest('/heartbeat', 'POST', previewId(row));
    const browser = await connect(row);
    const page = await foregroundPage(browser.contexts()[0]!.pages());
    if (!page) throw createError({ statusCode: 409, statusMessage: "Open a page first" });
    const bytes = await page.screenshot({ type: "png", timeout: 15000, mask: [page.locator('input[type="password"]')] });
    await patch(tx, row, { activeAt: new Date() });
    return bytes;
  }, options);
}

function webUrl(input?: string) {
  let url: URL;
  try { url = new URL(input?.includes("://") ? input : `https://${input ?? ""}`); }
  catch { throw createError({ statusCode: 400, statusMessage: "Provide a valid website URL" }); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw createError({ statusCode: 400, statusMessage: "Only HTTP(S) website URLs without credentials are supported" });
  return url.href;
}

async function start(tx: Tx, row: Row, policy?: BrowserPolicy) {
  await assertBrowserLock();
  if (process.env.BROWSER_PROVIDER === 'vps') {
    const session = await vpsBrowserRequest<VpsBrowserSession>('/sessions', 'POST', undefined, policy ? { policy } : undefined);
    try {
      if (policy && (session.policyVersion !== 1 || session.policyDigest !== policyDigest(policy))) throw createError({ statusCode: 503, statusMessage: 'Webbläsartjänsten saknar bekräftat stöd för uppdragets läsmandat.' });
      await patch(tx, row, { sessionId: session.sessionId, projectId: policy ? `self-hosted-policy-v1:${session.policyDigest}` : 'self-hosted-v1', connectUrl: session.connectUrl, liveUrl: session.liveUrl, expiresAt: new Date(session.expiresAt), activeAt: new Date(), control: 'agent' });
    }
    catch (error) {
      await vpsBrowserRequest(`/sessions/${session.sessionId}`, 'DELETE').catch(() => {});
      throw error;
    }
    return;
  }
  if (policy) throw createError({ statusCode: 503, statusMessage: 'Autonoma tester kräver en webbläsartjänst med beständigt läsmandat.' });
  const bb = provider();
  const projects = process.env.BROWSERBASE_PROJECT_ID ? [{ id: process.env.BROWSERBASE_PROJECT_ID }] : await bb.projects.list();
  if (projects.length !== 1) throw createError({ statusCode: 503, statusMessage: "Set BROWSERBASE_PROJECT_ID to select a project" });
  const projectId = projects[0]!.id;
  const contextId = row.contextId ?? (await bb.contexts.create({ projectId })).id;
  // Persist the context even if session creation fails.
  await patch(tx, row, { contextId });
  const session = await bb.sessions.create({
    projectId, keepAlive: true, api_timeout: 1800, region: "eu-central-1",
    browserSettings: { context: { id: contextId, persist: true }, viewport: { width: 1280, height: 900 }, recordSession: false, logSession: false },
  });
  try {
    const live = await bb.sessions.debug(session.id);
    await patch(tx, row, { sessionId: session.id, projectId, connectUrl: session.connectUrl, liveUrl: live.debuggerFullscreenUrl, expiresAt: new Date(Date.now() + 1800_000), activeAt: new Date(), control: "agent" });
  }
  catch (error) {
    await bb.sessions.update(session.id, { projectId, status: "REQUEST_RELEASE" }).catch(() => {});
    throw error;
  }
}

function refMac(sessionId: string, fields: readonly string[]) {
  const secret = process.env.INTERNAL_API_SECRET?.trim();
  if (!secret) throw createError({ statusCode: 503, statusMessage: 'Internal API is not configured' });
  return createHmac('sha256', secret).update(JSON.stringify(['browser-control-ref-v1', runtimeScope(), sessionId, ...fields])).digest('hex');
}
async function pageTargetId(page: Page) {
  const session = await page.context().newCDPSession(page);
  try { return (await session.send('Target.getTargetInfo')).targetInfo.targetId; }
  finally { await session.detach(); }
}
function pageKey(sessionId: string, targetId: string) { return refMac(sessionId, ['page', targetId]).slice(0, 24); }
function signedRef(sessionId: string, key: string, nonce: string, index: number) {
  const fields = [key, nonce, String(index)];
  return `p-${fields.join('-')}-${refMac(sessionId, ['control', ...fields]).slice(0, 32)}`;
}
/** The browser DOM is untrusted. Resolve only a server-issued reference to the
 * actual CDP target that produced its snapshot, never a DOM attribute copied to
 * another tab. No process-local cache or raw target ID is needed after restart. */
async function pageForRef(pages: Page[], sessionId: string, ref?: string) {
  const invalid = () => createError({ statusCode: 409, statusMessage: 'Kontrollen saknar en aktuell sidobservation. Inspektera webbläsaren och använd en ny ref innan nästa handling.' });
  const parts = /^p-([a-f0-9]{24})-([a-f0-9]{16})-([0-9]{1,3})-([a-f0-9]{32})$/.exec(ref ?? '');
  if (!parts || Number(parts[3]) >= 150) throw invalid();
  const expected = refMac(sessionId, ['control', parts[1]!, parts[2]!, parts[3]!]).slice(0, 32);
  if (!timingSafeEqual(Buffer.from(parts[4]!, 'hex'), Buffer.from(expected, 'hex'))) throw invalid();
  for (const page of pages) {
    if (page.isClosed()) continue;
    const targetId = await pageTargetId(page).catch(() => null);
    if (targetId && pageKey(sessionId, targetId) === parts[1]) return page;
  }
  throw invalid();
}
async function snapshot(page: Page, sessionId: string) {
  const key = pageKey(sessionId, await pageTargetId(page)), nonce = randomBytes(8).toString('hex');
  const refs = Array.from({ length: 150 }, (_, index) => signedRef(sessionId, key, nonce, index));
  const controlSnapshot = await page.locator("body").evaluate((body, refs) => {
    // Ordinary stale refs disappear when a new observation is returned. Signing
    // binds page identity; it is not a claim that untrusted DOM cannot change.
    body.querySelectorAll('[data-pat-ref]').forEach(element => element.removeAttribute('data-pat-ref'));
    const elements = Array.from(body.querySelectorAll("a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true]"));
    const rendered = elements.filter((el) => {
      const rect = el.getBoundingClientRect();
      return el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && rect.width > 0 && rect.height > 0;
    });
    const controls = rendered.slice(0, 150).map((el, index) => {
      const rect = el.getBoundingClientRect();
      const ref = refs[index]!;
      el.setAttribute("data-pat-ref", ref);
      return { ref, inViewport: rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth, tag: el.tagName.toLowerCase(), type: el.getAttribute("type"), label: (el.getAttribute("aria-label") || el.getAttribute("placeholder") || (el as HTMLInputElement).labels?.[0]?.textContent || el.textContent || "").trim().slice(0, 160) };
    });
    return { controls, controlsTruncated: rendered.length > controls.length, controlScope: 'Rendered DOM controls, including offscreen elements; excludes iframes and custom controls without interactive semantics. Absence does not prove a missing control.' };
  }, refs);
  const text = await page.locator("body").innerText();
  return { url: page.url(), title: await page.title(), text: text.slice(0, 16000), textTruncated: text.length > 16000, ...controlSnapshot };
}

async function foregroundPage(pages: Page[]) {
  for (const page of [...pages].reverse()) {
    if (await page.evaluate(() => document.visibilityState === "visible").catch(() => false)) return page;
  }
  return pages.at(-1);
}

export async function browserAction(userId: string, threadId: string, input: BrowserAction, agentId = 'main', actor: BrowserActor = {}) {
  // Resolve a server-owned alias before locking; all authoritative actor,
  // assignment, claim and deadline checks still run inside that same lock.
  const returned = await browserActorAssignment(db, userId, threadId, agentId, actor);
  return locked(userId, threadId, async (tx, row) => {
    const authorized = await guardBrowserOperation(tx, userId, row.workspaceId, threadId, agentId, input, actor, view(row)?.sessionId ?? null);
    if (autonomousPolicy(row) && !authorized) throw createError({ statusCode: 403, statusMessage: 'Den här webbläsaren tillhör ett autonomt körförsök.' });
    if (authorized?.replay) return { status: 'outcome_unknown', message: 'Det här verktygsanropet har redan auktoriserats och kan ha utförts. Handlingen upprepas inte. Inspektera med ett nytt anrop innan du bedömer eller fortsätter.' };
    if (row.control === "human") return { status: "human_control", message: "The user controls the browser. End this turn and wait for them to return control. Do not retry or use another browser." };
    if (input.action === "close") { await release(tx, row); return { status: "closed" }; }
    if (!view(row)) {
      if (input.action !== "open") return { status: "closed", message: "Open a website to start a browser session." };
      webUrl(input.url);
      await release(tx, row);
      try {
        if (authorized?.preview) {
          const { session } = await openMissionPreview(authorized.execution.attemptId, authorized.policy);
          await patch(tx, row, { sessionId: session.sessionId, projectId: `vps-preview-policy-v1:${session.sandboxId}:${session.policyDigest}`, connectUrl: session.connectUrl,
            liveUrl: session.liveUrl, expiresAt: new Date(session.expiresAt), activeAt: new Date(), control: 'agent', url: session.previewUrl, title: 'Uppdragets testmiljö' });
        } else await start(tx, row, authorized?.policy);
      }
      catch (error) {
        const occupied = (error as { statusCode?: number }).statusCode === 409;
        return { status: "session_start_failed", message: process.env.BROWSER_PROVIDER === 'vps'
          ? occupied ? 'The VPS browser pool has reached its capacity. Existing sessions continue normally. Retry when a slot is free; do not close another workspace session.' : 'The VPS browser service could not start a session. Check the service and Tailscale connection before retrying.'
          : 'Browserbase could not start the browser. Check available browser minutes and project settings. Retry once the issue is resolved.' };
      }
    }
    if (authorized && autonomousPolicy(row) !== authorized.policyDigest) throw createError({ statusCode: 409, statusMessage: 'Webbläsaren har inte körförsökets aktuella läsmandat.' });
    if (authorized) await bindBrowserPhysicalSession(userId, row.workspaceId, threadId, agentId, actor, authorized.execution, row.sessionId!, authorized.policy);
    let browser;
    let phase = "connect";
    let context: BrowserContext | undefined, actionPage: Page | undefined, inputPage: Page | undefined, popupSession: CDPSession | undefined;
    const actionPopups: Page[] = [];
    let popupReady: (() => void) | undefined;
    const observePopup = (page: Page) => { actionPopups.push(page); popupReady?.(); };
    const navigationResponses = new Map<Page, { url: string; status: number }>();
    const failedRequests: BrowserActionTrace['failedRequests'] = [];
    const observeResponse = (response: Response) => {
      try { if (response.request().isNavigationRequest() && !response.frame().parentFrame()) navigationResponses.set(response.frame().page(), { url: response.url(), status: response.status() }); } catch { /* No frame response is not navigation evidence. */ }
    };
    const observeFailure = (request: Request) => {
      if (failedRequests.length < 10) failedRequests.push({ url: traceUrl(request.url()), method: request.method(), reason: request.failure()?.errorText.includes('BLOCKED_BY_CLIENT') ? 'policy_blocked' : 'request_failed' });
    };
    let trace: BrowserActionTrace | undefined;
    const record = async (page: Page, outcome: BrowserActionTrace['outcome']) => {
      await assertBrowserLock();
      if (trace) {
        const response = navigationResponses.get(page);
        trace.finishedAt = new Date().toISOString(); trace.toUrl = traceUrl(page.url()); trace.httpStatus = response && response.url === page.url().split('#')[0] ? response.status : null; trace.outcome = outcome;
          trace.observation = authorized ? await readBrowserTraceObservation(row.sessionId!, authorized.policyDigest, page, previewId(row)).catch(() => null) : null;
      }
      return captureTestStep(userId, row.workspaceId, threadId, input.action, page, input.runId, tx, authorized ? { execution: authorized.execution, trace } : {});
    };
    try {
      if (previewId(row)) await vpsBrowserRequest('/heartbeat', 'POST', previewId(row));
      if (authorized) {
          const current = await vpsBrowserRequest<VpsBrowserSession | undefined>(`/sessions/${row.sessionId}`, 'GET', previewId(row));
        if (!current || current.policyVersion !== 1 || current.policyDigest !== authorized.policyDigest) throw createError({ statusCode: 503, statusMessage: 'Browser policy receipt missing' });
      }
      browser = await connect(row);
      context = browser.contexts()[0]!;
      const pages = context.pages();
      const usesRef = ['click', 'fill', 'select', 'press'].includes(input.action);
      let page = usesRef ? await pageForRef(pages, row.sessionId!, input.ref) : await foregroundPage(pages) ?? await context.newPage();
      if (authorized && input.action === 'open' && page.url() !== 'about:blank' && !authorized.policy.allowedOrigins.includes(new URL(page.url()).origin)) {
        // A denied redirect can leave Chromium's error document at the blocked
        // location. Recover only by explicitly opening an authorized URL.
        const blocked = page; page = await context.newPage(); await blocked.close();
      }
      actionPage = page;
      inputPage = page;
      page.setDefaultTimeout(8000);
      page.setDefaultNavigationTimeout(15000);
      context.on('response', observeResponse);
      context.on('requestfailed', observeFailure);
      if (authorized) {
        if (page.url() !== 'about:blank' && !authorized.policy.allowedOrigins.includes(new URL(page.url()).origin)) throw createError({ statusCode: 403, statusMessage: 'Current page is outside the mission target' });
        trace = { version: 1, browserJobId: authorized.browserJobId, callId: authorized.callId, execution: authorized.execution, action: input.action, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), fromUrl: traceUrl(page.url()), toUrl: null, httpStatus: null, outcome: 'action_failed', observation: null, failedRequests, limitation: 'Observerad webbläsarhandling och begränsat DOM-utdrag. En bild visar tillstånd, inte att alla testkrav är uppfyllda. Saknad navigation eller HTTP-status är inte i sig ett produktfel. Nätverksfel kan bero på läsmandatet; kontrollera failedRequests.' };
        if (input.ref && ['fill', 'press', 'select', 'click'].includes(input.action)) {
          const authField = await page.locator(`[data-pat-ref="${input.ref}"]`).evaluate(element => {
            const input = element as HTMLInputElement;
            return input.type === 'password' || /(?:username|password|one-time-code)/i.test(input.autocomplete || '') || !!input.closest('form')?.querySelector('input[type=password],[autocomplete=username],[autocomplete=one-time-code]');
          });
          if (authField) throw createError({ statusCode: 403, statusMessage: 'Authentication requires a separate explicit mandate' });
        }
      }
      const target = () => {
        if (!input.ref) throw new Error("Read the page first and provide a control ref from the latest snapshot.");
        return page.locator(`[data-pat-ref="${input.ref}"]`);
      };
      page.on('popup', observePopup);
      let openerId: string | undefined;
      const previousTargets = new Set<string>();
      if (usesRef) {
        popupSession = await context.newCDPSession(page);
        openerId = (await popupSession.send('Target.getTargetInfo')).targetInfo.targetId;
        for (const target of (await popupSession.send('Target.getTargets')).targetInfos) previousTargets.add(target.targetId);
      }
      // Session creation/CDP connection can take seconds. Recheck after those
      // awaits, without consuming a second call, so cancellation wins that gap.
      if (authorized) await guardBrowserOperation(tx, userId, row.workspaceId, threadId, agentId, input, actor, row.sessionId);
      await assertBrowserLock();
      phase = input.action;
      switch (input.action) {
        case "open": await page.goto(webUrl(input.url), { waitUntil: "domcontentloaded" }); break;
        case "click": await target().click(); break;
        case "fill":
          // The browser service retains exact redaction values for the physical
          // session across app-worker restarts. No successful receipt, no fill.
          if (authorized) {
            await registerBrowserTraceValues(row.sessionId!, authorized.policyDigest, [input.text ?? ''], previewId(row));
            await guardBrowserOperation(tx, userId, row.workspaceId, threadId, agentId, input, actor, row.sessionId);
            await assertBrowserLock();
          }
          await target().fill(input.text ?? "");
          if (trace) trace.filledField = await traceFilledField(target(), input.text ?? '').catch(() => null);
          break;
        case "press": await target().press(input.text ?? "Enter"); break;
        case "select": await target().selectOption({ label: input.text ?? "" }); break;
        case "scroll": await page.mouse.wheel(0, input.direction === "up" ? -650 : 650); break;
        case "back": await page.goBack({ waitUntil: "commit" }); break;
        case "forward": await page.goForward({ waitUntil: "commit" }); break;
        case "reload": await page.reload({ waitUntil: "domcontentloaded" }); break;
      }
      // OPEN observes its goto page. A ref action observes the page that owned
      // that ref, or a popup it actually opened during this operation. An older
      // foreground tab cannot replace either the action or its observation.
      const openedPopups: Page[] = [];
      if (popupSession) {
        const openedTargets = new Set((await popupSession.send('Target.getTargets')).targetInfos.filter(target => target.openerId === openerId && !previousTargets.has(target.targetId)).map(target => target.targetId));
        // A popup target exists before Playwright emits its page event (which
        // waits for the initial response). Wait only when Chromium confirms a
        // newly opened target; ordinary clicks get no fixed extra delay.
        if (openedTargets.size && !actionPopups.length) await new Promise<void>(resolve => {
          const timeout = setTimeout(resolve, 5000);
          popupReady = () => { clearTimeout(timeout); resolve(); };
        });
        for (const popup of actionPopups) {
          const targetId = !popup.isClosed() && await pageTargetId(popup).catch(() => null);
          if (targetId && openedTargets.has(targetId)) openedPopups.push(popup);
        }
      }
      const activePage = input.action === 'open' ? page : usesRef
        ? await foregroundPage(openedPopups) ?? page
        : await foregroundPage(context.pages()) ?? page;
      actionPage = activePage;
      activePage.setDefaultTimeout(8000);
      let navigation: { expectedUrl: string; verified: boolean } | undefined;
      if (input.expectedUrl) {
        const expected = new URL(input.expectedUrl).href;
        await activePage.waitForURL(url => url.href === expected, { timeout: 5000, waitUntil: 'domcontentloaded' }).catch(() => {});
        navigation = { expectedUrl: expected, verified: activePage.url() === expected };
      }
      phase = "read";
      // Read the actual DOM: cached history restores can omit lifecycle events
      // on a newly attached CDP connection. The body locator waits for the DOM.
      const result = await snapshot(activePage, row.sessionId!);
      await patch(tx, row, { url: result.url, title: result.title, activeAt: new Date() });
      if (authorized?.entry && !authorized.entry.receipt && input.action === 'open') {
        // A navigation admission is not a completed start. Record only after
        // actual goto + DOM observation, in this owned physical session. Keep
        // redirects explicit; this receipt never approves a test requirement.
        await guardBrowserOperation(tx, userId, row.workspaceId, threadId, agentId, input, actor, row.sessionId);
        await tx.transaction(async entryTx => {
          await entryTx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${row.workspaceId}`}, 0))`);
          await assertBrowserLock();
          if (!autonomyEnabled()) throw createError({ statusCode: 503, statusMessage: 'Nya autonoma starter är pausade.' });
          const receipt = { version: 1 as const, sessionId: row.sessionId!, requestedUrl: authorized.entry!.url, observedUrl: traceUrl(result.url), observedAt: new Date().toISOString(), callId: authorized.callId };
          // Recheck at the write after any content-lock wait. Do not acquire a
          // mission lock inside the content lock (report commits use the reverse).
          const currentExecution = sql`exists (select 1 from pat_mission_attempts a join pat_missions m on m.id = a.mission_id join pat_mission_tasks t on t.id = a.task_id
            where a.id = ${authorized.execution.attemptId} and a.dispatch_id = ${authorized.execution.dispatchId}
            and a.status in ('dispatching','dispatch_unknown','running') and a.cancel_requested_at is null
            and a.deadline_at > clock_timestamp() and m.deadline_at > clock_timestamp()
            and m.status = 'active' and m.lifecycle in ('accepted','running','waiting') and t.state = 'running'
            and a.mandate_revision = m.mandate_revision and a.plan_revision = m.plan_revision and t.plan_revision = m.plan_revision)`;
          const saved = await entryTx.update(schema.testRuns).set({ browserEntryReceipt: receipt }).where(and(eq(schema.testRuns.id, authorized.entry!.runId), eq(schema.testRuns.missionAttemptId, authorized.execution.attemptId), sql`${schema.testRuns.finishedAt} is null`, sql`${schema.testRuns.browserEntryReceipt} is null`, currentExecution)).returning({ id: schema.testRuns.id });
          if (!saved.length) throw createError({ statusCode: 409, statusMessage: 'Testets startkontext kunde inte sparas på den aktiva körningen.' });
          await assertBrowserLock();
        });
      }
      // A screenshot failure must never turn a completed click into a failed
      // browser action (which might cause the agent to repeat a submission).
      let capture = {};
      try { capture = await record(activePage, 'observed'); }
      catch { capture = { captureWarning: 'Screenshot recording unavailable. Browser action completed; do not repeat it.' }; }
      return { status: "ready", sessionId: row.sessionId, ...result, ...capture, navigation, ...(authorized && failedRequests.length ? { failedRequests } : {}), verificationNote: 'Action completed; this is not a test verdict. Inspect observed behavior and all case checks. An unmet destination, policy-blocked request or missing snapshot control needs investigation, not an automatic defect.' };
    }
    catch (error) {
      // Never leak provider connection URLs/API keys or filled text in errors.
      await patch(tx, row, { activeAt: new Date() });
      const capture = trace && actionPage ? await record(actionPage, 'action_failed').catch(() => ({ captureWarning: 'Handlingsspåret kunde inte sparas. Upprepa inte handlingen enbart därför.' })) : {};
      return { status: "action_failed", phase, reason: error instanceof Error ? error.name : "BrowserError", ...capture, message: "The browser action failed, timed out or was outside the read-only mission scope. Inspect the page before retrying. Authentication and writes require explicit authorization; do not guess credentials." };
    }
    finally { inputPage?.off('popup', observePopup); await popupSession?.detach().catch(() => {}); context?.off('response', observeResponse); context?.off('requestfailed', observeFailure); }
  }, { agentId: returned?.agentId ?? agentId, sessionId: returned?.sessionId ?? input.sessionId });
}

export async function closeIdleBrowsers() {
  const rows = await db.select({ userId: schema.browserAssignments.userId, workspaceId: schema.browserAssignments.workspaceId, threadId: schema.browserAssignments.threadId, agentId: schema.browserAssignments.agentId }).from(schema.browserAssignments).where(and(isNotNull(schema.browserAssignments.sessionId), lt(schema.browserAssignments.activeAt, new Date(Date.now() - IDLE_MS))));
  for (const row of rows) {
    await lockedWorkspace(row.userId, row.workspaceId, row.threadId, row.agentId, async (tx, current) => {
      if (current.sessionId && current.activeAt.getTime() < Date.now() - IDLE_MS) await release(tx, current);
    }).catch(() => {});
  }
}
