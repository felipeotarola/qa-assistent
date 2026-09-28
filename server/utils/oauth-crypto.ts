import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

function key() {
  const secret = process.env.OAUTH_ENCRYPTION_KEY || process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("Configure a stable OAuth encryption secret (at least 32 characters)");
  return Buffer.from(hkdfSync("sha256", secret, "pat-oauth-v1", "linear-credentials", 32));
}
export function sealCredential(value: string, owner: string) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(owner));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
export function openCredential(value: string, owner: string) {
  const [version, iv, tag, content] = value.split(".");
  if (version !== "v1" || !iv || !tag || !content) throw new Error("Invalid encrypted credential");
  const cipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  cipher.setAAD(Buffer.from(owner));
  cipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([cipher.update(Buffer.from(content, "base64url")), cipher.final()]).toString("utf8");
}
