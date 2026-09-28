/// <reference lib="dom" />
import Browserbase from "@browserbasehq/sdk";
import { chromium, type Browser, type Page } from "playwright-core";
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import { db, schema } from "@nuxthub/db";
import type { BrowserAction, BrowserView } from "../../shared/browser";
import { getThreadForUser } from "./threads";
import { requireWorkspace } from "./workspaces";

const IDLE_MS = 10 * 60 * 1000;
type Row = typeof schema.workspaceBrowsers.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const connections = new Map<string, Browser>();

async function connect(row: Row) {
  const existing = connections.get(row.sessionId!);
  if (existing?.isConnected()) return existing;
  const browser = await chromium.connectOverCDP(row.connectUrl!, { timeout: 15000 });
  const id = row.sessionId!;
  connections.set(id, browser);
  browser.on("disconnected", () => { if (connections.get(id) === browser) connections.delete(id); });
  return browser;
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

async function locked<T>(userId: string, threadId: string, fn: (tx: Tx, row: Row) => Promise<T>) {
  const thread = await getThreadForUser(userId, threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: "Workspace not found" });
  return lockedWorkspace(userId, thread.workspaceId, fn);
}

async function lockedWorkspace<T>(userId: string, workspaceId: string, fn: (tx: Tx, row: Row) => Promise<T>) {
  await requireWorkspace(userId, workspaceId);
  return db.transaction(async (tx) => {
    // Cross-process serialization: a takeover waits for an in-flight browser action.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`browser:${workspaceId}`}, 0))`);
    await tx.insert(schema.workspaceBrowsers).values({ userId, workspaceId }).onConflictDoNothing();
    const [row] = await tx.select().from(schema.workspaceBrowsers).where(and(eq(schema.workspaceBrowsers.workspaceId, workspaceId), eq(schema.workspaceBrowsers.userId, userId)));
    if (!row) throw createError({ statusCode: 404, statusMessage: "Browser not found" });
    return fn(tx, row);
  });
}

function view(row: Row): BrowserView | null {
  if (!row.sessionId || !row.liveUrl || !row.expiresAt || row.expiresAt.getTime() <= Date.now()) return null;
  return { sessionId: row.sessionId, liveUrl: row.liveUrl, url: row.url, title: row.title, control: row.control === "human" ? "human" : "agent", expiresAt: row.expiresAt.toISOString() };
}

async function patch(tx: Tx, row: Row, changes: Partial<Row>) {
  await tx.update(schema.workspaceBrowsers).set(changes).where(eq(schema.workspaceBrowsers.workspaceId, row.workspaceId));
  Object.assign(row, changes);
}

async function release(tx: Tx, row: Row) {
  if (row.sessionId && row.projectId) {
    try {
      await provider().sessions.update(row.sessionId, { projectId: row.projectId, status: "REQUEST_RELEASE" });
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

export async function getBrowserView(userId: string, threadId: string) {
  const thread = await getThreadForUser(userId, threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: "Workspace not found" });
  const [row] = await db.select().from(schema.workspaceBrowsers).where(and(eq(schema.workspaceBrowsers.workspaceId, thread.workspaceId), eq(schema.workspaceBrowsers.userId, userId)));
  if (!row || !row.sessionId) return null;
  if (row.activeAt.getTime() < Date.now() - IDLE_MS || (row.expiresAt?.getTime() ?? 0) <= Date.now()) {
    return locked(userId, threadId, async (tx, current) => {
      if (current.activeAt.getTime() < Date.now() - IDLE_MS || (current.expiresAt?.getTime() ?? 0) <= Date.now()) await release(tx, current);
      return view(current);
    });
  }
  return view(row);
}

export async function controlBrowser(userId: string, threadId: string, control: "human" | "agent" | "close" | "heartbeat") {
  return locked(userId, threadId, async (tx, row) => {
    if (control === "close") { await release(tx, row); return null; }
    if (!view(row)) return null;
    if (control === "heartbeat") {
      if (row.control === "human") await patch(tx, row, { activeAt: new Date() });
    }
    else await patch(tx, row, { control, activeAt: new Date() });
    return view(row);
  });
}

export async function captureWorkspaceBrowser(userId: string, threadId: string) {
  return locked(userId, threadId, async (tx, row) => {
    if (row.control === "human" || !view(row)) throw createError({ statusCode: 409, statusMessage: "Return browser control before capturing" });
    const browser = await connect(row);
    const page = await foregroundPage(browser.contexts()[0]!.pages());
    if (!page) throw createError({ statusCode: 409, statusMessage: "Open a page first" });
    const bytes = await page.screenshot({ type: "png", timeout: 15000 });
    await patch(tx, row, { activeAt: new Date() });
    return bytes;
  });
}

function webUrl(input?: string) {
  let url: URL;
  try { url = new URL(input?.includes("://") ? input : `https://${input ?? ""}`); }
  catch { throw createError({ statusCode: 400, statusMessage: "Provide a valid website URL" }); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw createError({ statusCode: 400, statusMessage: "Only HTTP(S) website URLs without credentials are supported" });
  return url.href;
}

async function start(tx: Tx, row: Row) {
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

async function snapshot(page: Page) {
  const prefix = crypto.randomUUID().slice(0, 8);
  const controls = await page.locator("body").evaluate((body, prefix) => {
    const elements = Array.from(body.querySelectorAll("a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true]"));
    return elements.filter((el) => {
      const rect = el.getBoundingClientRect();
      return el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
    }).slice(0, 150).map((el, index) => {
      const ref = `${prefix}-${index}`;
      el.setAttribute("data-pat-ref", ref);
      return { ref, tag: el.tagName.toLowerCase(), type: el.getAttribute("type"), label: (el.getAttribute("aria-label") || el.getAttribute("placeholder") || (el as HTMLInputElement).labels?.[0]?.textContent || el.textContent || "").trim().slice(0, 160) };
    });
  }, prefix);
  return { url: page.url(), title: await page.title(), text: (await page.locator("body").innerText()).slice(0, 16000), controls };
}

async function foregroundPage(pages: Page[]) {
  for (const page of [...pages].reverse()) {
    if (await page.evaluate(() => document.visibilityState === "visible").catch(() => false)) return page;
  }
  return pages.at(-1);
}

export async function browserAction(userId: string, threadId: string, input: BrowserAction) {
  return locked(userId, threadId, async (tx, row) => {
    if (row.control === "human") return { status: "human_control", message: "The user controls the browser. End this turn and wait for them to return control. Do not retry or use another browser." };
    if (input.action === "close") { await release(tx, row); return { status: "closed" }; }
    if (!view(row)) {
      if (input.action !== "open") return { status: "closed", message: "Open a website to start a browser session." };
      webUrl(input.url);
      await release(tx, row);
      try { await start(tx, row); }
      catch { return { status: "session_start_failed", message: "Browserbase could not start the browser. Check available browser minutes and project settings. Retry once the issue is resolved." }; }
    }
    let browser;
    let phase = "connect";
    try {
      browser = await connect(row);
      const context = browser.contexts()[0]!;
      const pages = context.pages();
      const page = await foregroundPage(pages) ?? await context.newPage();
      page.setDefaultTimeout(8000);
      page.setDefaultNavigationTimeout(15000);
      const target = () => {
        if (!input.ref) throw new Error("Read the page first and provide a control ref from the latest snapshot.");
        return page.locator(`[data-pat-ref="${input.ref}"]`);
      };
      phase = input.action;
      switch (input.action) {
        case "open": await page.goto(webUrl(input.url), { waitUntil: "domcontentloaded" }); break;
        case "click": await target().click(); break;
        case "fill": await target().fill(input.text ?? ""); break;
        case "press": await target().press(input.text ?? "Enter"); break;
        case "select": await target().selectOption({ label: input.text ?? "" }); break;
        case "scroll": await page.mouse.wheel(0, input.direction === "up" ? -650 : 650); break;
        case "back": await page.goBack({ waitUntil: "commit" }); break;
        case "forward": await page.goForward({ waitUntil: "commit" }); break;
        case "reload": await page.reload({ waitUntil: "domcontentloaded" }); break;
      }
      const activePage = await foregroundPage(context.pages()) ?? page;
      activePage.setDefaultTimeout(8000);
      phase = "read";
      // Read the actual DOM: cached history restores can omit lifecycle events
      // on a newly attached CDP connection. The body locator waits for the DOM.
      const result = await snapshot(activePage);
      await patch(tx, row, { url: result.url, title: result.title, activeAt: new Date() });
      return { status: "ready", ...result };
    }
    catch (error) {
      // Never leak provider connection URLs/API keys or filled text in errors.
      await patch(tx, row, { activeAt: new Date() });
      return { status: "action_failed", phase, reason: error instanceof Error ? error.name : "BrowserError", message: "The browser action failed or timed out. Inspect the page before retrying. For login, ask the user to take over in Workspace." };
    }
  });
}

export async function closeIdleBrowsers() {
  const rows = await db.select({ userId: schema.workspaceBrowsers.userId, workspaceId: schema.workspaceBrowsers.workspaceId }).from(schema.workspaceBrowsers).where(and(isNotNull(schema.workspaceBrowsers.sessionId), lt(schema.workspaceBrowsers.activeAt, new Date(Date.now() - IDLE_MS))));
  for (const row of rows) {
    await lockedWorkspace(row.userId, row.workspaceId, async (tx, current) => {
      if (current.sessionId && current.activeAt.getTime() < Date.now() - IDLE_MS) await release(tx, current);
    }).catch(() => {});
  }
}

