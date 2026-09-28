import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { H3Event } from "h3";
import { db, schema } from "@nuxthub/db";
import type { ConnectorStatus } from "../../shared/types/connector";
import { sealCredential, openCredential } from "./oauth-crypto";
import { requireSessionUserId } from "./session";
import { getRequestOrigin } from "./h3-node";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const cookieName = "pat_linear_oauth";
interface Tokens { access_token: string; refresh_token: string; expires_in: number }
function config() {
  const clientId = process.env.LINEAR_CLIENT_ID, clientSecret = process.env.LINEAR_CLIENT_SECRET, redirectUri = process.env.LINEAR_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) throw createError({ statusCode: 503, statusMessage: "Configure LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET and LINEAR_REDIRECT_URI" });
  return { clientId, clientSecret, redirectUri };
}
async function exchange(fields: Record<string, string>): Promise<Tokens> {
  const { clientId, clientSecret } = config();
  const response = await fetch("https://api.linear.app/oauth/token", { method: "POST", body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...fields }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw createError({ statusCode: response.status === 400 || response.status === 401 ? 409 : 502, statusMessage: "Linear authorization failed. Connect Linear again in Settings." });
  const result = await response.json() as Tokens;
  if (!result.access_token || !result.refresh_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw createError({ statusCode: 502, statusMessage: "Invalid Linear token response" });
  return result;
}
export async function startLinearOAuth(event: H3Event, userId: string, returnUrl: string) {
  const { clientId, redirectUri } = config();
  const origin = getRequestOrigin(event);
  if (getHeader(event, "origin") && getHeader(event, "origin") !== origin) throw createError({ statusCode: 403 });
  if (new URL(redirectUri).origin !== origin || new URL(returnUrl).origin !== origin) throw createError({ statusCode: 503, statusMessage: "LINEAR_REDIRECT_URI must match this app's origin" });
  const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
  await db.delete(schema.linearOauthStates).where(lt(schema.linearOauthStates.expiresAt, new Date()));
  await db.insert(schema.linearOauthStates).values({ id: digest(state), userId, verifier: sealCredential(verifier, userId), redirectUri, returnUrl, expiresAt: new Date(Date.now() + 600000) });
  setCookie(event, cookieName, state, { httpOnly: true, secure: origin.startsWith("https:"), sameSite: "lax", path: "/api/integrations/linear/callback", maxAge: 600 });
  const url = new URL("https://linear.app/oauth/authorize");
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "read,write", actor: "user", prompt: "consent", state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
  return { url: url.toString() };
}
export async function completeLinearOAuth(event: H3Event) {
  const userId = await requireSessionUserId(event), query = getQuery(event);
  if (typeof query.state !== "string" || query.state !== getCookie(event, cookieName)) throw createError({ statusCode: 400, statusMessage: "Invalid or expired Linear authorization. Try connecting again." });
  const [state] = await db.delete(schema.linearOauthStates).where(and(eq(schema.linearOauthStates.id, digest(query.state)), eq(schema.linearOauthStates.userId, userId), gt(schema.linearOauthStates.expiresAt, new Date()))).returning();
  deleteCookie(event, cookieName, { path: "/api/integrations/linear/callback" });
  if (!state) throw createError({ statusCode: 400, statusMessage: "Linear authorization already used or expired" });
  if (query.error || typeof query.code !== "string") return sendRedirect(event, "/settings/integrations?linear=cancelled");
  const tokens = await exchange({ grant_type: "authorization_code", code: query.code, redirect_uri: state.redirectUri, code_verifier: openCredential(state.verifier, userId) });
  const response = await fetch("https://api.linear.app/graphql", { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: "{ viewer { name } organization { name } }" }), signal: AbortSignal.timeout(15000) });
  const identity = await response.json() as { data?: { viewer: { name: string }; organization: { name: string } }; errors?: unknown[] };
  if (!response.ok || identity.errors || !identity.data) throw createError({ statusCode: 502, statusMessage: "Could not verify Linear account" });
  const values = { credentials: sealCredential(JSON.stringify(tokens), userId), label: `${identity.data.viewer.name} · ${identity.data.organization.name}`, expiresAt: new Date(Date.now() + tokens.expires_in * 1000) };
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`linear:${userId}`}, 0))`);
    await tx.insert(schema.linearAccounts).values({ userId, ...values }).onConflictDoUpdate({ target: schema.linearAccounts.userId, set: values });
  });
  return sendRedirect(event, state.returnUrl);
}
export async function linearToken(userId: string): Promise<string> {
  return db.transaction(async tx => {
    // Serialize rotating refresh tokens across all server instances/environments.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`linear:${userId}`}, 0))`);
    const [account] = await tx.select().from(schema.linearAccounts).where(eq(schema.linearAccounts.userId, userId));
    if (!account) throw createError({ statusCode: 409, statusMessage: "Connect Linear in Settings > Integrations" });
    let tokens = JSON.parse(openCredential(account.credentials, userId)) as Tokens;
    if (account.expiresAt.getTime() <= Date.now() + 60000) {
      tokens = await exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
      await tx.update(schema.linearAccounts).set({ credentials: sealCredential(JSON.stringify(tokens), userId), expiresAt: new Date(Date.now() + tokens.expires_in * 1000) }).where(eq(schema.linearAccounts.userId, userId));
    }
    return tokens.access_token;
  });
}
export async function linearStatus(userId: string): Promise<ConnectorStatus> {
  try { config(); } catch { return { state: "setup_required", message: "Configure Linear OAuth credentials on this server.", hint: "Set LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET and LINEAR_REDIRECT_URI." }; }
  try {
    const [account] = await db.select({ label: schema.linearAccounts.label }).from(schema.linearAccounts).where(eq(schema.linearAccounts.userId, userId));
    if (!account) return { state: "not_connected" };
    await linearToken(userId);
    return { state: "connected", label: account.label };
  } catch { return { state: "error", message: "Could not refresh Linear access. Try again or reconnect Linear." }; }
}
export async function revokeLinear(userId: string) {
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`linear:${userId}`}, 0))`);
    const [account] = await tx.select().from(schema.linearAccounts).where(eq(schema.linearAccounts.userId, userId));
    if (account) {
      const tokens = JSON.parse(openCredential(account.credentials, userId)) as Tokens;
      const response = await fetch("https://api.linear.app/oauth/revoke", { method: "POST", body: new URLSearchParams({ token: tokens.refresh_token, token_type_hint: "refresh_token" }), signal: AbortSignal.timeout(15000) });
      if (!response.ok && ![400, 401].includes(response.status)) throw createError({ statusCode: 502, statusMessage: "Linear disconnect failed. Try again." });
      await tx.delete(schema.linearAccounts).where(eq(schema.linearAccounts.userId, userId));
    }
    await tx.delete(schema.linearOauthStates).where(eq(schema.linearOauthStates.userId, userId));
  });
}
