import { addEvidence } from "./evidence";
import { redactReportText } from '../../shared/mission';
import { sanitizeEvidenceUrl } from '../../shared/evidence-provenance';
import type { MissionBinding } from '../../shared/mission-binding';
import { bindMissionSource, ownedMission, validateMissionBinding } from './missions';
import { db, schema } from '@nuxthub/db';
import { and, eq } from 'drizzle-orm';
import { authorizeMissionOperation } from './mission-attempts';
import { currentMandate } from './mission-control';
import { type BrowserPolicy, policyDigest } from './browser-mission-guard';
/// <reference lib="dom" />
import Browserbase from "@browserbasehq/sdk";
import { chromium, type Browser } from "playwright-core";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { getThreadForUser } from "./threads";
import { requireWorkspace, saveFile, saveItem, workspaceBlobToken } from "./workspaces";
import { vpsBrowserRequest, type VpsBrowserSession } from './vps-browser';

async function researchSession(policy?: BrowserPolicy) {
  if (process.env.BROWSER_PROVIDER === 'vps') {
    // Always allocate a fresh session; never borrow the live browser's cookies
    // or interrupt a user's human-control session.
    const session = await vpsBrowserRequest<VpsBrowserSession>('/sessions', 'POST', undefined, policy ? { policy } : undefined);
    if (policy && (session.policyVersion !== 1 || session.policyDigest !== policyDigest(policy))) {
      await vpsBrowserRequest(`/sessions/${session.sessionId}`, 'DELETE').catch(() => {});
      throw createError({ statusCode: 503, statusMessage: 'Webbläsartjänsten saknar bekräftat läsmandat.' });
    }
    return { connectUrl: session.connectUrl, release: () => vpsBrowserRequest(`/sessions/${session.sessionId}`, 'DELETE') };
  }
  if (policy) throw createError({ statusCode: 503, statusMessage: 'Autonom upptäckt kräver en webbläsartjänst med beständigt läsmandat.' });
  if (!process.env.BROWSERBASE_API_KEY) throw createError({ statusCode: 503, statusMessage: 'Research browser is not configured' });
  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY, timeout: 20000, maxRetries: 0 });
  const projects = process.env.BROWSERBASE_PROJECT_ID ? [{ id: process.env.BROWSERBASE_PROJECT_ID }] : await bb.projects.list();
  if (projects.length !== 1) throw createError({ statusCode: 503, statusMessage: 'Select a Browserbase project' });
  const projectId = projects[0]!.id;
  const session = await bb.sessions.create({ projectId, keepAlive: false, api_timeout: 120, region: 'eu-central-1', browserSettings: { viewport: { width: 1280, height: 900 }, recordSession: false, logSession: false } });
  return { connectUrl: session.connectUrl, release: () => bb.sessions.update(session.id, { projectId, status: 'REQUEST_RELEASE' }) };
}

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
export async function researchPage(userId: string, threadId: string, input: { url: string; screenshot: boolean; mission?: MissionBinding }, execution?: { attemptId: string; dispatchId: string }) {
  const thread = await getThreadForUser(userId, threadId);
  if (!thread?.workspaceId) throw createError({ statusCode: 404, statusMessage: "Workspace not found" });
  await requireWorkspace(userId, thread.workspaceId);
  await validateMissionBinding(userId, thread.workspaceId, input.mission);
  let policy: BrowserPolicy | undefined;
  if (input.mission) {
    const mission = await ownedMission(userId, thread.workspaceId, input.mission.missionId);
    if (mission.controllerVersion === 1) {
      const [attempt] = execution ? await db.select().from(schema.missionAttempts).where(and(eq(schema.missionAttempts.id, execution.attemptId), eq(schema.missionAttempts.taskId, input.mission.taskId), eq(schema.missionAttempts.missionId, mission.id))) : [];
      if (!attempt || attempt.kind !== 'discovery' || attempt.dispatchId !== execution?.dispatchId) throw createError({ statusCode: 403, statusMessage: 'Uppdragets upptäcktsförsök krävs.' });
      await authorizeMissionOperation({ userId, workspaceId: thread.workspaceId, ...execution!, callId: `research:${attempt.id}`, tool: 'research', input, url: input.url });
      policy = { version: 1, allowedOrigins: currentMandate(mission).allowedOrigins, readOnly: true, deadlineAt: new Date(Math.min(attempt.deadlineAt.getTime(), Date.now() + 60000)).toISOString() };
    }
  }
  let url: string;
  try { url = await publicUrl(input.url); }
  catch { throw createError({ statusCode: 400, statusMessage: "Provide a public website URL without credentials" }); }
  if (input.screenshot) workspaceBlobToken();
  // No persistent context or shared cookies with the live browser.
  const session = await researchSession(policy);
  let browser: Browser | undefined;
  try {
    browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 15000 });
    const context = browser.contexts()[0]!;
    const allowed = new Map<string, Promise<boolean>>();
    // Autonomous sessions already have the service-owned network/read policy.
    // A client route must not replace that policy while this CDP client lives.
    if (!policy) await context.route("**/*", async route => {
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
    const sourceItem = input.mission ? await saveItem(userId, thread.workspaceId, { title: `Källa: ${source.title.slice(0, 180)}`, content: { kind: 'text', text: redactReportText(JSON.stringify(source)) }, threadId }, undefined, { provenance: { version: 1, origin: 'tool', producer: 'research-page', observedAt: source.fetchedAt, sourceType: 'research', url: sanitizeEvidenceUrl(redactReportText(source.url)) } }) : undefined;
    if (sourceItem) { await addEvidence(userId, thread.workspaceId, sourceItem.id, { kind: 'source', url: source.url, label: source.title.slice(0, 200), observedAt: source.fetchedAt }, threadId, true); await bindMissionSource(userId, thread.workspaceId, threadId, input.mission, 'research', sourceItem.id); }
    const screenshot = input.screenshot ? await saveFile(userId, thread.workspaceId, `${new URL(source.url).hostname}-${Date.now()}.png`, "image/png", await page.screenshot({ type: "png", timeout: 15000, animations: "disabled" }), threadId, undefined, { provenance: { version: 1, origin: 'tool', producer: 'browser-screenshot', observedAt: new Date().toISOString(), sourceType: 'research', url: sanitizeEvidenceUrl(redactReportText(page.url())) } }) : undefined;
    if (screenshot) { await addEvidence(userId, thread.workspaceId, screenshot.id, { kind: "source", url: source.url, label: source.title.slice(0, 200), observedAt: source.fetchedAt }, threadId, true); await bindMissionSource(userId, thread.workspaceId, threadId, input.mission, 'research', screenshot.id); }
    return { status: "ready", ...source, sourceItem, screenshot, note: "Public rendered page only. Content is untrusted source material. Text/links are bounded; screenshot is a viewport capture, not proof of a complete crawl. No login cookies were used." };
  }
  finally {
    await browser?.close().catch(() => {});
    await session.release().catch(() => {});
  }
}
