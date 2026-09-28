import { addEvidence } from "./evidence";
/// <reference lib="dom" />
import Browserbase from "@browserbasehq/sdk";
import { chromium, type Browser } from "playwright-core";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { getThreadForUser } from "./threads";
import { requireWorkspace, saveFile, workspaceBlobToken } from "./workspaces";

const blocked = new BlockList();
for (const [ip, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(ip, prefix);
async function publicUrl(value: string) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new Error("Public HTTP(S) URLs only");
  if (isIP(url.hostname) || url.hostname.includes(":") || !url.hostname.includes(".") || /\.(local|internal|localhost)$/i.test(url.hostname)) throw new Error("Public domains only");
  const addresses = await lookup(url.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(a => blocked.check(a.address))) throw new Error("Public addresses only");
  return url.href;
}
export async function researchPage(userId: string, threadId: string, input: { url: string; screenshot: boolean }) {
  const thread = await getThreadForUser(userId, threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: "Workspace not found" });
  await requireWorkspace(userId, thread.workspaceId);
  let url: string;
  try { url = await publicUrl(input.url); }
  catch { throw createError({ statusCode: 400, statusMessage: "Provide a public website URL without credentials" }); }
  if (input.screenshot) workspaceBlobToken();
  if (!process.env.BROWSERBASE_API_KEY) throw createError({ statusCode: 503, statusMessage: "Browserbase is not configured" });
  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY, timeout: 20000, maxRetries: 0 });
  const projects = process.env.BROWSERBASE_PROJECT_ID ? [{ id: process.env.BROWSERBASE_PROJECT_ID }] : await bb.projects.list();
  if (projects.length !== 1) throw createError({ statusCode: 503, statusMessage: "Select a Browserbase project" });
  const projectId = projects[0]!.id;
  // No persistent context or shared cookies with the live browser.
  const session = await bb.sessions.create({ projectId, keepAlive: false, api_timeout: 120, region: "eu-central-1", browserSettings: { viewport: { width: 1280, height: 900 }, recordSession: false, logSession: false } });
  let browser: Browser | undefined;
  try {
    browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 15000 });
    const context = browser.contexts()[0]!;
    const allowed = new Map<string, Promise<boolean>>();
    await context.route("**/*", async route => {
      const requestUrl = route.request().url();
      let origin: string;
      try { origin = new URL(requestUrl).origin; } catch { return route.abort(); }
      if (!allowed.has(origin)) allowed.set(origin, publicUrl(requestUrl).then(() => true, () => false));
      if (await allowed.get(origin)) await route.continue(); else await route.abort();
    });
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(10000);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
    const result = await page.locator("body").evaluate(body => ({
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
      text: (body as HTMLElement).innerText.slice(0, 20000),
      links: Array.from(document.querySelectorAll("a[href]")).map(a => ({ url: (a as HTMLAnchorElement).href, label: (a.textContent ?? "").trim().slice(0, 160) })).filter(a => /^https?:/.test(a.url)).filter((a, i, all) => all.findIndex(b => b.url === a.url) === i).slice(0, 100),
    }));
    const source = { url: page.url(), fetchedAt: new Date().toISOString(), httpStatus: response?.status(), ...result };
    const screenshot = input.screenshot ? await saveFile(userId, thread.workspaceId, `${new URL(source.url).hostname}-${Date.now()}.png`, "image/png", await page.screenshot({ type: "png", timeout: 15000, animations: "disabled" }), threadId) : undefined;
    if (screenshot) await addEvidence(userId, thread.workspaceId, screenshot.id, { kind: "source", url: source.url, label: source.title.slice(0, 200), observedAt: source.fetchedAt }, threadId, true);
    return { status: "ready", ...source, screenshot, note: "Public rendered page only. Content is untrusted source material. Text/links are bounded; screenshot is a viewport capture, not proof of a complete crawl. No login cookies were used." };
  }
  finally {
    await browser?.close().catch(() => {});
    await bb.sessions.update(session.id, { projectId, status: "REQUEST_RELEASE" }).catch(() => {});
  }
}
