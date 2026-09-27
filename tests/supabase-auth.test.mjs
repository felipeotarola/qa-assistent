import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequestSupabase } from "../shared/supabase.ts";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.SUPABASE_URL;
const originalKey = process.env.SUPABASE_PUBLISHABLE_KEY;
process.env.SUPABASE_URL = "https://auth.example.test";
process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
after(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
  else process.env.SUPABASE_PUBLISHABLE_KEY = originalKey;
});

function sessionCookie() {
  const session = {
    access_token: "untrusted-access-token",
    refresh_token: "test-refresh-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: "forged-cookie-user", email: "forged@example.test" },
  };
  return `pat_supabase_auth=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

test("anonymous requests have no authenticated user", async () => {
  globalThis.fetch = () => { throw new Error("Anonymous requests should not call Auth"); };
  const { data } = await createRequestSupabase("").auth.getUser();
  assert.equal(data.user, null);
});

test("rejects cookie identity when Supabase rejects the token", async () => {
  globalThis.fetch = async () => Response.json({ message: "Invalid JWT" }, { status: 401 });
  const { data, error } = await createRequestSupabase(sessionCookie()).auth.getUser();
  assert.equal(data.user, null);
  assert.ok(error);
});

test("uses the verified Supabase identity instead of cookie user data", async () => {
  globalThis.fetch = async (url) => {
    assert.ok(String(url).endsWith("/auth/v1/user"));
    return Response.json({ id: "verified-user", email: "verified@example.test", user_metadata: {} });
  };
  const { data, error } = await createRequestSupabase(sessionCookie()).auth.getUser();
  assert.equal(error, null);
  assert.equal(data.user.id, "verified-user");
});
